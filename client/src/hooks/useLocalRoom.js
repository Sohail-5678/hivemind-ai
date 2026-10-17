// Static mode: multiplayer rooms over an encrypted multi-relay transport
// (lib/relay.js: any device, any network; BroadcastChannel for same-browser tabs),
// with the agent engine running in the host tab. Emits the SAME message shapes
// as the Node server so the UI, reducer, and workspace are shared verbatim.
//
// Host model: the creator hosts. Every tab mirrors the full timeline, so if
// the host tab closes, the remaining tab with the lowest id takes over.
// Late joiners get a snapshot (timeline + in-flight run text) from the host.
import { useEffect, useReducer, useRef, useCallback, useMemo } from 'react'
import { sessionReducer, initialSessionState } from './sessionReducer'
import { runClientAgent, buildMessages } from '../agent/clientAgent'
import { openRoomChannel } from '../lib/relay'

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const PALETTE = ['#4F8FE8', '#E85D55', '#9DB8FF', '#DE1110', '#7B61FF', '#2BB3A3', '#F0A23B', '#C56BD6']
const AGENT = { id: 'agent', name: 'HiveMind', color: '#255DCE' }
const HEARTBEAT_MS = 2000
const PEER_TTL_MS = 7000
const SNAPSHOT_WAIT_MS = 5000      // joiner waits this long (after a relay connects) for a live host
const HELLO_RETRY_MS = 1500
const SNAPSHOT_MAX_EVENTS = 120    // keeps snapshot frames well under public-relay size limits
const FLUSH_MS = 60
const MAX_MESSAGE_CHARS = 4000
const MAX_REDIRECT_CHARS = 500
const RATE_LIMIT = { windowMs: 60_000, max: 20 }

export function generateRoomCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return code
}

function storageKey(code) { return `hivemind:room:${String(code).toUpperCase()}` }

