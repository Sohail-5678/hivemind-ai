// One reducer for both transports (WebSocket server mode and the encrypted relay
// static mode) — they emit the same message shapes, so the UI can't drift.
// Agent-team messages reduce through the engine's own view model (view.js), the
// same function the server and the static host use for late-joiner snapshots.
import { SWARM_MESSAGE_TYPES, reduceSwarmView } from '@shared/swarm/view.js'

export const initialSessionState = {
  session: null,
  you: null,
  events: [],
  participants: [],
  status: 'idle',          // idle | running | paused
  streaming: null,         // { runId, text }
  activeTool: null,        // { tool, query } while a tool call is in flight
  connection: 'connecting', // connecting | open | closed | error
  error: null,
  notice: null,
  noticeProgress: false,   // true for "queued / cooling down" — cleared when the answer starts
  forkTarget: null,        // session object we were told to hop to
  swarm: null,             // agent-team view model (see server/swarm/view.js)
  blackboard: null,        // shared board: goal, constraints, plan, facts, questions, decisions, draft, final
}

export function addEvent(events, event) {
  if (!event) return events
  if (events.some((e) => e.id === event.id)) return events
  return [...events, event]
}

// A draft the Critic approved was persisted before it became the answer.
// swarm_final marks it afterwards; both runtimes store the same flag, so a
// reload, a late joiner and everyone watching live see one final answer.
export function markFinal(events, eventId) {
  if (eventId == null) return events
  const i = events.findIndex((e) => e.id === eventId)
  if (i < 0 || events[i].meta?.final === true) return events
  const next = events.slice()
  next[i] = { ...events[i], meta: { ...(events[i].meta || {}), final: true } }
  return next
}

// The answer has started (or ended): a "queued / cooling down" notice is now stale.
function clearProgress(state) {
  return state.noticeProgress ? { notice: null, noticeProgress: false } : {}
}

const PROGRESS_ENDERS = new Set(['swarm_agent_start', 'swarm_token', 'swarm_done'])

export function sessionReducer(state, msg) {
  if (SWARM_MESSAGE_TYPES.has(msg.type)) {
    const view = reduceSwarmView({ swarm: state.swarm, blackboard: state.blackboard }, msg)
    if (!view) return state
    const swarm = view.swarm ?? null
    const blackboard = view.blackboard ?? null
    // An agent starting to think or speak (or the run ending) makes a
    // "queued / cooling down" notice stale, exactly like the single agent's first token.
    const progress = PROGRESS_ENDERS.has(msg.type) ? clearProgress(state) : {}
    const events = msg.type === 'swarm_final' ? markFinal(state.events, msg.eventId) : state.events
    if (swarm === state.swarm && blackboard === state.blackboard && events === state.events && !('noticeProgress' in progress)) return state
    return { ...state, swarm, blackboard, events, ...progress }
  }
  switch (msg.type) {
    case 'connection':
      return { ...state, connection: msg.value, error: msg.error || null }
    case 'joined':
      // The snapshot is authoritative: adopt live run state (mid-stream joiner
      // sees text streamed so far) and drop anything stale from a previous
      // session/connection (fork hop, reconnect after the run ended).
      return {
        ...state,
        session: msg.session,
        you: msg.you,
        events: msg.events || [],
        participants: msg.participants || [],
        status: msg.agentStatus === 'running' ? 'running'
          : (msg.agentStatus || msg.session?.status) === 'paused' ? 'paused' : 'idle',
        streaming: msg.streaming ? { runId: msg.streaming.runId, text: msg.streaming.text || '' } : null,
        activeTool: null,
        connection: 'open',
        error: null,
        swarm: msg.swarm || null,
        blackboard: msg.blackboard || null,
      }
    case 'presence':
      return { ...state, participants: msg.participants || [] }
    case 'user_message':
      return { ...state, events: addEvent(state.events, msg.event) }
    case 'timeline_event':
      return { ...state, events: addEvent(state.events, msg.event) }
    case 'user_redirected':
      return { ...state, events: addEvent(state.events, msg.event), activeTool: null }
    case 'session_status':
      return { ...state, status: msg.status === 'running' ? 'running' : msg.status === 'paused' ? 'paused' : 'idle' }
    case 'agent_started':
      return { ...state, status: 'running', streaming: { runId: msg.runId, text: '' }, activeTool: null }
    case 'agent_token': {
      const current = state.streaming && state.streaming.runId === msg.runId
        ? state.streaming
        : { runId: msg.runId, text: '' }
      return { ...state, streaming: { ...current, text: current.text + msg.delta }, activeTool: null, ...clearProgress(state) }
    }
    case 'agent_tool':
      return {
        ...state,
        events: addEvent(state.events, msg.event),
        activeTool: msg.phase === 'call' ? { tool: msg.tool, query: msg.event?.content } : null,
      }
    case 'agent_done':
      return { ...state, streaming: null, activeTool: null, events: addEvent(state.events, msg.event), ...clearProgress(state) }
    case 'agent_paused': {
      // Same words as the timeline line: a team room pauses the team.
      const team = state.session?.config?.crew === 'team'
      return { ...state, status: 'paused', notice: msg.by ? `${msg.by.name} paused ${team ? 'the team' : 'the agent'}` : team ? 'Team paused' : 'Agent paused', noticeProgress: false }
    }
    case 'agent_resumed': {
      const team = state.session?.config?.crew === 'team'
      return { ...state, notice: msg.by ? `${msg.by.name} resumed ${team ? 'the team' : 'the agent'}` : team ? 'Team resumed' : 'Agent resumed', noticeProgress: false }
    }
    case 'agent_error':
      return { ...state, notice: msg.error, noticeProgress: false, streaming: null, activeTool: null }
    case 'agent_notice':
      return { ...state, notice: msg.notice, noticeProgress: Boolean(msg.progress) }
    case 'session_config':
      return state.session ? { ...state, session: { ...state.session, config: msg.config } } : state
    case 'session_forked':
      return {
        ...state,
        notice: `${msg.by?.name || 'Someone'} forked this session → "${msg.newSession?.name}"`,
        noticeProgress: false,
        forkTarget: msg.by?.id && state.you?.id === msg.by.id ? msg.newSession : state.forkTarget,
      }
    case 'local_notice':
      return { ...state, notice: msg.notice, noticeProgress: false }
    case 'clear_notice':
      return { ...state, notice: null, noticeProgress: false }
    case 'clear_fork':
      return { ...state, forkTarget: null }
    default:
      return state
  }
}
