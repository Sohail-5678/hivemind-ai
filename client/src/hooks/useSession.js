// Server mode: session state over a WebSocket to the Node server.
// Reconnects with backoff; every (re)join gets a full snapshot from the server.
import { useEffect, useReducer, useRef, useCallback } from 'react'
import { api, wsUrl } from '../lib/api'
import { sessionReducer, initialSessionState } from './sessionReducer'

export function useSession(sessionId, userName) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState)
  const wsRef = useRef(null)
  const youRef = useRef(null)

  useEffect(() => {
    if (!sessionId || !userName) return undefined
    // Each effect run gets its OWN guard object. Closures below capture it, so
    // a socket from a previous session (fork hop) can never schedule a
    // reconnect against the new session or clobber wsRef after cleanup.
    const guard = { attempt: 0, timer: null, closed: false, ws: null }

    const connect = () => {
      if (guard.closed) return
      dispatch({ type: 'connection', value: 'connecting' })
      const ws = new WebSocket(wsUrl())
      guard.ws = ws
      wsRef.current = ws

      ws.onopen = () => {
        if (guard.closed) { try { ws.close() } catch { /* fine */ } return }
        guard.attempt = 0
        ws.send(JSON.stringify({
          type: 'join',
          sessionId,
          user: { name: userName, id: youRef.current?.id, color: youRef.current?.color },
        }))
      }
      ws.onmessage = (raw) => {
        if (guard.closed) return
        let msg
        try { msg = JSON.parse(raw.data) } catch { return }
        if (msg.type === 'joined') youRef.current = msg.you
        if (msg.type === 'error' && msg.error === 'session_not_found') {
          dispatch({ type: 'connection', value: 'error', error: 'This session no longer exists.' })
          guard.closed = true
          try { ws.close() } catch { /* fine */ }
          return
        }
        dispatch(msg)
      }
      ws.onclose = () => {
        if (guard.closed) return
        dispatch({ type: 'connection', value: 'closed' })
        guard.attempt = Math.min(guard.attempt + 1, 6)
        guard.timer = setTimeout(connect, 500 * 2 ** (guard.attempt - 1))
      }
      ws.onerror = () => { try { ws.close() } catch { /* already closed */ } }
    }

    connect()

    return () => {
      guard.closed = true
      if (guard.timer) clearTimeout(guard.timer)
      const ws = guard.ws
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'leave' })) } catch { /* fine */ }
      }
      try { ws?.close() } catch { /* fine */ }
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [sessionId, userName])

  const you = state.you || { id: null, name: userName, color: '#255DCE' }

  const sendMessage = useCallback(async (content, extra = {}) => {
    await api.sendMessage(sessionId, { content, user: youRef.current || { name: userName }, ...extra })
  }, [sessionId, userName])

  const act = useCallback(async (action, extra = {}) => {
    return api.action(sessionId, { action, user: youRef.current || { name: userName }, ...extra })
  }, [sessionId, userName])

  const setTyping = useCallback((isTyping) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'typing', isTyping })) } catch { /* fine */ }
    }
  }, [])

  const clearNotice = useCallback(() => dispatch({ type: 'clear_notice' }), [])
  const clearFork = useCallback(() => dispatch({ type: 'clear_fork' }), [])
  const notify = useCallback((notice) => dispatch({ type: 'local_notice', notice }), [])

  return { ...state, you, sendMessage, act, setTyping, clearNotice, clearFork, notify }
}
