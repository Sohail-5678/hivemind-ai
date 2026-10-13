import React, { useEffect, useReducer, useRef, useState } from 'react'
import { SessionWorkspace } from './SessionWorkspace'
import { SCRIPT, CAST, expandScript } from '../demo/demoScript'

const initialState = {
  session: { name: 'Q3 Mobile Launch Plan' },
  you: { id: 'demo_viewer' },
  events: [],
  participants: [],
  status: 'idle',
  streaming: null,
  activeTool: null,
  ended: false,
}

let demoId = 1
const nextId = () => `demo_${demoId++}`
const now = () => new Date().toISOString()

function reducer(state, step) {
  switch (step.type) {
    case 'reset':
      return { ...initialState, events: [], participants: [] }
    case 'join':
      return {
        ...state,
        participants: [...state.participants.filter((p) => p.id !== step.user.id), { ...step.user, typing: false }],
        events: [...state.events, { id: nextId(), type: 'join', author: step.user, createdAt: now() }],
      }
    case 'typing':
      return { ...state, participants: state.participants.map((p) => (p.id === step.user.id ? { ...p, typing: step.on } : p)) }
    case 'message':
      return {
        ...state,
        participants: state.participants.map((p) => (p.id === step.user.id ? { ...p, typing: false } : p)),
        events: [...state.events, { id: nextId(), type: 'user_message', author: step.user, content: step.text, createdAt: now() }],
      }
    case 'agent_start':
      return { ...state, status: 'running', streaming: { runId: nextId(), text: '' } }
    case 'tool_call':
      return {
        ...state,
        activeTool: { tool: step.tool, query: step.query },
        events: [...state.events, { id: nextId(), type: 'tool_call', author: CAST.agent, content: step.query, meta: { tool: step.tool }, createdAt: now() }],
      }
    case 'tool_result':
      return {
        ...state,
        activeTool: null,
        events: [...state.events, { id: nextId(), type: 'tool_result', author: CAST.agent, content: step.result, meta: { tool: step.tool }, createdAt: now() }],
      }
    case 'delta':
      return { ...state, streaming: { runId: state.streaming?.runId || nextId(), text: (state.streaming?.text || '') + step.delta } }
    case 'redirect':
      return {
        ...state,
        participants: state.participants.map((p) => (p.id === step.user.id ? { ...p, typing: false } : p)),
        events: [...state.events, { id: nextId(), type: 'redirect', author: step.user, content: step.text, createdAt: now() }],
      }
    case 'interrupt':
      return {
        ...state,
        streaming: null,
        events: state.streaming?.text
          ? [...state.events, { id: nextId(), type: 'agent_message', author: CAST.agent, content: state.streaming.text, meta: { partial: true }, createdAt: now() }]
          : state.events,
      }
    case 'agent_done':
      return {
        ...state,
        status: 'idle',
        streaming: null,
        events: state.streaming?.text
          ? [...state.events, { id: nextId(), type: 'agent_message', author: CAST.agent, content: state.streaming.text, createdAt: now() }]
          : state.events,
      }
    case 'fork':
      return { ...state, events: [...state.events, { id: nextId(), type: 'fork', author: step.user, content: step.name, createdAt: now() }] }
    case 'system':
      return { ...state, events: [...state.events, { id: nextId(), type: 'system', content: step.text, createdAt: now() }] }
    case 'end':
      return { ...state, ended: true, status: 'idle' }
    default:
      return state
  }
}

export function DemoSection({ onGoLive }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [playKey, setPlayKey] = useState(0)
  const timerRef = useRef(null)

  useEffect(() => {
    dispatch({ type: 'reset' })
    const steps = expandScript(SCRIPT)
    let index = 0
    let cancelled = false
    const tick = () => {
      if (cancelled || index >= steps.length) return
      const step = steps[index]
      timerRef.current = setTimeout(() => {
        if (cancelled) return
        dispatch(step)
        index++
        tick()
      }, step.delay)
    }
    tick()
    return () => { cancelled = true; if (timerRef.current) clearTimeout(timerRef.current) }
  }, [playKey])

  const banner = (
    <div className="demo-banner">
      <span>▶</span>
      <span>
        {state.ended
          ? 'Replay finished — this is what a shared agent session feels like.'
          : 'Watch: three teammates steer one live agent. This is a scripted replay of a real session.'}
      </span>
      <button className="replay" onClick={() => setPlayKey((k) => k + 1)}>↻ Replay</button>
      {state.ended && onGoLive && <button className="replay" style={{ marginLeft: 8 }} onClick={onGoLive}>Try it live →</button>}
    </div>
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
      readOnlyHint="This is a replay — open Live mode to drive a real session."
    />
  )
}