export function loadRoom(code) {
  try {
    const raw = localStorage.getItem(storageKey(code))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function saveRoom(code, room) {
  try { localStorage.setItem(storageKey(code), JSON.stringify(room)) } catch { /* quota / private mode */ }
}

let eventCounter = 0
function mkEvent(sessionId, type, author, content = null, meta = null) {
  return {
    id: `${Date.now().toString(36)}-${(eventCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId, type, author, content, meta,
    createdAt: new Date().toISOString(),
  }
}

// Creates a room in this browser (persisted) and returns its session.
export function createLocalRoom({ name, mode = 'live', provider = 'simulated', model = null, forkedFrom = null, events = [] }) {
  const code = generateRoomCode()
  const session = {
    id: `local_${code}`, name, mode, status: 'idle', provider, model,
    roomCode: code, forkedFrom, createdAt: new Date().toISOString(), local: true,
  }
  const seeded = [...events, mkEvent(session.id, 'system', null, forkedFrom ? `Forked into "${name}".` : `Session "${name}" created.`)]
  saveRoom(code, { session, events: seeded, status: 'idle' })
  return session
}

// Per page-load identity. Deliberately NOT sessionStorage: browsers copy
// sessionStorage into a duplicated/reopened tab, which would make two tabs
// share one id and both end up hosting the same room.
const TAB_ID = `u_${(globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 8)}`
function tabIdentity() { return TAB_ID }

function colorFor(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

export function useLocalRoom(roomCode, userName, { apiKey = null, preferHost = false } = {}) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState)
  const you = useMemo(() => {
    const id = tabIdentity()
    return { id, name: userName, color: colorFor(id) }
  }, [userName])

  // Refs shared across the channel lifecycle.
  const chanRef = useRef(null)
  const hostRef = useRef(false)
  const sessionRef = useRef(null)
  const eventsRef = useRef([])
  const statusRef = useRef('idle')
  const peersRef = useRef(new Map())
  const runRef = useRef(null)
  const typingRef = useRef(false)
  const hostSeenRef = useRef(false)
  const hostApiRef = useRef(null)
  const pendingRef = useRef([]) // non-host actions awaiting a host ack
  const relaysRef = useRef(0)   // relays currently connected (for error copy)
  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey

  useEffect(() => { eventsRef.current = state.events }, [state.events])
  useEffect(() => { statusRef.current = state.status }, [state.status])
  useEffect(() => { if (state.session) sessionRef.current = state.session }, [state.session])

  // Persist whenever the host's view of the room changes.
  useEffect(() => {
    if (hostRef.current && sessionRef.current && roomCode) {
      saveRoom(roomCode, { session: sessionRef.current, events: state.events, status: state.status })
    }
  }, [state.events, state.status, roomCode])

  useEffect(() => {
    if (!roomCode || !userName) return undefined
    const code = String(roomCode).toUpperCase()
    const guard = { closed: false, timers: [] }
    let onFrame = () => {}
    const chan = openRoomChannel(code, {
      onMessage: (data) => onFrame({ data }),
      onStatus: ({ relays }) => { relaysRef.current = relays },
    })
    chanRef.current = chan
    hostRef.current = false
    hostSeenRef.current = false
    peersRef.current = new Map()
    runRef.current = null
    pendingRef.current = []
    let snapshotTimer = null
    let adopted = false

    const post = (payload) => { if (!guard.closed) chan.post(payload) }
    const participants = () => [
      { ...you, typing: typingRef.current },
      ...[...peersRef.current.values()].map((p) => ({ ...p.user, typing: p.typing })),
    ]
    const participantNames = () => participants().map((p) => p.name)
    const pushPresence = () => dispatch({ type: 'presence', participants: participants() })

    // Emit a server-shaped message: apply locally AND broadcast to peers.
    const emit = (msg) => { dispatch(msg); post({ t: 'msg', msg }) }
    const appendEvent = (type, author, content, meta) => {
      const event = mkEvent(sessionRef.current.id, type, author, content, meta)
      eventsRef.current = [...eventsRef.current, event]
      emit({ type: 'timeline_event', event })
      return event
    }
    const setStatusAll = (status) => { statusRef.current = status; emit({ type: 'session_status', status }) }

    // ---------------- Host: agent engine ----------------
    const startRun = ({ steering = null, redirected = false } = {}) => {
      if (runRef.current || !sessionRef.current) return
      const run = { id: `run_${Math.random().toString(36).slice(2, 10)}`, controller: new AbortController(), text: '', pending: '', flushTimer: null, abortReason: null, abortActor: null, followUpSteering: null, done: false }
      runRef.current = run
      setStatusAll('running')
      emit({ type: 'agent_started', runId: run.id })

      const flush = () => {
        if (!run.pending) return
        emit({ type: 'agent_token', runId: run.id, delta: run.pending })
        run.pending = ''
      }
      const onDelta = (delta) => {
        run.text += delta
        run.pending += delta
        if (!run.flushTimer) run.flushTimer = setTimeout(() => { run.flushTimer = null; flush() }, FLUSH_MS)
      }
      const onTool = (phase, { tool, content }) => {
        const event = appendEvent(phase === 'call' ? 'tool_call' : 'tool_result', AGENT, content, { tool, phase, runId: run.id })
        emit({ type: 'agent_tool', runId: run.id, tool, phase, event })
      }
      const finish = (status, extraMeta = null) => {
        if (run.done) return
        run.done = true
        if (run.flushTimer) clearTimeout(run.flushTimer)
        flush()
        runRef.current = null
        if (run.text.trim()) {
          const event = mkEvent(sessionRef.current.id, 'agent_message', AGENT, run.text, { runId: run.id, provider: sessionRef.current.provider, ...(extraMeta || {}) })
          eventsRef.current = [...eventsRef.current, event]
          emit({ type: 'agent_done', runId: run.id, event, partial: Boolean(extraMeta?.partial) })
        } else {
          emit({ type: 'agent_done', runId: run.id, event: null, partial: Boolean(extraMeta?.partial) })
        }
        setStatusAll(status)
      }

      const session = sessionRef.current
      const messages = buildMessages({ sessionName: session.name, participantNames: participantNames(), events: eventsRef.current, steering })
      runClientAgent({
        provider: session.provider, model: session.model, apiKey: apiKeyRef.current, messages, redirected,
        signal: run.controller.signal, onDelta, onTool,
        onNotice: (notice) => emit({ type: 'agent_notice', notice }),
      })
        .then(() => finish('idle'))
        .catch((err) => {
          if (err?.name === 'AbortError' || run.controller.signal.aborted) {
            const reason = run.abortReason || 'stop'
            if (reason === 'demoted') {
              // Another tab is the rightful host — drop this run silently so we
              // don't broadcast status/partials over the surviving host's run.
              run.done = true
              if (run.flushTimer) clearTimeout(run.flushTimer)
              runRef.current = null
            } else if (reason === 'pause') {
              finish('paused', run.text.trim() ? { partial: true, reason: 'paused' } : null)
              emit({ type: 'agent_paused', by: run.abortActor || null })
            } else if (reason === 'redirect') {
              finish('idle', run.text.trim() ? { partial: true, reason: 'redirected' } : null)
              if (run.followUpSteering && !guard.closed) startRun({ steering: run.followUpSteering, redirected: true })
            } else {
              finish('idle', run.text.trim() ? { partial: true, reason: 'stopped' } : null)
            }
          } else {
            finish('idle', run.text.trim() ? { partial: true, reason: 'error' } : null)
            appendEvent('system', null, `Agent error: ${String(err?.message || err).slice(0, 200)}`)
            emit({ type: 'agent_error', error: 'The agent hit an error and stopped. Send another message to retry.' })
          }
        })
    }

    const abortRun = (reason, actor) => {
      const run = runRef.current
      if (!run) return false
      run.abortReason = reason
      run.abortActor = actor
      run.controller.abort()
      return true
    }

    // Split-brain guard: if two tabs ever both believe they host (throttled
    // background tab, race during takeover), the lowest id wins and the other
    // demotes itself and re-syncs from the survivor's snapshot.
    const demote = () => {
      if (!hostRef.current) return
      abortRun('demoted', null)
      hostRef.current = false
      adopted = false
      post({ t: 'hello', user: you })
    }

    // ---------------- Host: actions ----------------
    const rate = new Map()
    const rateLimited = (key) => {
      const now = Date.now()
      const bucket = (rate.get(key) || []).filter((t) => now - t < RATE_LIMIT.windowMs)
      if (bucket.length >= RATE_LIMIT.max) { rate.set(key, bucket); return true }
      bucket.push(now)
      rate.set(key, bucket)
      return false
    }

    const hostHandle = (action, payload, from) => {
      if (!hostRef.current || !sessionRef.current) return
      if (action === 'message') {
        if (rateLimited(`msg:${from.id}`)) { if (from.id === you.id) dispatch({ type: 'local_notice', notice: 'Rate limit hit — max 20 messages per minute.' }); return }
        const content = String(payload?.content || '').trim().slice(0, MAX_MESSAGE_CHARS)
        if (!content) return
        const event = appendEvent('user_message', from, content)
        emit({ type: 'user_message', event })
        if (!runRef.current && statusRef.current !== 'paused') startRun()
        return
      }
      if (action === 'redirect') {
        const instruction = String(payload?.content || '').trim().slice(0, MAX_REDIRECT_CHARS)
        if (!instruction) return
        const event = appendEvent('redirect', from, instruction)
        emit({ type: 'user_redirected', event, by: from, instruction })
        const run = runRef.current
        if (run) {
          run.followUpSteering = `[${from.name} redirected you mid-run]: ${instruction}. Drop your previous direction and follow this immediately.`
          abortRun('redirect', from)
        } else {
          startRun({ steering: `[${from.name} redirected you]: ${instruction}. Follow this new direction.`, redirected: true })
        }
        return
      }
      if (action === 'pause') {
        const wasRunning = abortRun('pause', from)
        appendEvent('pause', from)
        if (!wasRunning) { setStatusAll('paused'); emit({ type: 'agent_paused', by: from }) }
        return
      }
      if (action === 'resume') {
        appendEvent('resume', from)
        emit({ type: 'agent_resumed', by: from })
        setStatusAll('idle')
        startRun({ steering: `[${from.name} resumed the session]: Continue exactly where you left off. If your last message was cut off mid-thought, finish it, then keep going.` })
        return
      }
      if (action === 'stop') {
        abortRun('stop', from)
        appendEvent('system', null, `${from.name} stopped the agent.`)
        return
      }
      if (action === 'fork') {
        // The forker already created (and will host) the new room in its own
        // browser; the original room only records that the fork happened.
        const newSession = payload?.newSession
        if (!newSession?.roomCode) return
        appendEvent('fork', from, newSession.name, { forkedSessionId: newSession.id })
        emit({ type: 'session_forked', newSession, by: from })
      }
    }

    // ---------------- Membership ----------------
    const becomeHost = (room, { takeover = false } = {}) => {
      hostRef.current = true
      hostSeenRef.current = true
      sessionRef.current = room.session
      eventsRef.current = room.events || []
      statusRef.current = room.status === 'paused' ? 'paused' : 'idle'
      dispatch({ type: 'joined', session: room.session, you, events: eventsRef.current, participants: participants(), agentStatus: statusRef.current, streaming: null })
      const joinEvent = appendEvent('join', you)
      if (takeover) appendEvent('system', null, `${you.name}'s tab took over hosting this session.`)
      // Replay anything this tab sent while no host was listening.
      const pending = pendingRef.current
      pendingRef.current = []
      for (const p of pending) hostHandle(p.action, p.payload, you)
      return joinEvent
    }

    const electIfHostless = () => {
      if (hostRef.current || !hostSeenRef.current || !sessionRef.current) return
      const anyHost = [...peersRef.current.values()].some((p) => p.host)
      if (anyHost) return
      const ids = [you.id, ...peersRef.current.keys()].sort()
      if (ids[0] !== you.id) return
      // The previous host's run died with its tab — mirror that state honestly.
      becomeHost({ session: sessionRef.current, events: eventsRef.current, status: statusRef.current === 'running' ? 'idle' : statusRef.current }, { takeover: true })
      emit({ type: 'session_status', status: statusRef.current })
      emit({ type: 'agent_done', runId: 'lost', event: null, partial: true })
    }

    onFrame = ({ data }) => {
      if (guard.closed || !data || typeof data.t !== 'string') return
      const { t } = data

      if (t === 'hello') {
        const user = data.user
        if (!user?.id || user.id === you.id) return
        const known = peersRef.current.has(user.id)
        peersRef.current.set(user.id, { user, lastSeen: Date.now(), typing: false, host: false })
        post({ t: 'heartbeat', user: you, typing: typingRef.current, host: hostRef.current })
        if (hostRef.current && sessionRef.current) {
          const run = runRef.current
          post({
            t: 'snapshot', to: user.id, session: sessionRef.current, events: eventsRef.current.slice(-SNAPSHOT_MAX_EVENTS),
            participants: participants(), agentStatus: run ? 'running' : statusRef.current,
            // Exclude text still sitting in run.pending — it arrives via the next agent_token flush.
            streaming: run ? { runId: run.id, text: run.text.slice(0, run.text.length - run.pending.length) } : null,
          })
          if (!known) appendEvent('join', user) // hello is retried; log the join once
        }
        pushPresence()
        return
      }
      if (t === 'snapshot') {
        if (data.to !== you.id || adopted) return
        adopted = true
        if (snapshotTimer) clearTimeout(snapshotTimer)
        hostSeenRef.current = true
        sessionRef.current = data.session
        eventsRef.current = data.events || []
        statusRef.current = data.agentStatus === 'running' ? 'running' : data.agentStatus || 'idle'
        dispatch({ type: 'joined', session: data.session, you, events: data.events, participants: participants(), agentStatus: data.agentStatus, streaming: data.streaming })
        return
      }
      if (t === 'heartbeat' || t === 'typing') {
        const user = data.user
        if (!user?.id || user.id === you.id) return
        const existing = peersRef.current.get(user.id)
        peersRef.current.set(user.id, { user, lastSeen: Date.now(), typing: Boolean(data.typing), host: t === 'heartbeat' ? Boolean(data.host) : existing?.host || false })
        if (data.host) hostSeenRef.current = true
        if (t === 'heartbeat' && data.host && hostRef.current && user.id < you.id) demote()
        pushPresence()
        return
      }
      if (t === 'ack') {
        if (data.to === you.id) pendingRef.current = pendingRef.current.filter((p) => p.id !== data.id)
        return
      }
      if (t === 'bye') {
        const id = data.user?.id
        if (!id) return
        const peer = peersRef.current.get(id)
        peersRef.current.delete(id)
        if (hostRef.current && peer) appendEvent('leave', peer.user)
        pushPresence()
        electIfHostless()
        return
      }
      if (t === 'action') {
        if (hostRef.current) {
          hostHandle(data.action, data.payload, data.from)
          if (data.id) post({ t: 'ack', id: data.id, to: data.from?.id })
        }
        return
      }
      if (t === 'msg') {
        const msg = data.msg
        if (!msg) return
        // Mirror the host's state so a takeover can continue from here.
        if (msg.type === 'timeline_event' || msg.type === 'user_message' || msg.type === 'user_redirected' || msg.type === 'agent_tool' || msg.type === 'agent_done') {
          if (msg.event && !eventsRef.current.some((e) => e.id === msg.event.id)) eventsRef.current = [...eventsRef.current, msg.event]
        }
        if (msg.type === 'session_status') statusRef.current = msg.status
        if (msg.type === 'agent_started') statusRef.current = 'running'
        dispatch(msg)
      }
    }

    // Join: the creator hosts straight from local storage. A joiner waits for a
    // relay, announces itself (retrying, since frames can race the subscription),
    // and adopts the host's snapshot; with no live host it falls back to storage.
    dispatch({ type: 'connection', value: 'connecting' })
    const fallbackToStorage = () => {
      if (guard.closed || adopted) return
      const room = loadRoom(code)
      if (room?.session) {
        adopted = true
        becomeHost(room)
      } else {
        dispatch({ type: 'connection', value: 'error', error: preferHost
          ? 'That room isn\u2019t saved in this browser any more. Create a new session, or join with the code from a device where it\u2019s open.'
          : relaysRef.current > 0
            ? 'No live room found for that code. Check the code, and make sure the person who created the room still has it open — the room lives in the creator\u2019s browser.'
            : 'Couldn\u2019t reach the real-time relays from this network, so only rooms opened in this browser are visible. Try another network (or mobile data) and join again.' })
      }
    }
    if (preferHost) {
      fallbackToStorage()
    } else {
      chan.ready.then(() => {
        if (guard.closed || adopted) return
        post({ t: 'hello', user: you })
        const retry = setInterval(() => {
          if (guard.closed || adopted) { clearInterval(retry); return }
          post({ t: 'hello', user: you })
        }, HELLO_RETRY_MS)
        guard.timers.push(retry)
        snapshotTimer = setTimeout(() => { clearInterval(retry); fallbackToStorage() }, SNAPSHOT_WAIT_MS)
      })
    }

    const heartbeat = setInterval(() => {
      post({ t: 'heartbeat', user: you, typing: typingRef.current, host: hostRef.current })
      const now = Date.now()
      let changed = false
      for (const [id, peer] of peersRef.current) {
        if (now - peer.lastSeen > PEER_TTL_MS) {
          peersRef.current.delete(id)
          changed = true
          if (hostRef.current) appendEvent('leave', peer.user)
        }
      }
      if (changed) { pushPresence(); electIfHostless() }
      // Actions that never got a host ack while a host looked alive are truly lost — say so.
      if (!hostRef.current && pendingRef.current.length) {
        const stale = pendingRef.current.filter((p) => now - p.at > PEER_TTL_MS)
        if (stale.length && [...peersRef.current.values()].some((p) => p.host)) {
          pendingRef.current = pendingRef.current.filter((p) => now - p.at <= PEER_TTL_MS)
          dispatch({ type: 'local_notice', notice: 'Your last action didn’t reach the host tab — please try again.' })
        }
      }
    }, HEARTBEAT_MS)
    guard.timers.push(heartbeat)

    // Expose host actions to the public API via a ref.
    hostApiRef.current = { hostHandle, post, abortRun }

    const onUnload = () => chan.postNow({ t: 'bye', user: you })
    window.addEventListener('beforeunload', onUnload)
    // A tab coming back from the background re-announces immediately so peers
    // don't mistake a throttled heartbeat for a dead host.
    const onVisible = () => { if (document.visibilityState === 'visible') post({ t: 'heartbeat', user: you, typing: typingRef.current, host: hostRef.current }) }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      guard.closed = true
      clearInterval(heartbeat)
      for (const t of guard.timers) clearInterval(t)
      if (snapshotTimer) clearTimeout(snapshotTimer)
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onVisible)
      if (runRef.current) { try { runRef.current.controller.abort() } catch { /* fine */ } }
      chan.post({ t: 'bye', user: you })
      chan.close()
      chanRef.current = null
      hostApiRef.current = null
    }
  }, [roomCode, userName, you, preferHost])

  const dispatchAction = useCallback((action, payload = {}) => {
    const api = hostApiRef.current
    if (!api) throw new Error('Not connected to the room yet.')
    let forked = null
    if (action === 'fork') {
      // Create the fork HERE, from this tab's mirrored timeline, so it exists
      // (and is hosted) in the forker's own browser — not the original host's.
      const source = sessionRef.current
      if (!source) throw new Error('Not connected to the room yet.')
      forked = createLocalRoom({
        name: `${source.name} (fork)`, mode: source.mode, provider: source.provider, model: source.model,
        forkedFrom: source.id, events: eventsRef.current.map((e) => ({ ...e, sessionId: null })),
      })
      payload = { newSession: forked }
    }
    if (hostRef.current) {
      api.hostHandle(action, payload, you)
    } else {
      // Remember it until a host acks; replayed if this tab becomes host.
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      pendingRef.current.push({ id, action, payload, at: Date.now() })
      api.post({ t: 'action', id, action, payload, from: you })
      // Hop into our own fork now; don't wait for the host's echo.
      if (forked) dispatch({ type: 'session_forked', newSession: forked, by: you })
    }
    return { ok: true }
  }, [you])

  const sendMessage = useCallback(async (content) => {
    const text = String(content || '').trim()
    if (!text) throw new Error('Message is empty.')
    if (text.length > MAX_MESSAGE_CHARS) throw new Error('Message too long (max 4000 chars).')
    return dispatchAction('message', { content: text })
  }, [dispatchAction])

  const act = useCallback(async (action, extra = {}) => {
    if (action === 'redirect') {
      const instruction = String(extra.content || '').trim()
      if (!instruction) throw new Error('Redirect needs an instruction.')
      if (instruction.length > MAX_REDIRECT_CHARS) throw new Error('Redirect too long (max 500 chars).')
    }
    return dispatchAction(action, extra)
  }, [dispatchAction])

  const setTyping = useCallback((isTyping) => {
    typingRef.current = Boolean(isTyping)
    const api = hostApiRef.current
    if (api) api.post({ t: 'typing', user: you, typing: typingRef.current })
  }, [you])

  const clearNotice = useCallback(() => dispatch({ type: 'clear_notice' }), [])
  const clearFork = useCallback(() => dispatch({ type: 'clear_fork' }), [])
  const notify = useCallback((notice) => dispatch({ type: 'local_notice', notice }), [])

  return { ...state, you, isHost: hostRef.current, sendMessage, act, setTyping, clearNotice, clearFork, notify }
}
