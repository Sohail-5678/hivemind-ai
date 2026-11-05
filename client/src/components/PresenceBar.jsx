import React from 'react'
import { HUMAN_COLORS } from '@shared/palette.js'
import { PATTERNS } from '@shared/swarm/patterns.js'
import { plannedTeam } from './hive/roster'
import { turnTakingOf } from './hive/format'

const MAX_HUMANS = 5
const MAX_AGENTS = 4
const HUMAN_SET = new Set(HUMAN_COLORS.map((c) => c.toLowerCase()))

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'
}

// Role glyphs are plain Unicode; the variation selector keeps platforms that
// have emoji forms for a few of them (✳ ✓ ✎) on the text form.
export function textGlyph(glyph) {
  return `${glyph || '●'}︎`
}

// A person keeps their presence colour as the ring, as long as it is one of
// the human palette colours (rooms saved before the re-theme carry old ones).
function humanRing(color) {
  return color && HUMAN_SET.has(String(color).toLowerCase()) ? color : undefined
}

// Avatars are decorative: the name always sits next to them or in the
// surrounding group's label. `title` is a hover hint only.
export function HumanAvatar({ name, color, typing = false, small = false, title }) {
  const ring = humanRing(color)
  return (
    <span
      className={`avatar-neu human avatar${small ? ' sm' : ''}${typing ? ' typing' : ''}`}
      style={ring ? { '--ring': ring } : undefined}
      title={title}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

// Agents are squared off so a glance separates them from people even before
// colour. Glyph and ring are both sage (index.css); the role shows in the glyph
// itself, so `color` is accepted for callers but not drawn.
export function AgentAvatar({ glyph, live = false, small = false, title }) {
  return (
    <span
      className={`avatar-neu agent avatar agent-av${small ? ' sm' : ''}${live ? ' live' : ''}`}
      title={title}
      aria-hidden="true"
    >
      {textGlyph(glyph)}
    </span>
  )
}

const isLive = (a) => a.status === 'speaking' || a.status === 'thinking'

// The team as the room knows it: the live roster once a run has started,
// otherwise the planned team for the chosen architecture (with the Moderator
// when it runs the floor).
function teamOf(config, swarm) {
  if (swarm?.order?.length) return swarm.order.map((id) => swarm.team?.[id]).filter(Boolean)
  return plannedTeam(config).map((a) => ({ ...a, status: 'idle' }))
}

function roomType(mode, team) {
  if (mode === 'live') return team ? 'Hive' : 'Multiplayer'
  if (mode === 'sample') return team ? 'Agent team' : 'Solo'
  return team ? 'Agent team' : null
}

// The last run's view only describes the room while it runs, or while the
// room is still set to the architecture (and turn-taking) that run used. After
// someone switches either, the planned team for the next run is the truth: a
// Moderator joins or leaves with its strategy (HivePanel previews the same way).
function currentRun(config, swarm) {
  if (!swarm) return null
  if (swarm.status === 'running' || !config?.pattern) return swarm
  if (config.pattern !== swarm.requested) return null
  if (config.pattern !== 'auto' && turnTakingOf(swarm, config) !== turnTakingOf(null, config)) return null
  return swarm
}

function patternLabel(config, run) {
  const id = run ? run.pattern || run.requested : config?.pattern
  return PATTERNS[id]?.name || PATTERNS.auto.name
}

function namesLine(people, you) {
  const label = (p) => (p.id === you?.id ? `${p.name} (you)` : p.name)
  if (people.length <= 3) return people.map(label).join(', ')
  return `${people.slice(0, 2).map(label).join(', ')} and ${people.length - 2} others`
}

function chipOf(connection, status, team) {
  if (connection === 'connecting') return { cls: 'conn', text: 'Connecting' }
  if (connection === 'closed') return { cls: 'conn', text: 'Reconnecting' }
  if (connection === 'error') return { cls: 'conn error', text: 'Offline' }
  if (status === 'running') return { cls: 'running', text: team ? 'Team working' : 'Agent working' }
  if (status === 'paused') return { cls: 'paused', text: 'Paused' }
  return { cls: 'idle', text: 'Idle' }
}

export function PresenceBar({ sessionName, participants = [], you, status = 'idle', connection = 'open', config = null, swarm = null, mode = null }) {
  // Rooms without a config (made before agent teams existed) are single-agent;
  // a live run outranks a config that is about to change.
  const team = config?.crew ? config.crew === 'team' || swarm?.status === 'running' : Boolean(swarm)
  const people = [...participants].sort((a, b) => (a.id === you?.id ? -1 : b.id === you?.id ? 1 : 0))
  const shownPeople = people.slice(0, MAX_HUMANS)
  const extraPeople = people.length - shownPeople.length

  const run = currentRun(config, swarm)
  const agents = team ? teamOf(config, run) : [{ id: 'agent', name: 'HiveMind', glyph: '✳', status: status === 'running' ? 'speaking' : 'idle' }]
  const running = status === 'running' && connection === 'open'
  const liveAgents = running ? agents.filter(isLive) : []
  const shownAgents = agents.slice(0, MAX_AGENTS)
  const extraAgents = agents.length - shownAgents.length
  const plannedAuto = team && !run?.order?.length && (config?.pattern || 'auto') === 'auto'

  const kind = roomType(mode, team)
  const kindLine = team ? [kind, patternLabel(config, run)].filter(Boolean).join(' · ') : kind
  const agentLine = plannedAuto
    ? 'Architect picks the team'
    : `${agents.length} agent${agents.length === 1 ? '' : 's'}${liveAgents.length ? ` · ${liveAgents.length} live` : ''}`
  const chip = chipOf(connection, status, team)

  return (
    <div className="presence-bar">
      <div className="presence-title">
        <span className="session-name" title={sessionName}>{sessionName}</span>
        {kindLine && <span className="presence-kind">{kindLine}</span>}
      </div>

      {people.length > 0 && (
        <div className="presence-group humans" aria-label={`${people.length} ${people.length === 1 ? 'person' : 'people'} here: ${namesLine(people, you)}`} role="group">
          <div className="avatars">
            {shownPeople.map((p) => (
              <HumanAvatar
                key={p.id}
                name={p.name}
                color={p.color}
                typing={p.typing}
                title={`${p.id === you?.id ? `${p.name} (you)` : p.name}${p.typing ? ', typing' : ''}`}
              />
            ))}
            {extraPeople > 0 && <span className="avatar avatar-more" aria-hidden="true">+{extraPeople}</span>}
          </div>
          <span className="presence-names" aria-hidden="true">{namesLine(people, you)}</span>
        </div>
      )}

      <div className={`presence-group agents${liveAgents.length ? ' is-live' : ''}`} role="group" aria-label={team ? `Agent team: ${agentLine}` : 'One agent'}>
        <div className="avatars">
          {shownAgents.map((a) => (
            <AgentAvatar
              key={a.id}
              glyph={a.glyph}
              color={team ? a.color : undefined}
              live={running && isLive(a)}
              small
              title={`${a.name}${running && isLive(a) ? ', working' : ''}`}
            />
          ))}
          {extraAgents > 0 && <span className="avatar avatar-more agent" aria-hidden="true">+{extraAgents}</span>}
        </div>
        <span className="presence-agents-label" aria-hidden="true">{team ? agentLine : 'One agent'}</span>
      </div>

      <div className={`status-chip ${chip.cls}`} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        {chip.text}
      </div>
    </div>
  )
}
