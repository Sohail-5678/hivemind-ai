import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { SessionWorkspace } from './SessionWorkspace'
import { SCRIPT, CAST, expandScript } from '../demo/demoScript'
import { startHiveDemo, DEMO_PATTERNS, SCENARIOS } from '../demo/hiveDemo'
import { PatternGlyph } from './hive/PatternGlyph'
import { sessionReducer, initialSessionState } from '../hooks/sessionReducer'
import { PATTERNS } from '@shared/swarm/patterns.js'

// Two demos behind one switch. The replay is a choreographed multiplayer
// session; the Hive demo runs the real multi-agent engine in this tab with the
// scripted brain and two scripted teammates. Neither touches the network.

const MODES = [
  { id: 'replay', label: 'Multiplayer replay' },
  { id: 'hive', label: 'Hive (multi-agent)' },
]
const MODE_KEY = 'hivemind_demo_mode'

function readMode() {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return MODES.some((m) => m.id === v) ? v : 'hive'
  } catch { return 'hive' }
}

function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* private mode: not worth surfacing */ }
}

function ReplayIcon() {
  return (
    <svg className="demo-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75" />
      <path d="M12 1.8v2.9H9.1" />
    </svg>
  )
}

// The strip at the top of the workspace that says what the viewer is watching.
function DemoNote({ label, live = false, actions = null, children }) {
  return (
    <div className="demo-note" role="note">
      <span className={`demo-note-mark${live ? ' live' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 28 28" focusable="false">
          <circle cx="14" cy="14" r="12.5" />
          <circle cx="14" cy="14" r="8" />
          <circle className="core" cx="14" cy="14" r="3.2" />
        </svg>
      </span>
      <div className="demo-note-copy">
        <span className="label-mono">{label}</span>
        <p>{children}</p>
      </div>
      {actions && <div className="demo-note-actions">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- replay

const replayInitial = {
  session: { name: 'Q3 Mobile Launch Plan' },
  you: { id: 'demo_viewer' },
  events: [],
  participants: [],
  status: 'idle',
  streaming: null,
  activeTool: null,
  ended: false,
}

let replayId = 1
const nextId = () => `replay_${replayId++}`
const isoNow = () => new Date().toISOString()

function replayReducer(state, step) {
  switch (step.type) {
    case 'reset':
      return { ...replayInitial, events: [], participants: [] }
    case 'join':
      return {
        ...state,
        participants: [...state.participants.filter((p) => p.id !== step.user.id), { ...step.user, typing: false }],
        events: [...state.events, { id: nextId(), type: 'join', author: step.user, createdAt: isoNow() }],
      }
    case 'typing':
      return { ...state, participants: state.participants.map((p) => (p.id === step.user.id ? { ...p, typing: step.on } : p)) }
    case 'message':
      return {
        ...state,
        participants: state.participants.map((p) => (p.id === step.user.id ? { ...p, typing: false } : p)),
        events: [...state.events, { id: nextId(), type: 'user_message', author: step.user, content: step.text, createdAt: isoNow() }],
      }
    case 'agent_start':
      return { ...state, status: 'running', streaming: { runId: nextId(), text: '' } }
    case 'tool_call':
      return {
        ...state,
        activeTool: { tool: step.tool, query: step.query },
        events: [...state.events, { id: nextId(), type: 'tool_call', author: CAST.agent, content: step.query, meta: { tool: step.tool }, createdAt: isoNow() }],
      }
    case 'tool_result':
      return {
        ...state,
        activeTool: null,
        events: [...state.events, { id: nextId(), type: 'tool_result', author: CAST.agent, content: step.result, meta: { tool: step.tool }, createdAt: isoNow() }],
      }
    case 'delta':
      return { ...state, streaming: { runId: state.streaming?.runId || nextId(), text: (state.streaming?.text || '') + step.delta } }
    case 'redirect':
      return {
        ...state,
        participants: state.participants.map((p) => (p.id === step.user.id ? { ...p, typing: false } : p)),
        events: [...state.events, { id: nextId(), type: 'redirect', author: step.user, content: step.text, createdAt: isoNow() }],
      }
    case 'interrupt':
      return {
        ...state,
        streaming: null,
        events: state.streaming?.text
          ? [...state.events, { id: nextId(), type: 'agent_message', author: CAST.agent, content: state.streaming.text, meta: { partial: true }, createdAt: isoNow() }]
          : state.events,
      }
    case 'agent_done':
      return {
        ...state,
        status: 'idle',
        streaming: null,
        events: state.streaming?.text
          ? [...state.events, { id: nextId(), type: 'agent_message', author: CAST.agent, content: state.streaming.text, createdAt: isoNow() }]
          : state.events,
      }
    case 'fork':
      return { ...state, events: [...state.events, { id: nextId(), type: 'fork', author: step.user, content: step.name, createdAt: isoNow() }] }
    case 'system':
      return { ...state, events: [...state.events, { id: nextId(), type: 'system', content: step.text, createdAt: isoNow() }] }
    case 'end':
      return { ...state, ended: true, status: 'idle' }
    default:
      return state
  }
}

function ReplayDemo({ onGoLive }) {
  const [state, dispatch] = useReducer(replayReducer, replayInitial)
  const [playKey, setPlayKey] = useState(0)

  useEffect(() => {
    dispatch({ type: 'reset' })
    const steps = expandScript(SCRIPT)
    let index = 0
    let timer = null
    let cancelled = false
    const tick = () => {
      if (cancelled || index >= steps.length) return
      const step = steps[index]
      timer = setTimeout(() => {
        if (cancelled) return
        dispatch(step)
        index++
        tick()
      }, step.delay)
    }
    tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [playKey])

  const banner = (
    <DemoNote
      label={state.ended ? 'Replay finished' : 'Scripted replay'}
      live={!state.ended}
      actions={(
        <>
          <button className="btn btn-sm" onClick={() => setPlayKey((k) => k + 1)}><ReplayIcon />Replay</button>
          {state.ended && onGoLive && <button className="btn btn-sm btn-primary" onClick={onGoLive}>Try it live</button>}
        </>
      )}
    >
      {state.ended
        ? 'That is one shared agent session: three people, one agent, everyone seeing the same thing as it happens.'
        : 'Three teammates steer one agent together. Watch Jordan redirect it mid-sentence and Sam fork the room.'}
    </DemoNote>
  )

  return (
    <SessionWorkspace
      session={state.session}
      you={state.you}
      events={state.events}
      participants={state.participants}
      status={state.status}
      streaming={state.streaming}
      activeTool={state.activeTool}
      banner={banner}
      readOnly
      readOnlyHint="This is a replay. Open Live to drive a real session."
    />
  )
}

// ---------------------------------------------------------------- hive

const NOTICES = {
  vote: 'No vote is open right now.',
  escalation: 'The Monitor already has its answer.',
  pin: 'That pin is empty, too long, or already on the board.',
}

function seconds(ms) {
  return Math.max(1, Math.round((ms || 0) / 1000))
}

function hiveSummary(result) {
  const name = PATTERNS[result.pattern]?.name || 'The'
  if (result.outcome === 'error') return 'The demo hit an error and stopped. Replay to run it again.'
  const calls = result.stats?.calls ?? 0
  const head = `${name} team finished: ${calls} agent call${calls === 1 ? '' : 's'} in ${seconds(result.stats?.elapsedMs)} s`
  const asks = result.escalations || 0
  const tail = result.outcome === 'budget' ? ', stopped at its budget' : asks ? `, after ${asks === 1 ? 'one stop' : `${asks} stops`} to ask the humans` : ''
  return `${head}${tail}. Pick another architecture, or replay this one.`
}

function ArchPicker({ value, onPick }) {
  return (
    <div className="demo-arch-options" role="group" aria-label="Architecture">
      {DEMO_PATTERNS.map((id) => (
        <button
          key={id}
          type="button"
          className="demo-arch-opt"
          aria-pressed={value === id}
          onClick={() => onPick(id)}
        >
          <PatternGlyph pattern={id} size={40} className="demo-arch-glyph" />
          <span>{PATTERNS[id].name}</span>
        </button>
      ))}
    </div>
  )
}

function HiveDemo({ onGoLive }) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState)
  const [choice, setChoice] = useState({ scenario: 'auto', pattern: 'auto', run: 0 })
  const [result, setResult] = useState(null)
  const ctlRef = useRef(null)

  // One run per choice. Cleanup aborts the engine and clears every scripted
  // timer, so replaying, switching architecture or leaving never leaks a run.
  useEffect(() => {
    setResult(null)
    const ctl = startHiveDemo({ scenario: choice.scenario, pattern: choice.pattern, notice: choice.notice, dispatch, onEnd: setResult })
    ctlRef.current = ctl
    return () => {
      ctl.stop()
      if (ctlRef.current === ctl) ctlRef.current = null
    }
  }, [choice])

  const pick = (id) => setChoice((c) => ({ scenario: id, pattern: id, run: c.run + 1 }))
  const replay = () => setChoice((c) => ({ ...c, run: c.run + 1, notice: null }))

  // The panels talk to the demo the way they talk to a room: resolve on
  // success, throw a readable error otherwise (the workspace shows it).
  // Switching the architecture or forking re-runs this goal with the new
  // shape, which is what "fork with another architecture" does in a room.
  const onAction = useCallback(async (action, extra = {}) => {
    if (action === 'set_config' || action === 'fork') {
      const next = action === 'fork' ? extra.pattern : extra.config?.pattern
      if (!PATTERNS[next]) throw new Error('That architecture is not available.')
      setChoice((c) => ({ scenario: c.scenario, pattern: next, run: c.run + 1, notice: `Running the same goal as a ${PATTERNS[next].name} team.` }))
      return { ok: true }
    }
    if (ctlRef.current?.act(action, extra)) return { ok: true }
    throw new Error(NOTICES[action] || 'This is a scripted demo. Open Live to steer a real team.')
  }, [])
  const notify = useCallback((notice) => dispatch({ type: 'local_notice', notice }), [])

  const scenario = SCENARIOS[choice.scenario]
  const forked = choice.pattern !== choice.scenario
  const p = PATTERNS[choice.pattern]
  const hint = forked
    ? <>Same goal, new shape: <strong>{p.name}</strong> ({p.aka}).</>
    : <><span className="label-mono">Fits when</span> {p.usefulWhen}</>

  const running = !result
  const banner = (
    <DemoNote
      label={running ? 'Scripted demo · real engine' : 'Run finished'}
      live={running}
      actions={(
        <>
          <button className="btn btn-sm" onClick={replay}><ReplayIcon />Replay</button>
          {!running && onGoLive && <button className="btn btn-sm btn-primary" onClick={onGoLive}>Run a real team</button>}
        </>
      )}
    >
      {running
        ? <>Maya and Jordan are scripted, and so are the agents’ words. The orchestration is real: the same engine that runs live Hive rooms is running in this tab.{scenario.tightBudget && !forked ? ' This team gets a tight budget, so watch the Monitor stop and ask.' : ''}</>
        : hiveSummary(result)}
    </DemoNote>
  )

  return (
    <>
      <div className="demo-arch">
        <ArchPicker value={choice.pattern} onPick={pick} />
        <p className="demo-arch-hint">{hint}</p>
      </div>
      <SessionWorkspace
        session={state.session}
        you={state.you}
        events={state.events}
        participants={state.participants}
        status={state.status}
        streaming={state.streaming}
        activeTool={state.activeTool}
        swarm={state.swarm}
        blackboard={state.blackboard}
        notice={state.notice}
        noticeProgress={state.noticeProgress}
        onClearNotice={() => dispatch({ type: 'clear_notice' })}
        onAction={onAction}
        onNotice={notify}
        banner={banner}
        readOnly
        readOnlyHint="This is a scripted demo. Open Live to work with a real team."
      />
    </>
  )
}

// ---------------------------------------------------------------- section

export function DemoSection({ onGoLive }) {
  const [mode, setModeState] = useState(readMode)
  const tabs = useRef({})

  const setMode = (next) => {
    setModeState(next)
    saveMode(next)
  }

  // Tabs pattern: arrow keys move between the two demos, Home/End jump.
  const onKeyDown = (e) => {
    const i = MODES.findIndex((m) => m.id === mode)
    const to = e.key === 'ArrowRight' ? (i + 1) % MODES.length
      : e.key === 'ArrowLeft' ? (i - 1 + MODES.length) % MODES.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? MODES.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    setMode(MODES[to].id)
    tabs.current[MODES[to].id]?.focus()
  }

  return (
    <div className="demo">
      <div className="demo-top">
        <div className="seg demo-modes" role="tablist" aria-label="Demo" onKeyDown={onKeyDown}>
          {MODES.map((m) => (
            <button
              key={m.id}
              ref={(el) => { tabs.current[m.id] = el }}
              id={`demo-tab-${m.id}`}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              aria-controls="demo-panel"
              tabIndex={mode === m.id ? 0 : -1}
              className={mode === m.id ? 'active' : ''}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="demo-readout label-mono">{mode === 'hive' ? 'Real engine · scripted brain · no network' : 'Choreographed · no network'}</span>
      </div>
      <div id="demo-panel" className="demo-panel" role="tabpanel" aria-labelledby={`demo-tab-${mode}`}>
        {mode === 'hive' ? <HiveDemo onGoLive={onGoLive} /> : <ReplayDemo onGoLive={onGoLive} />}
      </div>
    </div>
  )
}
