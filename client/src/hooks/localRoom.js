// Static mode room core: multiplayer rooms over an encrypted multi-relay
// transport (lib/relay.js: any device, any network; BroadcastChannel for
// same-browser tabs), with the agent (or the whole agent team) running in the
// host tab. Emits the SAME message shapes as the Node server, so the UI,
// reducer, and workspace are shared verbatim. No React in here: useLocalRoom
// is a thin wrapper, and the Node checks drive this module directly.
//
// Host model: the creator hosts. Every tab mirrors the timeline, the session
// and the team view, so if the host tab closes, the remaining tab with the
// lowest id takes over and closes any run that died with the old host.
// Late joiners get a snapshot (timeline + in-flight run state) from the host,
// and a tab that lost frames on every relay asks for a fresh one.
import { runClientAgent, buildMessages, makeClientLLM } from '../agent/clientAgent.js'
import { openRoomChannel } from '../lib/relay.js'
import { createSwarmRun } from '@shared/swarm/engine.js'
import { SWARM_MESSAGE_TYPES, reduceSwarmView, interruptedDone, compactSwarmView } from '@shared/swarm/view.js'
import { BOARD_KINDS, addItem, emptyBoard, normalizeBoard } from '@shared/swarm/blackboard.js'
import { PATTERN_ORDER } from '@shared/swarm/patterns.js'
import { AGENT_COLOR } from '@shared/palette.js'
import {
  sanitizeConfig, mergeConfig, sameConfig, configLabel, patternName, perCallSeconds, runWatchdogMs,
  continueGoal, latestUserMessage, teamHistory, teamDirectives, unseenMessages, mergeEvents,
  buildSnapshot, flagInjection,
} from './teamRoom.js'
import { markFinal } from './sessionReducer.js'

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const AGENT = { id: 'agent', name: 'HiveMind', color: AGENT_COLOR }
const HEARTBEAT_MS = 2000
const PEER_TTL_MS = 20000         // background tabs heartbeat slowly; a real close sends "bye" at once
const SNAPSHOT_WAIT_MS = 8000      // joiner waits this long (after a relay connects) for a live host
const RESUME_WAIT_MS = 2500        // a refreshed creator tab waits this long before hosting from storage
const RESUME_RELAY_GRACE_MS = 1500 // ...plus up to this while the relays are still connecting
const HELLO_RETRY_MS = 1500
const EARLY_FRAMES_LIMIT = 600     // host frames held while a snapshot is on its way
const HANDLED_LIMIT = 5000         // action ids remembered, so a re-sent action runs once
const GONE_LIMIT = 50              // departed peers remembered for a reload after a takeover
const LEAVE_GRACE_MS = 8000        // a page that closed (maybe a refresh) gets this long to come back
const FLUSH_MS = 60
const TEAM_FLUSH_MS = 150
const SINGLE_RUN_TIMEOUT_MS = 180_000 // above the free tier's worst case: two cooldowns plus a 45 s queue
const MAX_MESSAGE_CHARS = 4000
const MAX_REDIRECT_CHARS = 500
const MAX_PIN_CHARS = 200
const MAX_NAME_CHARS = 40
const RATE_LIMIT = { windowMs: 60_000, messages: 20, actions: 30 }
const STORED_EVENTS_FALLBACK = 300 // what survives when the full record exceeds the storage quota
const ESCALATION_EXTRA_CALLS = 4   // the engine grants this many calls on "continue"
const EVENT_CARRIERS = new Set(['timeline_event', 'user_message', 'user_redirected', 'agent_tool', 'agent_done'])
const PERSIST_ON = new Set([...EVENT_CARRIERS, 'session_status', 'session_config', 'blackboard', 'swarm_final', 'swarm_done'])
const OUTCOME = { pause: 'paused', stop: 'stopped', redirect: 'redirected', timeout: 'timeout', lost: 'lost' }
const DUPLICATE_PIN = 'That’s already on the board.'

// ---------------------------------------------------------------- storage

// The code is the room's only secret (it keys the relay encryption), so it
// comes from the crypto RNG. Bytes past the last whole multiple of the
// alphabet are redrawn, so every letter is equally likely.
export function generateRoomCode() {
  const limit = 256 - (256 % CODE_ALPHABET.length)
  let code = ''
  while (code.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < limit && code.length < 6) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
    }
  }
  return code
}

const ROOM_KEY_PREFIX = 'hivemind:room:'
function storageKey(code) { return `${ROOM_KEY_PREFIX}${String(code).toUpperCase()}` }

export function loadRoom(code) {
  try {
    const raw = localStorage.getItem(storageKey(code))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function trySave(key, record) {
  try { localStorage.setItem(key, JSON.stringify(record)); return true } catch { return false }
}

// Every room this browser saved except `keep`, least recently saved first.
function oldRoomKeys(keep) {
  const rooms = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || key === keep || !key.startsWith(ROOM_KEY_PREFIX)) continue
      let at = 0
      try {
        const room = JSON.parse(localStorage.getItem(key))
        at = Number(room?.savedAt) || Date.parse(room?.session?.createdAt) || 0
      } catch { /* unreadable: evict first */ }
      rooms.push({ key, at })
    }
  } catch { return [] }
  return rooms.sort((a, b) => a.at - b.at).map((r) => r.key)
}

// Returns false when the browser refuses (storage off, or full even after
// cleanup). When the origin's quota is full, the rooms this browser saved
// least recently are dropped first; if the record still doesn't fit, the
// newest history is kept rather than the record going stale.
export function saveRoom(code, room) {
  const key = storageKey(code)
  const record = { ...room, savedAt: Date.now() }
  if (trySave(key, record)) return true
  for (const old of oldRoomKeys(key)) {
    try { localStorage.removeItem(old) } catch { break }
    if (trySave(key, record)) return true
  }
  return trySave(key, { ...record, events: (room.events || []).slice(-STORED_EVENTS_FALLBACK) })
}

const STORAGE_FULL = 'This browser couldn’t save the room: its storage for this site is full or turned off. Free up some site storage, or try another browser.'
const STORAGE_FAILING = 'This browser can’t save the room right now (its storage is full), so a refresh may lose the latest messages.'

// Where rooms persist. This browser's localStorage unless a caller (the Node
// checks, which play several devices at once) brings its own.
const browserStorage = { load: loadRoom, save: saveRoom }

