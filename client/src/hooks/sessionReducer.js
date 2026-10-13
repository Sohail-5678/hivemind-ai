// One reducer for both transports (WebSocket server mode and BroadcastChannel
// static mode) — they emit the same message shapes, so the UI can't drift.

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
  forkTarget: null,        // session object we were told to hop to
}

export function addEvent(events, event) {
  if (!event) return events
  if (events.some((e) => e.id === event.id)) return events
  return [...events, event]
}

export function sessionReducer(state, msg) {
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
      return { ...state, streaming: { ...current, text: current.text + msg.delta }, activeTool: null }
    }
    case 'agent_tool':
      return {
        ...state,
        events: addEvent(state.events, msg.event),
        activeTool: msg.phase === 'call' ? { tool: msg.tool, query: msg.event?.content } : null,
      }
    case 'agent_done':
      return { ...state, streaming: null, activeTool: null, events: addEvent(state.events, msg.event) }
    case 'agent_paused':
      return { ...state, status: 'paused', notice: msg.by ? `${msg.by.name} paused the agent` : 'Agent paused' }
    case 'agent_resumed':
      return { ...state, notice: msg.by ? `${msg.by.name} resumed the agent` : 'Agent resumed' }
    case 'agent_error':
      return { ...state, notice: msg.error, streaming: null, activeTool: null }
    case 'agent_notice':
      return { ...state, notice: msg.notice }
    case 'session_forked':
      return {
        ...state,
        notice: `${msg.by?.name || 'Someone'} forked this session → "${msg.newSession?.name}"`,
        forkTarget: msg.by?.id && state.you?.id === msg.by.id ? msg.newSession : state.forkTarget,
      }
    case 'local_notice':
      return { ...state, notice: msg.notice }
    case 'clear_notice':
      return { ...state, notice: null }
    case 'clear_fork':
      return { ...state, forkTarget: null }
    default:
      return state
  }
}
