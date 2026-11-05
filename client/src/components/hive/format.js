// Small, pure helpers shared by the Hive components: plain-word labels for engine
// states, durations, estimates and defensive readers for a view that can be
// null, partial, or from an older run.
import { PATTERNS, PATTERN_ORDER, PROVIDER_PROFILE, TURN_TAKING, clampConfig, estimateCalls, estimateSeconds, turnTakingFor } from '@shared/swarm/patterns.js'
import { ROLES } from '@shared/swarm/roles.js'

// Graph node states (engine.js nodeStatus + view.js swarm_done) and the
// client-only 'planned' state for the preview before a run.
export const NODE_STATUS = {
  queued: 'Waiting',
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  canceled: 'Stopped',
  skipped: 'Not needed',
  unused: 'Not used',
  planned: 'Planned',
}

export const OUTCOME = {
  completed: 'Completed',
  budget: 'Wrapped up at the budget',
  paused: 'Paused',
  stopped: 'Stopped',
  redirected: 'Redirected',
  timeout: 'Timed out',
  lost: 'Cut off before it finished',
  error: 'Stopped by an error',
}

export const LIVE_AGENT = new Set(['speaking', 'thinking'])
export const FADED_NODE = new Set(['canceled', 'skipped', 'unused'])

// Unicode role glyphs are typographic; the variation selector keeps platforms
// from swapping in colour emoji for the few that have an emoji form.
export function glyph(g) {
  return `${String(g || '•')}︎`
}

export function patternId(config) {
  return PATTERNS[config?.pattern] ? config.pattern : 'auto'
}

export function patternName(id) {
  return PATTERNS[id]?.name || 'Agent team'
}

export function providerLabel(provider) {
  return (PROVIDER_PROFILE[provider] || PROVIDER_PROFILE.simulated).label
}

export function roleName(role) {
  return ROLES[role]?.name || ''
}