let eventCounter = 0
function mkEvent(sessionId, type, author, content = null, meta = null) {
  return {
    id: `${Date.now().toString(36)}-${(eventCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId, type, author, content, meta,
    createdAt: new Date().toISOString(),
  }
}

// Creates a room in this browser (persisted) and returns its session. A team
// room starts with an empty blackboard; a fork brings its source's board.
export function createLocalRoom({ name, mode = 'live', provider = 'simulated', model = null, forkedFrom = null, events = [], config = null, blackboard = null }, storage = browserStorage) {
  let code = generateRoomCode()
  for (let i = 0; i < 5 && storage.load(code); i++) code = generateRoomCode()
  const session = {
    id: `local_${code}`, name, mode, status: 'idle', provider, model,
    roomCode: code, forkedFrom, createdAt: new Date().toISOString(), local: true,
    config: sanitizeConfig(config, provider),
  }
  const seeded = [...events, mkEvent(session.id, 'system', null, forkedFrom ? `Forked into "${name}".` : `Session "${name}" created.`)]
  // The creator hosts from this record; without it the new room can't open.
  if (!storage.save(code, { session, events: seeded, status: 'idle', blackboard: blackboard ? normalizeBoard(blackboard) : emptyBoard(), swarm: null })) {
    throw new Error(STORAGE_FULL)
  }
  return session
}

// True when the timeline's latest join or leave for this person (same tab,
// or the same name from an earlier page load that never said goodbye) is a join.
function stillJoined(events, you) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if ((e.type !== 'join' && e.type !== 'leave') || !e.author) continue
    if (e.author.id === you.id || e.author.name === you.name) return e.type === 'join'
  }
  return false
}

// After a resync: the events this tab already had from before the snapshot's
// window, then the snapshot's own (authoritative) list.
function keepOlder(mine, fresh) {
  if (!fresh.length) return mine
  const i = mine.findIndex((e) => e.id === fresh[0].id)
  return i > 0 ? [...mine.slice(0, i), ...fresh] : fresh
}

const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const actor = (user) => ({ id: String(user?.id || ''), name: cleanText(user?.name, MAX_NAME_CHARS) || 'Guest' })

// ---------------------------------------------------------------- room core

// Opens one room for one tab. `dispatch` receives server-shaped messages for
// the session reducer; `getApiKey` is read per model call; `onStatus` gets the
// relay count and `onRole(isHost)` every hosting change. `storage` defaults to
// this browser's localStorage. `replaces` is this tab's id before a reload,
// so peers retire that entry quietly if its goodbye never arrived.
// Returns { act, sendMessage, setTyping, close, isHost }.
export function openLocalRoom({
  code: rawCode, you, dispatch, getApiKey = () => null, preferHost = false, resume = false,
  onStatus = null, onRole = null, pace = true, storage = browserStorage, replaces = null,
}) {
  const code = String(rawCode).toUpperCase()
  const guard = { closed: false, started: false, timers: new Set(), intervals: new Set() }

  // Mirrors of what the room looks like right now. Every tab keeps them in
  // step with the messages it sees, so any tab can take over hosting.
  let host = false
  let hostSeen = false
  let adopted = false
  let session = null
  let events = []
  let eventIds = new Set()
  let status = 'idle'
  let view = { swarm: null, blackboard: null }
  let run = null
  let lastGoal = ''
  let typing = false
  let relays = 0
  let relaysDropped = false
  let persistQueued = false
  let storageWarned = false
  let pending = [] // this tab's actions awaiting a host ack
  // id → { user, lastSeen, typing, host, synced (holds the room), joined (has a join line) }
  const peers = new Map()
  let chan = null
  let stopHello = () => {}
  // Resync: frames from the host can be lost on every relay at once (a phone
  // switching networks). The relay reports the gap; this tab then asks for a
  // fresh snapshot and folds in the frames that were sent after it.
  let hostSrc = null        // relay channel id of the host this tab mirrors
  let wantSnapshot = false  // adopted, but asked the host for a fresh snapshot
  let snapAt = null         // { src, seq } of the adopted snapshot: older frames are already in it
  let early = []            // host frames that arrived while a snapshot was awaited
  // Hosting term. Actions name the term of the host they're for, so a frame
  // replayed from an earlier term (or into a refreshed host) is not acted on.
  let epoch = null          // this tab's term while it hosts
  let hostEpoch = null      // the term of the host this tab follows
  const handled = new Set() // action ids already handled (acks seen from any host)
  const handledOrder = []

  const later = (fn, ms) => {
    const t = setTimeout(() => { guard.timers.delete(t); if (!guard.closed) fn() }, ms)
    guard.timers.add(t)
    return t
  }
  const cancel = (t) => { if (t) { clearTimeout(t); guard.timers.delete(t) } }
  const every = (fn, ms) => {
    const t = setInterval(() => { if (!guard.closed) fn() }, ms)
    guard.intervals.add(t)
    return t
  }
  const delay = (ms) => new Promise((resolve) => later(resolve, ms))

  const setHost = (value) => {
    if (host === value) return
    host = value
    onRole?.(value)
  }

  const post = (payload) => { if (!guard.closed && chan) chan.post(payload) }
  const beat = () => ({ t: 'heartbeat', user: you, typing, host, synced: Boolean(session), ...(host ? { epoch } : {}) })
  const hello = () => ({ t: 'hello', user: you, synced: Boolean(session), ...(replaces ? { replaces } : {}) })
  // Only tabs that hold the room count as present: one still joining, or
  // stuck on an error, isn't in presence, votes or host elections.
  const participants = () => [
    { ...you, typing },
    ...[...peers.values()].filter((p) => p.synced).map((p) => ({ ...p.user, typing: p.typing })),
  ]
  const pushPresence = () => dispatch({ type: 'presence', participants: participants() })
  const markHandled = (id) => {
    if (typeof id !== 'string' || handled.has(id)) return
    handled.add(id)
    handledOrder.push(id)
    if (handledOrder.length > HANDLED_LIMIT) handled.delete(handledOrder.shift())
  }

  const resetEvents = (list) => {
    events = Array.isArray(list) ? list : []
    eventIds = new Set(events.map((e) => e.id))
  }
  const recordEvent = (event) => {
    if (!event?.id || eventIds.has(event.id)) return
    eventIds.add(event.id)
    events = [...events, event]
  }

  // Keep the mirrors in step with a message the UI is about to show.
  const observe = (msg) => {
    if (SWARM_MESSAGE_TYPES.has(msg.type)) {
      view = reduceSwarmView(view, msg) || view
      // The approved draft becomes the answer: the saved record and every
      // snapshot carry meta.final, like the server's stored event.
      if (msg.type === 'swarm_final') events = markFinal(events, msg.eventId)
    } else if (EVENT_CARRIERS.has(msg.type)) recordEvent(msg.event)
    else if (msg.type === 'session_status') status = msg.status === 'running' ? 'running' : msg.status === 'paused' ? 'paused' : 'idle'
    else if (msg.type === 'agent_started') status = 'running'
    else if (msg.type === 'session_config' && session) session = { ...session, config: msg.config }
  }

  const record = () => ({ session, events, status, blackboard: view.blackboard, swarm: compactSwarmView(view.swarm) })
  const persistNow = () => {
    if (!host || !session) return
    const saved = storage.save(code, record())
    // Say so once per failing stretch; the room keeps working in memory.
    if (!saved && !storageWarned && !guard.closed) dispatch({ type: 'local_notice', notice: STORAGE_FAILING })
    storageWarned = !saved
  }
  // Coalesce a burst of changes (an agent message plus its board update) into one write.
  const persistSoon = () => {
    if (!host || persistQueued) return
    persistQueued = true
    queueMicrotask(() => { persistQueued = false; if (!guard.closed) persistNow() })
  }

  // Emit a server-shaped message: apply locally AND broadcast to peers.
  const emit = (msg) => {
    observe(msg)
    dispatch(msg)
    post({ t: 'msg', msg })
    if (PERSIST_ON.has(msg.type)) persistSoon()
  }
  const appendEvent = (type, author, content = null, meta = null) => {
    const event = mkEvent(session.id, type, author, content, meta)
    recordEvent(event)
    emit({ type: 'timeline_event', event })
    return event
  }
  const setStatusAll = (value) => emit({ type: 'session_status', status: value })
  const isTeam = () => session?.config?.crew === 'team'

  // Tell whoever asked why the host ignored their action.
  const reject = (from, notice) => {
    if (from?.id === you.id) dispatch({ type: 'local_notice', notice })
    else if (from?.id) post({ t: 'notice', to: from.id, notice })
  }

  // ---------------- Host: single agent ----------------
  const startSingleRun = ({ steering = null, redirected = false } = {}) => {
    const eventsAtStart = events.length
    const r = { kind: 'single', id: `run_${Math.random().toString(36).slice(2, 10)}`, controller: new AbortController(), text: '', pending: '', flushTimer: null, abortReason: null, abortActor: null, followUp: null, done: false, silent: false, watchdog: null }
    run = r
    setStatusAll('running')
    emit({ type: 'agent_started', runId: r.id })
    r.watchdog = later(() => { if (run === r) abortRun('timeout', null) }, SINGLE_RUN_TIMEOUT_MS)
    // A demoted or closing tab no longer speaks for the room, even mid-stream.
    const live = () => !r.done && !r.silent && !guard.closed

    const flush = () => {
      if (!r.pending) return
      emit({ type: 'agent_token', runId: r.id, delta: r.pending })
      r.pending = ''
    }
    const onDelta = (delta) => {
      if (!live()) return
      r.text += delta
      r.pending += delta
      if (!r.flushTimer) r.flushTimer = setTimeout(() => { r.flushTimer = null; if (live()) flush() }, FLUSH_MS)
    }
    const onTool = (phase, { tool, content }) => {
      if (!live()) return
      const event = mkEvent(session.id, phase === 'call' ? 'tool_call' : 'tool_result', AGENT, content, { tool, phase, runId: r.id })
      emit({ type: 'agent_tool', runId: r.id, tool, phase, event })
    }
    const release = () => {
      r.done = true
      cancel(r.watchdog)
      if (r.flushTimer) clearTimeout(r.flushTimer)
      if (run === r) run = null
    }
    const finish = (value, extraMeta = null) => {
      if (r.done) return
      flush()
      release()
      if (r.text.trim()) {
        const event = mkEvent(session.id, 'agent_message', AGENT, r.text, { runId: r.id, provider: session.provider, ...(extraMeta || {}) })
        emit({ type: 'agent_done', runId: r.id, event, partial: Boolean(extraMeta?.partial) })
      } else {
        emit({ type: 'agent_done', runId: r.id, event: null, partial: Boolean(extraMeta?.partial) })
      }
      setStatusAll(value)
    }

    const messages = buildMessages({ sessionName: session.name, participantNames: participants().map((p) => p.name), events, steering })
    runClientAgent({
      provider: session.provider, model: session.model, apiKey: getApiKey(), messages, redirected,
      signal: r.controller.signal, onDelta, onTool,
      onNotice: (notice, opts) => { if (live()) emit({ type: 'agent_notice', notice, progress: Boolean(opts?.progress) }) },
    })
      .then(() => {
        if (r.done) return
        if (r.silent) { release(); return }
        finish('idle')
        // Teammates may have messaged while the agent was busy — answer them
        // instead of leaving those messages silently unanswered.
        const queued = events.slice(eventsAtStart).some((e) => e.type === 'user_message')
        if (queued) later(() => { if (host && !run && status !== 'paused') startRun() }, 0)
      })
      .catch((err) => {
        if (r.done) return
        if (r.silent) { release(); return }
        if (err?.name === 'AbortError' || r.controller.signal.aborted) {
          const reason = r.abortReason || 'stop'
          if (reason === 'pause') {
            finish('paused', r.text.trim() ? { partial: true, reason: 'paused' } : null)
            emit({ type: 'agent_paused', by: r.abortActor || null })
          } else if (reason === 'redirect') {
            finish('idle', r.text.trim() ? { partial: true, reason: 'redirected' } : null)
            if (r.followUp && !guard.closed) startRun(r.followUp)
          } else if (reason === 'timeout') {
            finish('idle', r.text.trim() ? { partial: true, reason: 'timeout' } : null)
            emit({ type: 'agent_error', error: 'The run timed out and was stopped.' })
          } else {
            finish('idle', r.text.trim() ? { partial: true, reason: 'stopped' } : null)
          }
        } else {
          finish('idle', r.text.trim() ? { partial: true, reason: 'error' } : null)
          appendEvent('system', null, `Agent error: ${String(err?.message || err).slice(0, 200)}`)
          emit({ type: 'agent_error', error: 'The agent hit an error and stopped. Send another message to retry.' })
        }
      })
    return true
  }

  // ---------------- Host: agent team (contract §4) ----------------
  const armTeamWatchdog = (r, ms) => {
    cancel(r.watchdog)
    r.deadline = Date.now() + ms
    r.watchdog = later(() => { if (run === r) abortRun('timeout', null) }, ms)
  }

  // Close the team view honestly for everyone (paused / stopped / lost ...).
  const closeTeamView = (outcome) => {
    const done = interruptedDone(view.swarm, outcome)
    if (done) emit(done)
  }

  // `followUpFrom`: answer the newest message from this timeline index on once
  // the run ends, not only those written during it (a resume passes its pause).
  const startTeamRun = ({ goal, goalEventId = null, followUpFrom = null }) => {
    const text = String(goal || '').trim()
    if (!text) return false
    const config = sanitizeConfig(session.config, session.provider)
    const r = {
      kind: 'team', id: `run_${Math.random().toString(36).slice(2, 10)}`, controller: new AbortController(),
      abortReason: null, abortActor: null, followUp: null, done: false, silent: false,
      engine: null, startIndex: events.length, watchdog: null, deadline: 0,
      followUpIndex: Number.isInteger(followUpFrom) ? Math.min(followUpFrom, events.length) : events.length,
    }
    run = r
    lastGoal = text
    setStatusAll('running')

    const release = () => {
      r.done = true
      cancel(r.watchdog)
      if (run === r) run = null
    }
    // A demoted or closing tab no longer speaks for the room.
    const live = () => !r.done && !r.silent && !guard.closed
    const llm = makeClientLLM({
      provider: session.provider, model: session.model, apiKey: getApiKey,
      onNotice: (notice, opts) => { if (live()) emit({ type: 'agent_notice', notice, progress: Boolean(opts?.progress) }) },
    })

    try {
      r.engine = createSwarmRun({
        runId: r.id,
        contextId: session.id,
        pattern: config.pattern,
        config,
        goal: text,
        history: teamHistory(events.slice(0, r.startIndex), { excludeId: goalEventId }),
        humans: () => participants().map((p) => ({ id: p.id, name: p.name })),
        board: view.blackboard || emptyBoard(),
        llm,
        emit: (msg) => {
          if (!live()) return
          emit(msg)
          // "Continue" buys the team more calls; give the watchdog the same time.
          if (msg.type === 'swarm_escalation_resolved' && msg.decision === 'continue') {
            armTeamWatchdog(r, Math.max(0, r.deadline - Date.now()) + ESCALATION_EXTRA_CALLS * perCallSeconds(session.provider) * 1000)
          }
        },
        persist: (e) => (live() ? appendEvent(e.type, e.author, e.content, e.meta) : null),
        directives: () => teamDirectives(events, r.startIndex),
        signal: r.controller.signal,
        pace,
        flushMs: TEAM_FLUSH_MS,
      })
    } catch (err) {
      release()
      closeTeamView('error')
      appendEvent('system', null, `Team error: ${String(err?.message || err).slice(0, 200)}`)
      emit({ type: 'agent_error', error: 'The team hit an error and stopped. Send another message to retry.' })
      setStatusAll('idle')
      return false
    }
    armTeamWatchdog(r, runWatchdogMs(config, session.provider))

    r.engine.promise
      .then(() => {
        if (r.done) return
        if (r.silent) { release(); return }
        release()
        setStatusAll('idle')
        // A teammate wrote while every agent prompt was already built (or while
        // the room was paused): answer that message with a fresh run instead of
        // dropping it. The run's own goal is never answered twice.
        const next = unseenMessages(events, r.followUpIndex, r.engine.seenDirectiveIds).filter((e) => e.id !== goalEventId).at(-1)
        if (next) later(() => { if (host && !run && status !== 'paused') startRun({ goal: next.content, goalEventId: next.id }) }, 0)
      })
      .catch((err) => {
        if (r.done) return
        if (r.silent) { release(); return }
        if (err?.name === 'AbortError' || r.controller.signal.aborted) {
          const reason = r.abortReason || 'stop'
          release()
          closeTeamView(OUTCOME[reason] || 'stopped')
          if (reason === 'pause') {
            setStatusAll('paused')
            emit({ type: 'agent_paused', by: r.abortActor || null })
          } else if (reason === 'redirect') {
            setStatusAll('idle')
            if (r.followUp && !guard.closed) startRun(r.followUp)
          } else if (reason === 'timeout') {
            setStatusAll('idle')
            emit({ type: 'agent_error', error: 'The team ran out of time and was stopped. Send another message to retry.' })
          } else {
            setStatusAll('idle')
          }
        } else {
          release()
          closeTeamView('error')
          setStatusAll('idle')
          appendEvent('system', null, `Team error: ${String(err?.message || err).slice(0, 200)}`)
          emit({ type: 'agent_error', error: 'The team hit an error and stopped. Send another message to retry.' })
        }
      })
    return true
  }

  // One run slot per room, single agent or team.
  const startRun = (opts = {}) => {
    if (run || !session || !host || guard.closed) return false
    if (isTeam()) {
      const latest = opts.goal == null ? latestUserMessage(events) : null
      return startTeamRun({ goal: opts.goal ?? latest?.content, goalEventId: opts.goal == null ? latest?.id : opts.goalEventId, followUpFrom: opts.followUpFrom })
    }
    return startSingleRun(opts)
  }

  const abortRun = (reason, by) => {
    const r = run
    if (!r) return false
    r.abortReason = reason
    r.abortActor = by
    // Demoted or closing: this tab no longer speaks for the room.
    if (reason === 'demoted' || reason === 'closed') r.silent = true
    r.controller.abort()
    return true
  }

  // The goal a resumed team picks up again.
  const previousGoal = () => lastGoal || view.blackboard?.goal || view.swarm?.goal || ''

  // Split-brain guard: if two tabs ever both believe they host (throttled
  // background tab, race during takeover), the lowest id wins and the other
  // demotes itself and re-syncs from the survivor's snapshot.
  const demote = () => {
    if (!host) return
    abortRun('demoted', null)
    setHost(false)
    epoch = null
    adopted = false
    sayHello(SNAPSHOT_WAIT_MS)
  }

  // Ask the host for a fresh snapshot after frames from it went missing. The
  // hello retries until one arrives; frames meanwhile still apply, and the
  // ones sent after the snapshot are replayed on top of it.
  const resync = () => {
    if (host || !adopted || wantSnapshot || guard.closed) return
    wantSnapshot = true
    sayHello(SNAPSHOT_WAIT_MS)
  }

  // Track a peer from any frame it sends. The host writes the join line once
  // the peer holds the room, whichever of its frames shows that first.
  const notePeer = (user, { typing: isTyping, host: isHost, synced: isSynced }) => {
    const prev = peers.get(user.id)
    const synced = isSynced ?? prev?.synced ?? false
    const peer = {
      user,
      lastSeen: Date.now(),
      typing: isTyping ?? prev?.typing ?? false,
      host: isHost ?? prev?.host ?? false,
      synced,
      // A non-host mirrors the host's lines: a peer that holds the room was announced.
      joined: Boolean(prev?.joined) || (!host && synced),
    }
    peers.set(user.id, peer)
    if (host && session && synced && !peer.joined) {
      peer.joined = true
      appendEvent('join', user)
    }
  }
  // Peers that left while another tab hosted: no leave line was written, so a
  // reload of one of them (hello with `replaces`) after a takeover is a return.
  const gone = new Map()
  const remember = (id, peer) => {
    gone.set(id, peer)
    if (gone.size > GONE_LIMIT) gone.delete(gone.keys().next().value)
  }
  // A page that closed may be a refresh: the host holds its leave line for
  // LEAVE_GRACE_MS, and a hello that `replaces` it inside the grace is a return.
  const leaving = new Map() // id -> { peer, timer }
  const dropPeer = (id, { quiet = false, grace = false } = {}) => {
    const peer = peers.get(id)
    if (!peer) return null
    peers.delete(id)
    if (host && peer.joined && !quiet) {
      if (!grace) appendEvent('leave', peer.user)
      else {
        const timer = later(() => {
          leaving.delete(id)
          if (host && session) appendEvent('leave', peer.user)
          else remember(id, peer)
        }, LEAVE_GRACE_MS)
        leaving.set(id, { peer, timer })
      }
    } else if (!host && !quiet && peer.joined) remember(id, peer)
    return peer
  }
  const takeGone = (id) => {
    const held = leaving.get(id)
    if (held) {
      cancel(held.timer)
      leaving.delete(id)
      return held.peer
    }
    const peer = gone.get(id) || null
    gone.delete(id)
    return peer
  }
  // Relay channels that said goodbye. A closing page lives on between
  // beforeunload and pagehide, and can still beat or (hearing the tab that
  // took over) demote itself and say hello: none of that brings it back. A
  // room reopened in the same page (Back, then Forward) opens a new channel.
  const departed = new Set()
  const markDeparted = (src) => {
    if (!src) return
    departed.add(src)
    if (departed.size > GONE_LIMIT) departed.delete(departed.values().next().value)
  }

  // ---------------- Host: actions ----------------
  const rate = new Map()
  const rateLimited = (key, max) => {
    const now = Date.now()
    const bucket = (rate.get(key) || []).filter((t) => now - t < RATE_LIMIT.windowMs)
    if (bucket.length >= max) { rate.set(key, bucket); return true }
    bucket.push(now)
    rate.set(key, bucket)
    return false
  }

  const hostHandle = (action, payload, from) => {
    if (!host || !session || !from?.id) return
    if (action === 'message') {
      if (rateLimited(`msg:${from.id}`, RATE_LIMIT.messages)) { reject(from, 'Rate limit hit: at most 20 messages a minute.'); return }
      const content = String(payload?.content || '').trim().slice(0, MAX_MESSAGE_CHARS)
      if (!content) return
      const event = mkEvent(session.id, 'user_message', from, content, flagInjection(content) ? { flagged: 'possible_prompt_injection' } : null)
      emit({ type: 'user_message', event })
      if (!run && status !== 'paused') startRun({ goal: content, goalEventId: event.id })
      return
    }
    if (action === 'redirect') {
      const instruction = String(payload?.content || '').trim().slice(0, MAX_REDIRECT_CHARS)
      if (!instruction) return
      const event = mkEvent(session.id, 'redirect', from, instruction, flagInjection(instruction) ? { flagged: 'possible_prompt_injection' } : null)
      emit({ type: 'user_redirected', event, by: from, instruction })
      // Single agent: steering text. Team: the instruction becomes the new goal.
      const followUp = run
        ? { steering: `[${from.name} redirected you mid-run]: ${instruction}. Drop your previous direction and follow this immediately.`, redirected: true, goal: instruction }
        : { steering: `[${from.name} redirected you]: ${instruction}. Follow this new direction.`, redirected: true, goal: instruction }
      if (run) {
        run.followUp = followUp
        abortRun('redirect', from)
      } else {
        startRun(followUp)
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
      // Two people pressing Resume at once must not flip a live run to idle.
      if (run) return
      // A message sent while the room was paused gets a run of its own after
      // the resumed one (same rule as the server). Look from the pause on.
      const wasPaused = status === 'paused'
      let pauseIndex = -1
      if (wasPaused) for (let i = events.length - 1; i >= 0 && pauseIndex < 0; i--) if (events[i]?.type === 'pause') pauseIndex = i
      appendEvent('resume', from)
      emit({ type: 'agent_resumed', by: from })
      setStatusAll('idle')
      if (isTeam()) {
        const followUpFrom = pauseIndex >= 0 ? pauseIndex : null
        const prior = previousGoal()
        if (prior) {
          startRun({ goal: continueGoal(prior), followUpFrom })
        } else {
          // No earlier goal: the newest message is the goal (like the server).
          const latest = latestUserMessage(events)
          if (latest) startRun({ goal: latest.content, goalEventId: latest.id, followUpFrom })
        }
      } else {
        startRun({ steering: `[${from.name} resumed the session]: Continue exactly where you left off. If your last message was cut off mid-thought, finish it, then keep going.` })
      }
      return
    }
    if (action === 'stop') {
      const team = run?.kind === 'team'
      abortRun('stop', from)
      appendEvent('system', null, `${from.name} stopped the ${team ? 'team' : 'agent'}.`)
      return
    }
    if (action === 'fork') {
      // The forker already created (and will host) the new room in its own
      // browser; the original room only records that the fork happened.
      const newSession = payload?.newSession
      if (!newSession?.roomCode || !newSession?.id) return
      const pattern = newSession.config?.crew === 'team' ? newSession.config.pattern : undefined
      appendEvent('fork', from, String(newSession.name || 'Fork').slice(0, 120), { forkedSessionId: newSession.id, ...(pattern ? { pattern } : {}) })
      emit({ type: 'session_forked', newSession, by: from })
      return
    }

    // Agent-team actions share one budget per person, like the server's.
    if (!['pin', 'vote', 'escalation', 'set_config'].includes(action)) return
    if (rateLimited(`act:${from.id}`, RATE_LIMIT.actions)) { reject(from, 'Too many actions. Slow down a little.'); return }
    const by = actor(from)
    const engine = run?.kind === 'team' && !run.done ? run.engine : null

    if (action === 'pin') {
      const kind = String(payload?.kind || '')
      const content = cleanText(payload?.content, MAX_PIN_CHARS)
      if (!BOARD_KINDS.includes(kind) || !content) return
      // Flagged text is still pinned; the board shows agents it as data only.
      const flagged = flagInjection(content)
      let added
      if (engine) {
        added = engine.pin(kind, content, by, { flagged })
      } else {
        const board = view.blackboard || emptyBoard()
        const next = addItem(board, kind, content, { ...by, kind: 'human' }, Date.now(), { flagged })
        added = next !== board
        if (added) emit({ type: 'blackboard', board: next })
      }
      // The board dedupes near-identical items; a repeat pin is not news.
      if (!added) { reject(from, DUPLICATE_PIN); return }
      appendEvent('pin', from, content, { kind, ...(flagged ? { flagged: 'possible_prompt_injection' } : {}) })
      return
    }
    if (action === 'vote') {
      const option = String(payload?.option || '')
      if (option && engine) engine.castVote(by, option)
      return
    }
    if (action === 'escalation') {
      const decision = payload?.decision
      if (engine && typeof payload?.escalationId === 'string' && (decision === 'continue' || decision === 'wrap_up')) {
        engine.decideEscalation(payload.escalationId, decision, by)
      }
      return
    }
    if (action === 'set_config') {
      if (run || status === 'running') { reject(from, 'Wait for the team to finish first.'); return }
      const config = mergeConfig(session.config, payload?.config, session.provider)
      if (sameConfig(config, session.config)) return
      emit({ type: 'session_config', config, by: from })
      appendEvent('config', from, configLabel(config), config)
    }
  }

  // ---------------- Membership ----------------
  const becomeHost = (room, { takeover = false } = {}) => {
    setHost(true)
    hostSeen = true
    adopted = true
    wantSnapshot = false
    early = []
    epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    hostEpoch = epoch
    stopHello()
    const s = room.session
    session = { ...s, config: sanitizeConfig(s.config, s.provider) }
    resetEvents(room.events)
    const wasRunning = room.status === 'running'
    status = room.status === 'paused' ? 'paused' : 'idle'
    view = { swarm: room.swarm || null, blackboard: room.blackboard ? normalizeBoard(room.blackboard) : emptyBoard() }
    dispatch({ type: 'joined', session, you, events, participants: participants(), agentStatus: status, streaming: null, swarm: view.swarm, blackboard: view.blackboard })
    // Back then Forward, a refresh or Try again re-enter as the same person:
    // one join line until they leave.
    if (!stillJoined(events, you)) appendEvent('join', you)
    if (takeover) appendEvent('system', null, `${you.name}'s tab took over hosting this session.`)
    // Whatever was running died with the previous host tab: say so, and close
    // the team view so nobody waits on agents that no longer exist.
    const teamWasRunning = view.swarm?.status === 'running'
    if (teamWasRunning) closeTeamView('lost')
    if (wasRunning || teamWasRunning) {
      appendEvent('system', null, `The host tab closed mid-run, so the ${teamWasRunning ? 'team' : 'agent'} stopped. Send a message to pick it up again.`)
    }
    if (takeover || wasRunning) emit({ type: 'session_status', status })
    if (takeover && wasRunning && !teamWasRunning) emit({ type: 'agent_done', runId: 'lost', event: null, partial: true })
    // Announce the new term at once: peers address their actions to it.
    post(beat())
    persistSoon()
    // Replay anything this tab sent while no host was listening.
    const queued = pending
    pending = []
    for (const p of queued) hostHandle(p.action, p.payload, you)
  }

  const electIfHostless = () => {
    if (host || !hostSeen || !session) return
    if ([...peers.values()].some((p) => p.host)) return
    // Only tabs that hold the room can host it; one stuck joining never answers.
    const ids = [you.id, ...[...peers].filter(([, p]) => p.synced).map(([id]) => id)].sort()
    if (ids[0] !== you.id) return
    // In the creator's browser the stored record may hold more history than
    // the snapshot window this tab mirrored: keep both.
    const stored = storage.load(code)
    const history = stored?.session?.id === session.id ? mergeEvents(stored.events, events) : events
    becomeHost({ session, events: history, status, blackboard: view.blackboard || stored?.blackboard, swarm: view.swarm }, { takeover: true })
  }

  const postAction = (p) => post({ t: 'action', id: p.id, action: p.action, payload: p.payload, from: you, epoch: hostEpoch })

  const adoptSnapshot = (data, from = {}) => {
    // A resync keeps the history this tab had from before the snapshot's window.
    const resyncing = adopted && session?.id === data.session.id
    adopted = true
    wantSnapshot = false
    stopHello()
    hostSeen = true
    if (from.src) hostSrc = from.src
    if (typeof data.epoch === 'string') hostEpoch = data.epoch
    snapAt = Number.isInteger(from.seq) ? { src: from.src, seq: from.seq } : null
    session = data.session
    resetEvents(resyncing ? keepOlder(events, data.events || []) : data.events)
    status = data.agentStatus === 'running' ? 'running' : data.agentStatus === 'paused' ? 'paused' : 'idle'
    view = { swarm: data.swarm || null, blackboard: data.blackboard || null }
    dispatch({ type: 'joined', session, you, events, participants: participants(), agentStatus: data.agentStatus, streaming: data.streaming, swarm: view.swarm, blackboard: view.blackboard })
    // Frames the host sent after this snapshot can land before it (a slow
    // relay carried the big snapshot): apply them on top, in order.
    const newer = snapAt ? early.filter((f) => f.src === snapAt.src && f.seq > snapAt.seq).sort((a, b) => a.seq - b.seq) : []
    early = []
    for (const f of newer) { observe(f.msg); dispatch(f.msg) }
    // In the room now: tell everyone at once (presence, the host's join line).
    post(beat())
    // An action whose ack went missing with the lost frames: send it again
    // (the host runs each action id once).
    if (resyncing) for (const p of pending) { p.at = Date.now(); postAction(p) }
  }

  const onFrame = (data, from = {}) => {
    if (guard.closed || !data || typeof data.t !== 'string') return
    if (from.src && departed.has(from.src)) return
    const { t } = data

    if (t === 'hello') {
      const user = data.user
      if (!user?.id || user.id === you.id) return
      // The same tab before a reload, whose goodbye never arrived: it's this
      // peer now, so no leave or second join line.
      // A goodbye that reached this tab before it hosted (a takeover) wrote no
      // leave line, so the reloaded tab is still the same person.
      const replaced = typeof data.replaces === 'string' && data.replaces !== user.id ? data.replaces : null
      const old = replaced ? dropPeer(replaced, { quiet: true }) || takeGone(replaced) : null
      if (old?.joined && !peers.has(user.id)) peers.set(user.id, { ...old, user, host: false, synced: false })
      notePeer(user, { typing: false, host: false, synced: Boolean(data.synced) })
      post(beat())
      if (host && session) {
        const r = run
        post({
          ...buildSnapshot({
            to: user.id, session, events, participants: participants(),
            agentStatus: r ? 'running' : status,
            // Exclude text still sitting in r.pending — it arrives via the next agent_token flush.
            streaming: r?.kind === 'single' ? { runId: r.id, text: r.text.slice(0, r.text.length - r.pending.length) } : null,
            swarm: view.swarm, blackboard: view.blackboard,
          }),
          epoch,
        })
      }
      pushPresence()
      if (old) electIfHostless()
      return
    }
    if (t === 'snapshot') {
      if (data.to !== you.id || host || !data.session || (adopted && !wantSnapshot)) return
      adoptSnapshot(data, from)
      return
    }
    if (t === 'heartbeat' || t === 'typing') {
      const user = data.user
      if (!user?.id || user.id === you.id) return
      // Frames from an older build carry no `synced`: count them as in the room.
      notePeer(user, { typing: Boolean(data.typing), host: t === 'heartbeat' ? Boolean(data.host) : undefined, synced: data.synced !== false })
      if (t === 'heartbeat' && data.host) {
        hostSeen = true
        if (!host) {
          if (from.src) hostSrc = from.src
          if (typeof data.epoch === 'string') hostEpoch = data.epoch
        }
      }
      if (t === 'heartbeat' && data.host && host && user.id < you.id) demote()
      pushPresence()
      return
    }
    if (t === 'ack') {
      markHandled(data.id)
      if (data.to === you.id) pending = pending.filter((p) => p.id !== data.id)
      return
    }
    if (t === 'retry') {
      // The host is on a newer term than this tab knew: resend that action to it.
      // Only an action still pending here is resent, never a replayed frame.
      const p = data.to === you.id && typeof data.epoch === 'string' ? pending.find((x) => x.id === data.id) : null
      if (p) { hostEpoch = data.epoch; p.at = Date.now(); postAction(p) }
      return
    }
    if (t === 'notice') {
      if (data.to === you.id && typeof data.notice === 'string') dispatch({ type: 'local_notice', notice: data.notice.slice(0, 200) })
      return
    }
    if (t === 'bye') {
      const id = data.user?.id
      if (!id) return
      markDeparted(from.src)
      // `closing`: the page went away (tab closed or refreshed), not the Leave button.
      dropPeer(id, { grace: data.closing === true })
      pushPresence()
      electIfHostless()
      return
    }
    if (t === 'action') {
      if (!host) return
      // An action names the term it was sent in. Another term means a stale
      // tab (ask it to resend) or a replayed frame (its sender has nothing
      // pending under that id, so nothing happens).
      if ('epoch' in data && data.epoch !== epoch) {
        if (data.id && data.from?.id) post({ t: 'retry', id: data.id, to: data.from.id, epoch })
        return
      }
      if (!data.id || !handled.has(data.id)) hostHandle(data.action, data.payload, data.from)
      if (data.id) {
        markHandled(data.id)
        post({ t: 'ack', id: data.id, to: data.from?.id })
      }
      return
    }
    if (t === 'msg') {
      const msg = data.msg
      if (!msg || typeof msg.type !== 'string' || host) return
      if (from.src) hostSrc = from.src
      // Already part of the snapshot this tab adopted.
      if (snapAt && from.src === snapAt.src && Number.isInteger(from.seq) && from.seq < snapAt.seq) return
      // Waiting on a snapshot: keep the frame to replay on top of it.
      if ((!adopted || wantSnapshot) && Number.isInteger(from.seq)) {
        early.push({ src: from.src, seq: from.seq, msg })
        if (early.length > EARLY_FRAMES_LIMIT) early.shift()
      }
      if (!session) return
      // Mirror the host's state so a takeover can continue from here.
      observe(msg)
      dispatch(msg)
    }
  }

  // Announce this tab, retrying (frames can race the relay subscription)
  // until a snapshot arrives or `forMs` passes.
  function sayHello(forMs) {
    stopHello()
    post(hello())
    const started = Date.now()
    const retry = every(() => {
      if (host || (adopted && !wantSnapshot)) { stopHello(); return }
      if (Date.now() - started > forMs) { wantSnapshot = false; stopHello(); return }
      post(hello())
    }, HELLO_RETRY_MS)
    stopHello = () => { clearInterval(retry); guard.intervals.delete(retry); stopHello = () => {} }
  }

  const fallbackToStorage = () => {
    if (guard.closed || adopted) return
    stopHello()
    const room = storage.load(code)
    if (room?.session) {
      becomeHost(room)
    } else {
      dispatch({ type: 'connection', value: 'error', error: preferHost && !resume
        ? 'That room isn’t saved in this browser any more. Create a new session, or join with the code from a device where it’s open.'
        : relays > 0
          ? 'No live room found for that code. Check the code, and make sure the person who created the room still has it open. The room lives in the creator’s browser.'
          : 'Couldn’t reach the real-time relays from this network, so only rooms opened in this browser are visible. Try another network (or mobile data) and join again.' })
    }
  }

  // Refresh of a room this browser saved: a live host (another tab, or a peer
  // that took over) wins if it answers quickly; otherwise host from storage.
  const resumeFromStorage = async () => {
    sayHello(RESUME_WAIT_MS + RESUME_RELAY_GRACE_MS + 1000)
    await delay(RESUME_WAIT_MS)
    if (adopted) return
    if (relays === 0) {
      // Relays still connecting: a host on another device can't have heard us yet.
      const ready = await Promise.race([chan.ready.then(() => 'ready'), delay(RESUME_RELAY_GRACE_MS).then(() => 'late')])
      if (ready === 'ready' && relays > 0 && !adopted) { post(hello()); await delay(1000) }
    }
    fallbackToStorage()
  }

  const start = () => {
    if (guard.closed || guard.started) return
    guard.started = true
    chan = openRoomChannel(code, {
      onMessage: onFrame,
      // Frames from the host were lost on every relay: catch up.
      onGap: (src) => { if (src === hostSrc) resync() },
      onStatus: ({ relays: n, total }) => {
        // Every relay dropped and one is back: frames sent meanwhile are gone.
        if (n === 0 && relays > 0) relaysDropped = true
        relays = n
        if (n > 0 && relaysDropped) { relaysDropped = false; resync() }
        onStatus?.({ relays: n, total })
      },
    })
    dispatch({ type: 'connection', value: 'connecting' })

    // Join: the creator hosts straight from local storage; a refreshed creator
    // tab gives a live host a moment first. A joiner waits for a relay,
    // announces itself, and adopts the host's snapshot; with no live host it
    // falls back to storage.
    const saved = resume ? storage.load(code) : null
    if (resume && saved?.session) {
      resumeFromStorage()
    } else if (preferHost && !resume) {
      fallbackToStorage()
    } else {
      chan.ready.then(() => {
        if (guard.closed || adopted) return
        sayHello(SNAPSHOT_WAIT_MS)
        later(fallbackToStorage, SNAPSHOT_WAIT_MS)
      })
    }

    every(() => {
      post(beat())
      const now = Date.now()
      let changed = false
      for (const [id, peer] of peers) {
        if (now - peer.lastSeen > PEER_TTL_MS) {
          dropPeer(id)
          changed = true
        }
      }
      if (changed) { pushPresence(); electIfHostless() }
      // Actions that never got a host ack while a host looked alive are truly lost — say so.
      if (!host && pending.length) {
        const stale = pending.filter((p) => now - p.at > PEER_TTL_MS)
        if (stale.length && [...peers.values()].some((p) => p.host)) {
          pending = pending.filter((p) => now - p.at <= PEER_TTL_MS)
          dispatch({ type: 'local_notice', notice: 'Your last action didn’t reach the host tab. Please try again.' })
        }
      }
    }, HEARTBEAT_MS)

    // iOS Safari never fires beforeunload; pagehide is the event it does send.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', onUnload)
      window.addEventListener('pagehide', onUnload)
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  }

  const onUnload = () => {
    persistNow()
    chan?.postNow({ t: 'bye', user: you, closing: true })
  }
  // A tab coming back from the background re-announces immediately so peers
  // don't mistake a throttled heartbeat for a dead host.
  const onVisible = () => { if (document.visibilityState === 'visible') post(beat()) }

  // React StrictMode mounts, unmounts and remounts effects synchronously in
  // development: starting on a microtask means the throwaway mount never
  // opens relays, hosts, or writes a "joined" line.
  queueMicrotask(start)

  // ---------------- Public API (this tab) ----------------
  const dispatchAction = (action, payload) => {
    if (guard.closed) throw new Error('This room is closed.')
    let forked = null
    if (action === 'fork') {
      // Create the fork HERE, from this tab's mirrored timeline, so it exists
      // (and is hosted) in the forker's own browser — not the original host's.
      if (!session) throw new Error('Not connected to the room yet.')
      const pattern = payload?.pattern || null
      // The fork can bring its own turn-taking; clampConfig drops one the pattern does not offer.
      const turnTaking = typeof payload?.turnTaking === 'string' ? payload.turnTaking : null
      const config = pattern ? mergeConfig(session.config, { crew: 'team', pattern, ...(turnTaking ? { turnTaking } : {}) }, session.provider) : session.config
      forked = createLocalRoom({
        name: pattern ? `${session.name} (${patternName(pattern)})` : `${session.name} (fork)`,
        mode: session.mode, provider: session.provider, model: session.model,
        forkedFrom: session.id, events: events.map((e) => ({ ...e, sessionId: null })),
        config, blackboard: view.blackboard,
      }, storage)
      payload = { newSession: forked }
    }
    if (host) {
      hostHandle(action, payload, you)
    } else {
      // Remember it until a host acks; replayed if this tab becomes host.
      const p = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, action, payload, at: Date.now() }
      pending.push(p)
      postAction(p)
      // Hop into our own fork now; don't wait for the host's echo.
      if (forked) dispatch({ type: 'session_forked', newSession: forked, by: you })
    }
    return { ok: true, ...(forked ? { session: forked } : {}) }
  }

  const sendMessage = (content) => {
    const text = String(content || '').trim()
    if (!text) throw new Error('Message is empty.')
    if (text.length > MAX_MESSAGE_CHARS) throw new Error('Message too long (max 4000 chars).')
    return dispatchAction('message', { content: text })
  }

  // Validates in this tab (friendly errors, no wasted relay frames), then hands
  // a clean payload to the host. The host checks everything again.
  const act = (action, extra = {}) => {
    const x = extra && typeof extra === 'object' ? extra : {}
    switch (action) {
      case 'pause':
      case 'resume':
      case 'stop':
        return dispatchAction(action, {})
      case 'redirect': {
        const instruction = String(x.content || '').trim()
        if (!instruction) throw new Error('Redirect needs an instruction.')
        if (instruction.length > MAX_REDIRECT_CHARS) throw new Error('Redirect too long (max 500 chars).')
        return dispatchAction('redirect', { content: instruction })
      }
      case 'fork': {
        if (x.pattern != null && !PATTERN_ORDER.includes(x.pattern)) throw new Error('Pick one of the nine architectures to fork with.')
        return dispatchAction('fork', { pattern: x.pattern || null, ...(typeof x.turnTaking === 'string' ? { turnTaking: x.turnTaking } : {}) })
      }
      case 'pin': {
        if (!BOARD_KINDS.includes(x.kind)) throw new Error('Pick a board section to pin to.')
        const content = cleanText(x.content, MAX_PIN_CHARS + 1)
        if (!content) throw new Error('Write something to pin first.')
        if (content.length > MAX_PIN_CHARS) throw new Error('Pins are limited to 200 characters.')
        // addItem hands back the same board for a near-duplicate.
        const board = view.blackboard ? normalizeBoard(view.blackboard) : null
        if (board && addItem(board, x.kind, content, null) === board) throw new Error(DUPLICATE_PIN)
        return dispatchAction('pin', { kind: x.kind, content })
      }
      case 'vote': {
        const option = typeof x.option === 'string' ? x.option : ''
        if (!option) throw new Error('Pick a proposal to vote for.')
        const vote = view.swarm?.vote
        if (!vote?.open) throw new Error('This vote has already closed.')
        if (!vote.options.some((o) => o.id === option)) throw new Error('That proposal isn’t on the ballot.')
        return dispatchAction('vote', { option })
      }
      case 'escalation': {
        if (x.decision !== 'continue' && x.decision !== 'wrap_up') throw new Error('Choose continue or wrap up.')
        if (typeof x.escalationId !== 'string' || !x.escalationId) throw new Error('That question is missing its id.')
        if (view.swarm?.escalation?.escalationId !== x.escalationId) throw new Error('The team already moved on from that question.')
        return dispatchAction('escalation', { escalationId: x.escalationId, decision: x.decision })
      }
      case 'set_config': {
        if (!x.config || typeof x.config !== 'object') throw new Error('Choose an architecture first.')
        if (status === 'running' || run) throw new Error('Wait for the team to finish first.')
        return dispatchAction('set_config', { config: x.config })
      }
      default:
        throw new Error('That action isn’t available here.')
    }
  }

  const setTyping = (isTyping) => {
    typing = Boolean(isTyping)
    post({ t: 'typing', user: you, typing, synced: Boolean(session) })
  }

  const close = () => {
    if (guard.closed) return
    if (run) abortRun('closed', null)
    // Save before tearing down: a run cut off here is closed as lost on the next load.
    if (guard.started) persistNow()
    guard.closed = true
    for (const t of guard.timers) clearTimeout(t)
    for (const t of guard.intervals) clearInterval(t)
    guard.timers.clear()
    guard.intervals.clear()
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('pagehide', onUnload)
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    if (chan) {
      chan.post({ t: 'bye', user: you })
      chan.close()
    }
  }

  return { act, sendMessage, setTyping, close, isHost: () => host }
}
