import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../lib/markdown'
import { ROLES } from '@shared/swarm/roles.js'
import { PATTERNS } from '@shared/swarm/patterns.js'
import { HumanAvatar, AgentAvatar } from './PresenceBar'

const PIN_DISTANCE = 80
const FRESH_BATCH = 4

const CLOCK = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' })
function timeOf(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : CLOCK.format(d)
}

const NOTE_LABEL = { architect: 'Architect', plan: 'Plan', vote: 'Vote', escalation: 'Escalation', monitor: 'Monitor' }
// The label already says who is speaking; "Monitor: …" in the text would repeat it.
const NOTE_PREFIX = /^(?:Monitor|Plan|Vote):\s+/
const PIN_LABEL = {
  constraints: 'constraint', constraint: 'constraint',
  facts: 'fact', fact: 'fact',
  questions: 'question', question: 'question',
  decisions: 'decision', decision: 'decision',
  plan: 'plan step',
}
const PARTIAL_LABEL = { paused: 'paused', redirected: 'redirected', stopped: 'stopped', timeout: 'timed out', lost: 'host lost', error: 'interrupted' }

// "Manager · Pricing" already says Manager; a fan-out persona doesn't.
const roleLabelOf = (name, role) => {
  const roleName = ROLES[role]?.name
  return roleName && !String(name || '').toLowerCase().startsWith(roleName.toLowerCase()) ? roleName : null
}
const isTeamAgent = (e) => e.type === 'agent_message' && e.author?.id !== 'agent' && Boolean(e.meta?.pattern || e.meta?.role || e.author?.role)
const isLive = (a) => a.status === 'speaking' || a.status === 'thinking'
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)
const firstLine = (s, max = 110) => {
  const line = String(s || '').split('\n').find((l) => l.trim()) || ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// The answer of a team run. meta.final marks it when it is written as the
// answer; when the Critic approves an earlier draft instead (sequential and
// swarm), the engine marks it afterwards and follows with a 'plan' note. For
// those runs, the latest Writer or Synthesizer draft before that note is the
// answer. swarm.finalEventId is authoritative for the run in view.
function finalIdsOf(events, finalEventId) {
  const ids = new Set()
  if (finalEventId) ids.add(finalEventId)
  const runs = new Map()
  for (const e of events) {
    const runId = e.meta?.runId
    if (!runId) continue
    let run = runs.get(runId)
    if (!run) { run = { hasFinal: false, draft: null, marked: null }; runs.set(runId, run) }
    if (e.type === 'agent_message') {
      if (e.meta.final) run.hasFinal = true
      const role = e.meta.role || e.author?.role
      if (role === 'writer' || role === 'synthesizer') run.draft = e.id
    } else if (e.type === 'swarm_note' && e.meta.kind === 'plan' && run.draft) {
      run.marked = run.draft
    }
  }
  for (const run of runs.values()) if (!run.hasFinal && run.marked) ids.add(run.marked)
  return ids
}

// Rows appended a few at a time rise in; a snapshot (join, reconnect, fork hop)
// lands without a cascade of 200 animations.
function useFreshIds(events) {
  const ref = useRef(null)
  if (!ref.current) ref.current = { known: new Set(events.map((e) => e.id)), fresh: new Set() }
  const { known, fresh } = ref.current
  const added = []
  for (let i = events.length - 1; i >= 0 && !known.has(events[i].id); i--) added.push(events[i].id)
  if (added.length <= FRESH_BATCH) added.forEach((id) => fresh.add(id))
  added.forEach((id) => known.add(id))
  return fresh
}

function Time({ iso }) {
  const t = timeOf(iso)
  return t ? <time className="tl-time" dateTime={iso}>{t}</time> : null
}

function Control({ control }) {
  if (!control) return null
  const verdict = String(control.verdict || '').toUpperCase()
  const approve = /APPROVE/.test(verdict)
  return (
    <div className="tl-control">
      {verdict && <span className={`tl-verdict ${approve ? 'approve' : 'revise'}`}>Verdict · {approve ? 'approve' : 'revise'}</span>}
      {control.proposal && <span className="tl-control-item"><span className="tl-control-k">Proposal</span>{control.proposal}</span>}
      {control.vote && <span className="tl-control-item"><span className="tl-control-k">Votes for</span>{control.vote}</span>}
    </div>
  )
}

function TeamMessage({ event, final }) {
  const author = event.author || {}
  const meta = event.meta || {}
  const { content } = event
  const role = meta.role || author.role
  const name = author.name || ROLES[role]?.name || 'Agent'
  const roleLabel = roleLabelOf(name, role)
  const glyph = author.glyph || ROLES[role]?.glyph
  const inputs = meta.a2a?.referenceTaskIds?.length || 0
  const pattern = PATTERNS[meta.pattern]?.name

  if (final) {
    return (
      <article className="tl-final" aria-label={`Final answer from ${name}`}>
        <header className="tl-final-head">
          <AgentAvatar glyph={glyph} color={author.color} />
          <div className="tl-final-title">
            <span className="tl-final-label"><span className="dot agent" aria-hidden="true" />Final answer</span>
            <span className="tl-final-by">{name}{pattern ? ` · ${pattern} team` : ''}</span>
          </div>
          <div className="tl-final-meta">
            {meta.scripted && <span className="badge tl-tag" title="The scripted stand-in wrote this step">scripted</span>}
            <Time iso={event.createdAt} />
          </div>
        </header>
        <div className="tl-content"><Markdown text={content} /></div>
      </article>
    )
  }

  return (
    <article className="tl-event agent team">
      <AgentAvatar glyph={glyph} color={author.color} />
      <div className="tl-body">
        <header className="tl-head">
          <span className="tl-name">{name}</span>
          {roleLabel && <span className="tl-role">{roleLabel}</span>}
          {meta.scripted && <span className="badge tl-tag" title="The scripted stand-in covered this step">scripted</span>}
          {inputs > 0 && <span className="tl-inputs" title={`Built on ${inputs} teammate output${inputs === 1 ? '' : 's'}`}>← {inputs}</span>}
          <Time iso={event.createdAt} />
        </header>
        <div className="tl-content"><Markdown text={content} /></div>
        <Control control={meta.control} />
      </div>
    </article>
  )
}

function SingleMessage({ event }) {
  const { author, content, meta } = event
  return (
    <article className="tl-event agent single">
      <AgentAvatar glyph="✳" />
      <div className="tl-body">
        <header className="tl-head">
          <span className="tl-name">{author?.name || 'HiveMind'}</span>
          <span className="tl-role">Agent</span>
          {meta?.partial && <span className="badge danger tl-tag">{PARTIAL_LABEL[meta.reason] || 'interrupted'}</span>}
          <Time iso={event.createdAt} />
        </header>
        <div className="tl-content"><Markdown text={content} /></div>
      </div>
    </article>
  )
}

function HumanMessage({ event, mine }) {
  const { author, content } = event
  return (
    <article className={`tl-event human${mine ? ' mine' : ''}`}>
      <HumanAvatar name={author?.name} color={author?.color} />
      <div className="tl-body">
        <header className="tl-head">
          <span className="tl-name">{author?.name || 'Someone'}{mine && <span className="tl-you"> (you)</span>}</span>
          <Time iso={event.createdAt} />
        </header>
        <div className="tl-content"><Markdown text={content} /></div>
      </div>
    </article>
  )
}

function Note({ kind, glyph, children, time }) {
  return (
    <div className={`tl-note ${kind}`}>
      <span className="tl-note-glyph" aria-hidden="true">{glyph}</span>
      <span className="tl-note-text">{children}</span>
      {time && <Time iso={time} />}
    </div>
  )
}

function EventRow({ event, youId, final, crew }) {
  const { type, author, content, meta } = event
  const who = author?.name || 'Someone'

  switch (type) {
    case 'system':
    case 'join':
    case 'leave':
    case 'pause':
    case 'resume': {
      const label =
        type === 'join' ? `${who} joined` :
        type === 'leave' ? `${who} left` :
        type === 'pause' ? `${who} paused the ${crew}` :
        type === 'resume' ? `${who} resumed the ${crew}` :
        content
      return <div className={`tl-system ${type}`}><span className="pill">{label}</span></div>
    }
    case 'redirect':
      return <Note kind="redirect" glyph="↪" time={event.createdAt}><strong>{who}</strong> redirected the {crew}: “{content}”</Note>
    case 'fork': {
      const pattern = PATTERNS[meta?.pattern]?.name
      return (
        <Note kind="fork" glyph="⑂" time={event.createdAt}>
          <strong>{who}</strong> forked this room into “{content}”{pattern ? ` to try ${pattern}` : ''}
        </Note>
      )
    }
    case 'pin':
      return (
        <Note kind="pin" glyph="⊕" time={event.createdAt}>
          <strong>{who}</strong> pinned a {PIN_LABEL[meta?.kind] || 'note'} to the board: “{content}”
        </Note>
      )
    case 'config':
      return <Note kind="config" glyph="⇄" time={event.createdAt}><strong>{who}</strong> {lowerFirst(content) || 'changed the room setup'}</Note>
    case 'tool_call':
    case 'tool_result':
      return (
        <div className={`tl-tool ${type === 'tool_call' ? 'call' : 'result'}`} title="A scripted demo step. HiveMind agents have no tools.">
          <span className="tl-tool-glyph" aria-hidden="true">{type === 'tool_call' ? '›' : '‹'}</span>
          <span className="tl-tool-name">{meta?.tool || 'step'}</span>
          <span className="tl-tool-text">{content}</span>
          <span className="badge">scripted</span>
        </div>
      )
    case 'swarm_note': {
      const kind = NOTE_LABEL[meta?.kind] ? meta.kind : 'monitor'
      return (
        <div className={`tl-sys ${kind}`}>
          <span className="tl-sys-label">{NOTE_LABEL[kind]}</span>
          <span className="tl-sys-text">{String(content || '').replace(NOTE_PREFIX, '')}</span>
          <Time iso={event.createdAt} />
        </div>
      )
    }
    case 'agent_message':
      return isTeamAgent(event) ? <TeamMessage event={event} final={final} /> : <SingleMessage event={event} />
    default:
      // user_message, and anything newer than this client: show it as said by its author.
      if (!content) return null
      return <HumanMessage event={event} mine={Boolean(youId) && author?.id === youId} />
  }
}

// Rows only re-render when their own event changes, so a 200+ event timeline
// stays cheap while tokens stream in below it.
const Row = memo(function Row({ event, youId, final, crew, fresh }) {
  return (
    <div className={`tl-row${fresh ? ' fresh' : ''}`}>
      <EventRow event={event} youId={youId} final={final} crew={crew} />
    </div>
  )
})

function StreamBubble({ name, role, glyph, color, text, live = true }) {
  return (
    <article className="tl-event agent streaming" aria-busy="true">
      <AgentAvatar glyph={glyph} color={color} live={live} />
      <div className="tl-body">
        <header className="tl-head">
          <span className="tl-name">{name}</span>
          {role && <span className="tl-role">{role}</span>}
          <span className="tl-live-label">streaming</span>
        </header>
        <div className="tl-content">
          {text
            ? <><Markdown text={text} /><span className="caret" aria-hidden="true" /></>
            : <span className="tl-thinking">thinking<span className="caret" aria-hidden="true" /></span>}
        </div>
      </div>
    </article>
  )
}

function WorkingLine({ agent }) {
  const task = firstLine(agent.task)
  return (
    <div className="tl-working" aria-busy="true">
      <AgentAvatar glyph={agent.glyph} color={agent.color} live small />
      <span className="tl-name">{agent.name}</span>
      {task && <span className="tl-working-task">{task}</span>}
      <span className="tool-spinner" aria-hidden="true" />
    </div>
  )
}

function liveAgentsOf(swarm) {
  if (!swarm || swarm.status !== 'running') return []
  return (swarm.order || []).map((id) => swarm.team?.[id]).filter((a) => a && isLive(a))
}

const QUIET_TYPES = new Set(['system', 'join', 'leave', 'config'])

function EmptyState({ team }) {
  return (
    <div className="tl-empty">
      <span className="tl-empty-rings" aria-hidden="true"><span /><span /><span /></span>
      <p className="tl-empty-title">The room is quiet</p>
      <p className="tl-empty-sub">
        {team ? 'Send a goal and the team will start working on it.' : 'Send a message and the agent will pick it up.'}
      </p>
    </div>
  )
}

export function AgentTimeline({ events = [], streaming = null, activeTool = null, you = null, agentName = 'HiveMind', swarm = null, teamRoom = false }) {
  const scrollRef = useRef(null)
  const pinnedRef = useRef(true)
  const seenRef = useRef(events.length)
  const [pinned, setPinned] = useState(true)

  const hasSwarm = Boolean(swarm)
  const team = useMemo(() => teamRoom || hasSwarm || events.some(isTeamAgent), [teamRoom, hasSwarm, events])
  const crew = team ? 'team' : 'agent'
  const finalIds = useMemo(() => finalIdsOf(events, swarm?.finalEventId), [events, swarm?.finalEventId])
  const fresh = useFreshIds(events)
  const live = liveAgentsOf(swarm)
  const liveSig = live.map((a) => `${a.id}:${a.status}:${a.stream?.length || 0}`).join('|')
  const monitor = swarm?.status === 'running' ? swarm.monitor : null
  const runPattern = swarm ? PATTERNS[swarm.pattern || swarm.requested]?.name : null

  if (pinned || seenRef.current > events.length) seenRef.current = events.length
  const unseen = pinned ? 0 : events.length - seenRef.current

  const toBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Follow new content while pinned to the bottom. Layout effect, so the row
  // never paints above the fold for a frame.
  useLayoutEffect(() => {
    if (pinnedRef.current) toBottom()
  }, [events, streaming?.text, activeTool, liveSig, pinned])

  // The composer growing or the window resizing changes the viewport height
  // without new content; stay at the bottom through that too.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver !== 'function') return undefined
    const ro = new ResizeObserver(() => { if (pinnedRef.current) toBottom() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_DISTANCE
    pinnedRef.current = atBottom
    setPinned(atBottom)
  }

  const jump = () => {
    pinnedRef.current = true
    setPinned(true)
    toBottom()
  }

  // Every room opens with "Session created" and a join line: a timeline of
  // only those housekeeping pills is still a quiet room.
  const empty = events.every((e) => QUIET_TYPES.has(e.type)) && !streaming && !activeTool && !live.length
  const youId = you?.id || null

  return (
    <div
      className="timeline"
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label="Room timeline"
      tabIndex={0}
    >
      {events.map((e) => (
        <Row
          key={e.id}
          event={e}
          youId={youId}
          final={e.type === 'agent_message' && (e.meta?.final === true || finalIds.has(e.id))}
          crew={crew}
          fresh={fresh.has(e.id)}
        />
      ))}

      {empty && <EmptyState team={team} />}

      {activeTool && (
        <div className="tl-tool call pending" title="A scripted demo step. HiveMind agents have no tools.">
          <span className="tool-spinner" aria-hidden="true" />
          <span className="tl-tool-name">{activeTool.tool || 'step'}</span>
          <span className="tl-tool-text">{activeTool.query || 'working…'}</span>
          <span className="badge">scripted</span>
        </div>
      )}

      {streaming && <StreamBubble name={agentName} role="Agent" glyph="✳" text={streaming.text} />}

      {live.map((a) => (a.status === 'speaking'
        ? <StreamBubble key={a.id} name={a.name} role={roleLabelOf(a.name, a.role)} glyph={a.glyph} color={a.color} text={a.stream} />
        : <WorkingLine key={a.id} agent={a} />))}

      {monitor && (
        <div className="tl-runline" aria-hidden="true">
          <span className="dot live" />
          <span>{runPattern ? `${runPattern} team` : 'Team'} working</span>
          {monitor.maxCalls > 0 && <span className="tl-runline-calls">{monitor.calls}/{monitor.maxCalls} calls</span>}
        </div>
      )}

      {!pinned && (
        <button type="button" className="scroll-pin" onClick={jump}>
          <span aria-hidden="true">↓</span> {unseen > 0 ? `${unseen} new` : 'Jump to latest'}
        </button>
      )}
    </div>
  )
}