// Last `n` characters of a live stream, cut at a word boundary.
export function tail(text, n = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= n) return s
  const cut = s.slice(-n)
  const space = cut.indexOf(' ')
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`
}

export function clip(text, n) {
  const s = String(text || '').trim()
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s
}

// 0:07, 1:24, 12:03
export function clock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// "about 20 s", "about 2 min"
export function aboutSeconds(sec) {
  const s = Math.max(1, Math.round(Number(sec) || 0))
  if (s < 90) return `about ${s} s`
  return `about ${Math.round(s / 60)} min`
}

export function seconds(ms) {
  return Math.max(0, Math.ceil((Number(ms) || 0) / 1000))
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

// Calls and time for a pattern on a provider. Auto adds the Architect's call to
// whatever it picks, so it shows a range instead of a single number.
export function estimateFor(pattern, provider, config) {
  const prov = PROVIDER_PROFILE[provider] ? provider : 'simulated'
  if (pattern !== 'auto') {
    const cfg = clampConfig(pattern, prov, config || {})
    return { calls: estimateCalls(pattern, cfg), seconds: estimateSeconds(pattern, prov, cfg), range: null }
  }
  const rows = PATTERN_ORDER.filter((p) => p !== 'auto').map((p) => {
    const cfg = clampConfig(p, prov, {})
    return { calls: estimateCalls(p, cfg) + 1, seconds: estimateSeconds(p, prov, cfg) + PROVIDER_PROFILE[prov].secondsPerCall }
  })
  const lo = rows.reduce((a, r) => (r.calls < a.calls ? r : a))
  const hi = rows.reduce((a, r) => (r.calls > a.calls ? r : a))
  return { calls: hi.calls, seconds: hi.seconds, range: { lo: lo.calls, hi: hi.calls, loSeconds: lo.seconds, hiSeconds: hi.seconds } }
}

function aboutRange(a, b) {
  const lo = Math.max(1, Math.round(a))
  const hi = Math.max(lo, Math.round(b))
  if (hi < 90) return `about ${lo} to ${hi} s`
  if (lo < 90) return `about ${lo} s to ${Math.round(hi / 60)} min`
  return `about ${Math.round(lo / 60)} to ${Math.round(hi / 60)} min`
}

export function estimateText(est) {
  if (!est) return ''
  if (est.range) return `${est.range.lo} to ${est.range.hi} calls, ${aboutRange(est.range.loSeconds, est.range.hiSeconds)}`
  return `${plural(est.calls, 'call')}, ${aboutSeconds(est.seconds)}`
}

// Turn-taking ------------------------------------------------------------
// How the floor was given on a turn (engine.js emitTurn `by`).
export const TURN_RULE = {
  bids: 'highest bid',
  order: 'in order',
  moderator: 'Moderator',
  handoff: 'handoff',
  self: 'opted in',
}

// The strategy a run follows (or the next run will), null for a pattern that
// has no turns. A view from before strategies existed ran the old defaults.
export function turnTakingOf(swarm, config, provider = 'simulated') {
  if (swarm) {
    const allowed = turnTakingFor(swarm.pattern || swarm.requested)
    return allowed.includes(swarm.turnTaking) ? swarm.turnTaking : allowed[0] || null
  }
  const pattern = patternId(config)
  return clampConfig(pattern, PROVIDER_PROFILE[provider] ? provider : 'simulated', config || {}).turnTaking
}

export function turnTakingName(id) {
  return TURN_TAKING[id]?.name || ''
}

// "Critic", "Analyst and Interrogator"
export function namesOf(ids, team = {}) {
  const names = (Array.isArray(ids) ? ids : []).map((id) => team[id]?.name || roleName(id) || id)
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// "Turn 4", "Turn 4, round 2"
export function turnLabel(turn) {
  if (!turn) return ''
  return `Turn ${Number(turn.round) || 1}${turn.debateRound ? `, round ${turn.debateRound}` : ''}`
}

// Monitor flags (engine.js beforeCall / afterCall) in plain words.
export function explainFlag(flag, { team = {}, pattern, turnTaking = null } = {}) {
  if (flag === 'budget_80') {
    return {
      title: '80% of the call budget is used',
      body: 'One call stays reserved for the final answer. At the limit the Monitor asks the room to continue or wrap up.',
    }
  }
  if (String(flag).startsWith('loop:')) {
    const id = String(flag).slice(5)
    const name = team[id]?.name || roleName(id) || id
    // Mirrors engine.js loopConsequence.
    const cost = turnTaking === 'self_select' ? ' It moves to the back of the queue when it opts in.' : turnTaking === 'auction' || !turnTaking ? ' Its bids are penalized.' : ''
    return {
      title: `${name} repeated itself`,
      body: pattern === 'swarm'
        ? `Its output was almost word for word the same as before.${cost} Two repeats make the Monitor ask the room.`
        : 'Its output was almost word for word the same as before. The Monitor noted it in the conversation.',
    }
  }
  return { title: String(flag), body: '' }
}

// Defensive readers -------------------------------------------------------

export function teamOf(swarm) {
  const team = swarm && swarm.team && typeof swarm.team === 'object' ? swarm.team : {}
  const order = Array.isArray(swarm?.order) ? swarm.order.filter((id) => team[id]) : []
  for (const id of Object.keys(team)) if (!order.includes(id)) order.push(id)
  return order.map((id) => ({ ...team[id], id }))
}

export function nodesOf(swarm) {
  return Array.isArray(swarm?.graph?.nodes) ? swarm.graph.nodes.filter((n) => n && n.id) : []
}

// What a roster row should say for an agent. Agents the run never needed keep
// the engine's 'idle'; their graph nodes say whether they were skipped.
export function agentState(agent, swarm) {
  const running = swarm?.status === 'running'
  const s = agent?.status
  if (s === 'speaking') return { key: 'live', label: 'Speaking' }
  if (s === 'thinking') return { key: 'live', label: 'Thinking' }
  if (s === 'done') return { key: 'done', label: 'Done' }
  if (s === 'failed') return { key: 'failed', label: 'Failed' }
  if (s === 'canceled') return { key: 'faded', label: 'Stopped' }
  if (s === 'planned') return { key: 'planned', label: 'Planned' }
  const nodes = nodesOf(swarm).filter((n) => n.agentId === agent?.id)
  if (nodes.length && nodes.every((n) => FADED_NODE.has(n.status))) return { key: 'faded', label: nodes.some((n) => n.status === 'skipped') ? 'Not needed' : 'Not used' }
  return { key: 'idle', label: running ? 'Waiting' : 'Idle' }
}

export function boardItemCount(board) {
  if (!board || typeof board !== 'object') return 0
  return ['constraints', 'plan', 'facts', 'questions', 'decisions'].reduce((n, k) => n + (Array.isArray(board[k]) ? board[k].length : 0), 0)
}
