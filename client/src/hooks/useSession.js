// Server mode: session state over a WebSocket to the Node server.
// Reconnects with backoff; every (re)join gets a full snapshot from the server.
import { useEffect, useReducer, useRef, useCallback } from 'react'
import { DEFAULT_HUMAN_COLOR } from '@shared/palette.js'
import { api, wsUrl } from '../lib/api'
import { sessionReducer, initialSessionState } from './sessionReducer'

const TEAM_ACTIONS = new Set(['pin', 'vote', 'escalation', 'set_config'])

// A refresh keeps who you are: the server's leave grace then sees the same
// user id come back and writes no "left" / "joined" pair. Written only on
// pagehide and read once, so a duplicated tab (which copies sessionStorage
// at that moment) never shares an id with the tab it came from.
const PREV_USER_KEY = 'hivemind_prev_user'
const PREV_USER = (() => {
  try {
    const raw = sessionStorage.getItem(PREV_USER_KEY)
    sessionStorage.removeItem(PREV_USER_KEY)
    const prev = raw ? JSON.parse(raw) : null
    return prev && typeof prev.sessionId === 'string' && typeof prev.id === 'string' ? prev : null
  } catch { return null }
})()
let current = null // { sessionId, id, color } of the room this tab is in
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    try { if (current) sessionStorage.setItem(PREV_USER_KEY, JSON.stringify(current)) } catch { /* storage off */ }
  })
}

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
    if (!youRef.current && PREV_USER?.sessionId === sessionId) youRef.current = { id: PREV_USER.id, color: PREV_USER.color }

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
        if (msg.type === 'joined') {
          youRef.current = msg.you
          current = { sessionId, id: msg.you.id, color: msg.you.color }
        }
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

    // On a microtask, like the static room: React StrictMode's throwaway mount
    // in development is cleaned up first, so it never opens a socket.
    queueMicrotask(connect)

    return () => {
      guard.closed = true
      if (current?.sessionId === sessionId) current = null
      if (guard.timer) clearTimeout(guard.timer)
      const ws = guard.ws
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'leave' })) } catch { /* fine */ }
      }
      try { ws?.close() } catch { /* fine */ }
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [sessionId, userName])

  const you = state.you || { id: null, name: userName, color: DEFAULT_HUMAN_COLOR }

  // Extras ride along (apiKey; kind/content for a pin, option for a vote,
  // escalationId/decision, config, pattern) but can never replace who is acting.
  const sendMessage = useCallback(async (content, extra = {}) => {
    await api.sendMessage(sessionId, { ...extra, content, user: youRef.current || { name: userName } })
  }, [sessionId, userName])

  const act = useCallback(async (action, extra = {}) => {
    const res = await api.action(sessionId, { ...extra, action, user: youRef.current || { name: userName } })
    // The server answers a refused team action (no open vote, an escalation
    // already decided) in the body, and ignores a pin the board already has.
    // Throw like the static room does, so each control shows why.
    if (TEAM_ACTIONS.has(action) && res?.ok === false) throw new Error(res.error || 'That didn’t go through. Try again.')
    if (action === 'pin' && res?.added === false) throw new Error('That’s already on the board.')
    return res
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
