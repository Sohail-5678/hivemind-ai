// Pure helpers for rooms in the static runtime: config sanitizing, the inputs a
// team run needs from the timeline, and late-joiner snapshots sized for public
// relays. No React and no DOM, so the room core and the Node checks share them.
import { PATTERNS, PATTERN_ORDER, TURN_TAKING, clampConfig } from '@shared/swarm/patterns.js'
import { compactSwarmView } from '@shared/swarm/view.js'
import { utf8Length } from '../lib/relay.js'

export const SNAPSHOT_BUDGET_BYTES = 90_000 // JSON before encryption; the relay splits it into packets
export const SNAPSHOT_MAX_EVENTS = 120
const HISTORY_EVENTS = 6
const HISTORY_CHARS = 600
const CONTINUE_PREFIX = 'Continue the previous goal: '

// One list of injection patterns for both runtimes (server/swarm/guard.js), so
// the Monitor treats a flagged message the same way everywhere.
export { flagInjection } from '@shared/swarm/guard.js'

// Every way config enters a runtime goes through here (contract §1). A missing
// or pre-v2 config means one agent.
export function sanitizeConfig(raw, provider = 'simulated') {
  const src = raw && typeof raw === 'object' ? raw : {}
  const crew = src.crew === 'team' ? 'team' : 'single'
  const pattern = PATTERN_ORDER.includes(src.pattern) ? src.pattern : 'auto'
  return { crew, pattern, ...clampConfig(pattern, provider, src) }
}

// A change on top of the current config. Knobs are sized per architecture
// (a Sequential budget would starve a Hierarchical team), so switching the
// pattern resets every knob the change doesn't set itself.
export function mergeConfig(current, patch, provider = 'simulated') {
  const base = current && typeof current === 'object' ? current : {}
  const next = patch && typeof patch === 'object' ? patch : {}
  const switching = next.pattern !== undefined && next.pattern !== base.pattern
  return sanitizeConfig(switching ? { crew: base.crew, ...next } : { ...base, ...next }, provider)
}

export function sameConfig(a, b) {
  const keys = ['crew', 'pattern', 'turnTaking', 'maxCalls', 'width', 'rounds', 'fanInMs']
  return keys.every((k) => (a || {})[k] === (b || {})[k])
}

// Timeline line for a `config` event, e.g. "Switched to Peer-to-peer team with
// moderator turn-taking". Patterns without turns keep the short form.
export function configLabel(config) {
  if (config?.crew !== 'team') return 'Switched to a single agent'
  const turn = TURN_TAKING[config.turnTaking]
  return `Switched to ${PATTERNS[config.pattern]?.name || 'Auto'} team${turn ? ` with ${turn.name.toLowerCase()} turn-taking` : ''}`
}

export function patternName(pattern) {
  return PATTERNS[pattern]?.name || 'Auto'
}

// Watchdog per contract §4: generous per call for the slow free tier, tight
// for the scripted brain, plus a minute for votes and escalations.
export function perCallSeconds(provider) {
  return provider === 'free' ? 50 : provider === 'simulated' ? 12 : 25
}

export function runWatchdogMs(config, provider) {
  return (Number(config?.maxCalls) || 16) * perCallSeconds(provider) * 1000 + 60_000
}

// "Continue the previous goal: X", never nested after repeated pause/resume.
export function continueGoal(goal) {
  let base = String(goal || '').trim()
  while (base.startsWith(CONTINUE_PREFIX)) base = base.slice(CONTINUE_PREFIX.length).trim()
  return base ? `${CONTINUE_PREFIX}${base}` : ''
}

export function latestUserMessage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'user_message' && events[i].content) return events[i]
  }
  return null
}

// The conversation before a run, minus the message that became its goal: human
// messages plus the answers the room actually got (single-agent replies and
// team finals). A team's intermediate steps would crowd the slots out. Same
// rule as the server (agent.js teamHistory).
export function teamHistory(events, { excludeId = null } = {}) {
  return events
    .filter((e) => e?.content && e.id !== excludeId && (e.type === 'user_message' || (e.type === 'agent_message' && (e.author?.id === 'agent' || e.meta?.final))))
    .slice(-HISTORY_EVENTS)
    .map((e) => ({ author: e.author ? { id: e.author.id, name: e.author.name } : null, content: String(e.content).slice(0, HISTORY_CHARS) }))
}

// Human input that arrived while the run was live (engine `directives()`).
export function teamDirectives(events, startIndex) {
  const out = []
  for (let i = Math.max(0, startIndex); i < events.length; i++) {
    const e = events[i]
    if ((e?.type === 'user_message' || e?.type === 'redirect') && e.content) {
      out.push({ id: e.id, content: e.content, author: e.author || null, flagged: Boolean(e.meta?.flagged) })
    }
  }
  return out
}

// Messages sent during the run that no agent prompt included: the follow-up goal.
export function unseenMessages(events, startIndex, seenIds) {
  return events.slice(Math.max(0, startIndex)).filter((e) => e?.type === 'user_message' && e.content && !seenIds?.has?.(e.id))
}

// Union of a stored timeline and a newer mirrored window, stored order first.
// A takeover in the creator's browser must not overwrite the full history
// with the shorter window that arrived in a snapshot.
export function mergeEvents(stored, mirrored) {
  if (!Array.isArray(stored) || !stored.length) return mirrored || []
  const ids = new Set(stored.map((e) => e.id))
  const extra = (mirrored || []).filter((e) => !ids.has(e.id))
  return extra.length ? [...stored, ...extra] : stored
}

const bytesOf = (value) => utf8Length(JSON.stringify(value))

// Late-joiner snapshot: the room state plus the newest timeline events that
// fit the budget (never more than SNAPSHOT_MAX_EVENTS). Older history stays
// with the host; a gap is better than a frame the relays drop.
export function buildSnapshot({ to, session, events = [], participants = [], agentStatus, streaming = null, swarm = null, blackboard = null }, { budget = SNAPSHOT_BUDGET_BYTES, maxEvents = SNAPSHOT_MAX_EVENTS } = {}) {
  const snap = { t: 'snapshot', to, session, participants, agentStatus, streaming, swarm: compactSwarmView(swarm), blackboard, events: [] }
  let size = bytesOf(snap)
  if (size > budget * 0.6) {
    // Live streams are the only bulk in the view; trim them harder before history.
    snap.swarm = compactSwarmView(swarm, { streamChars: 120 })
    if (streaming?.text && streaming.text.length > 2000) snap.streaming = { ...streaming, text: streaming.text.slice(-2000) }
    size = bytesOf(snap)
  }
  const picked = []
  for (let i = events.length - 1; i >= 0 && picked.length < maxEvents; i--) {
    const n = bytesOf(events[i]) + 1
    if (size + n > budget) break
    size += n
    picked.push(events[i])
  }
  snap.events = picked.reverse()
  return snap
}
