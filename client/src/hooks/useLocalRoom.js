// Static mode: a room over the encrypted relay with the agent (or the agent
// team) running in the host tab. The room itself lives in localRoom.js; this
// hook owns the React state and hands the room a dispatch.
//
//   useLocalRoom(code, name, { apiKey, preferHost, resume })
//     preferHost — this tab just created (or forked) the room: host from storage at once.
//     resume     — re-entering a room route (refresh, Back/Forward): when this browser
//                  saved the room, give a live host ~2.5 s to answer, then host from
//                  storage; otherwise join like anyone else. Wins over preferHost.
import { useEffect, useReducer, useRef, useCallback, useMemo, useState } from 'react'
import { HUMAN_COLORS } from '@shared/palette.js'
import { sessionReducer, initialSessionState } from './sessionReducer.js'
import { openLocalRoom } from './localRoom.js'

export { generateRoomCode, loadRoom, saveRoom, createLocalRoom } from './localRoom.js'
export { sanitizeConfig } from './teamRoom.js'

// Per page-load identity. Deliberately NOT sessionStorage: browsers copy
// sessionStorage into a duplicated/reopened tab, which would make two tabs
// share one id and both end up hosting the same room.
const TAB_ID = `u_${(globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 8)}`

// This tab's id before a reload, read once and cleared (so a tab duplicated
// later doesn't claim it). Peers retire that entry if its goodbye was lost,
// as it often is on phones, instead of listing the person twice.
const PREV_TAB_KEY = 'hivemind:prev-tab'
const PREV_TAB_ID = (() => {
  try {
    const prev = sessionStorage.getItem(PREV_TAB_KEY)
    sessionStorage.removeItem(PREV_TAB_KEY)
    return prev && prev !== TAB_ID ? prev : null
  } catch { return null }
})()
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { try { sessionStorage.setItem(PREV_TAB_KEY, TAB_ID) } catch { /* storage off */ } })
}

function connected(ref) {
  if (!ref.current) throw new Error('Not connected to the room yet.')
  return ref.current
}

function colorFor(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUMAN_COLORS[h % HUMAN_COLORS.length]
}

export function useLocalRoom(roomCode, userName, { apiKey = null, preferHost = false, resume = false } = {}) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState)
  const you = useMemo(() => ({ id: TAB_ID, name: userName, color: colorFor(TAB_ID) }), [userName])
  const roomRef = useRef(null)
  const [relays, setRelays] = useState(null) // null until the first status report
  const [isHost, setIsHost] = useState(false)
  // The key can change while the room is open; the room reads it per call.
  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey

  useEffect(() => {
    if (!roomCode || !userName) return undefined
    setRelays(null)
    setIsHost(false)
    const room = openLocalRoom({
      code: roomCode,
      you,
      dispatch,
      getApiKey: () => apiKeyRef.current,
      preferHost: Boolean(preferHost),
      resume: Boolean(resume),
      replaces: PREV_TAB_ID,
      onStatus: ({ relays: n }) => setRelays(n),
      onRole: setIsHost,
    })
    roomRef.current = room
    return () => {
      room.close()
      if (roomRef.current === room) roomRef.current = null
    }
  }, [roomCode, userName, you, preferHost, resume])

  const sendMessage = useCallback(async (content) => connected(roomRef).sendMessage(content), [])
  const act = useCallback(async (action, extra = {}) => connected(roomRef).act(action, extra), [])
  const setTyping = useCallback((isTyping) => { roomRef.current?.setTyping(isTyping) }, [])
  const clearNotice = useCallback(() => dispatch({ type: 'clear_notice' }), [])
  const clearFork = useCallback(() => dispatch({ type: 'clear_fork' }), [])
  const notify = useCallback((notice) => dispatch({ type: 'local_notice', notice }), [])

  return { ...state, you, relays, isHost, sendMessage, act, setTyping, clearNotice, clearFork, notify }
}
