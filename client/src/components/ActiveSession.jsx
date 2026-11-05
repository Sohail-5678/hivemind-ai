import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useSession } from '../hooks/useSession'
import { useLocalRoom, createLocalRoom } from '../hooks/useLocalRoom'
import { api } from '../lib/api'
import { navigate, roomPath } from '../lib/router'
import { SessionWorkspace, sanitizeCrewConfig } from './SessionWorkspace'
import { Icon } from './Composer'
import { readStoredKey } from './ProviderPicker'
import { PATTERNS } from '@shared/swarm/patterns.js'

// Everything about being inside a room, shared by Sample and Live: the name
// gate, joining and error states, the transport (server → WebSocket, static →
// encrypted relay), and hopping into a fork.

const NAME_KEY = 'hivemind_name'
const NAME_MAX = 40

export function readStoredName() {
  try { return String(localStorage.getItem(NAME_KEY) || '').trim().slice(0, NAME_MAX) } catch { return '' }
}
export function storeName(name) {
  try { localStorage.setItem(NAME_KEY, String(name).trim().slice(0, NAME_MAX)) } catch { /* private mode */ }
}

// Rooms this tab just created or forked into, keyed like the route. Module
// scope on purpose: it dies with the page, so a refresh never mistakes itself
// for the creator. The creator hosts straight from storage; everyone else
// (refresh, Back then Forward, a shared link) resumes and waits for a live host.
const arrivals = new Map()
const ARRIVAL_TTL_MS = 60_000

function keyOfRoute(room) {
  return room.kind === 'session' ? `s:${room.id}` : `c:${String(room.code).toUpperCase()}`
}
function keyOfSession(session) {
  const local = session.local || String(session.id || '').startsWith('local_')
  return local ? `c:${String(session.roomCode).toUpperCase()}` : `s:${session.id}`
}
export function noteArrival(session, info) {
  if (session) arrivals.set(keyOfSession(session), { ...info, at: Date.now() })
}
function peekArrival(key) {
  const a = arrivals.get(key)
  return a && Date.now() - a.at < ARRIVAL_TTL_MS ? a : null
}

// Creates the session for a setup form and returns it; the caller navigates.
export async function createRoom(runtime, { mode, name, provider, model, apiKey, config }) {
  const clean = sanitizeCrewConfig(config, provider)
  if (runtime?.mode === 'server') {
    const body = { name, mode, provider, model: model || undefined, config: clean }
    if (apiKey) body.apiKey = apiKey
    const data = await api.createSession(body)
    if (!data?.session?.id) throw new Error('The server didn’t return a session. Try again.')
    return data.session
  }
  const session = createLocalRoom({ name, mode, provider, model: model || null, config: clean })
  noteArrival(session, { created: true })
  return session
}

// ---------------------------------------------------------------- states

function Rings() {
  return (
    <span className="ws-rings-well" aria-hidden="true">
      <svg className="ws-rings" viewBox="0 0 120 120">
        <circle className="ws-ring ws-ring-outer" cx="60" cy="60" r="52" />
        <g className="ws-orbit">
          <circle className="ws-ring ws-ring-orbit" cx="60" cy="60" r="38" />
          <circle className="ws-ring-satellite" cx="60" cy="22" r="2.6" />
        </g>
        <circle className="ws-ring ws-ring-inner" cx="60" cy="60" r="24" />
        <circle className="ws-ring-core" cx="60" cy="60" r="4.5" />
      </svg>
    </span>
  )
}

export function StatusCard({ label, title, detail, readout, onBack, backLabel = 'Back' }) {
  return (
    <div className="ws-status">
      <Rings />
      <div className="ws-status-text" role="status">
        {label && <span className="label-mono">{label}</span>}
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
        {readout && <span className="ws-readout">{readout}</span>}
      </div>
      {onBack && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <Icon name="back" />{backLabel}
        </button>
      )}
    </div>
  )
}

export function ErrorCard({ title, message, onRetry, onBack, backLabel = 'Back' }) {
  const retryRef = useRef(null)
  const backRef = useRef(null)
  // Move focus to the way forward, so keyboard users aren't left on a vanished control.
  useEffect(() => { (retryRef.current || backRef.current)?.focus({ preventScroll: true }) }, [])
  return (
    <div className="setup-card ws-error">
      <span className="label-mono">Room unavailable</span>
      <h2>{title}</h2>
      <div className="error-note" role="alert">{message || 'Something went wrong.'}</div>
      <div className="setup-actions">
        {onRetry && <button ref={retryRef} type="button" className="btn btn-primary" onClick={onRetry}>Try again</button>}
        {onBack && (
          <button ref={backRef} type="button" className="btn btn-ghost" onClick={onBack}>
            <Icon name="back" />{backLabel}
          </button>
        )}
      </div>
    </div>
  )
}

function NameCard({ room, onEnter, onBack }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  const uid = useId()
  const submit = (e) => {
    e.preventDefault()
    const name = value.trim().slice(0, NAME_MAX)
    if (!name) { setError('Enter a name so the room knows who is speaking.'); return }
    // The card unmounts on the same route, so App's focus handling never runs:
    // hand focus to the screen so the next Tab starts in the room.
    e.currentTarget.closest('main')?.focus({ preventScroll: true })
    onEnter(name)
  }
  return (
    <form className="name-card" onSubmit={submit} aria-labelledby={`${uid}-title`} noValidate>
      <span className="label-mono">{room.kind === 'code' ? `Room ${room.code}` : 'Shared room'}</span>
      <h2 id={`${uid}-title`}>Who’s joining?</h2>
      <p>Your name appears on your messages and your avatar. It’s saved in this browser for next time.</p>
      <div className="field">
        <label htmlFor={`${uid}-name`}>Your name</label>
        <input
          id={`${uid}-name`}
          autoFocus
          value={value}
          maxLength={NAME_MAX}
          placeholder="e.g. Alex"
          autoComplete="nickname"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${uid}-error` : undefined}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null) }}
        />
      </div>
      {error && <div id={`${uid}-error`} className="error-note" role="alert">{error}</div>}
      <div className="setup-actions">
        <button type="submit" className="btn btn-primary">Enter room <Icon name="send" /></button>
        <button type="button" className="btn btn-ghost" onClick={onBack}><Icon name="back" />Back</button>
      </div>
    </form>
  )
}

// Server runtime opened with a static-style /room/CODE link: look the code up
// and swap the URL for the session route, so Back skips the lookup.
function CodeResolver({ code, section, onBack }) {
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    api.joinByCode(code)
      .then((data) => {
        if (!alive) return
        if (data?.session?.id) navigate(roomPath(section, data.session), { replace: true })
        else setError('No session found for that code.')
      })
      .catch((err) => { if (alive) setError(err?.message || 'Couldn’t look up that room.') })
    return () => { alive = false }
  }, [code, section, attempt])
  if (error) return <ErrorCard title="Couldn’t open that room" message={error} onRetry={() => setAttempt((n) => n + 1)} onBack={onBack} />
  return <StatusCard label={`Room ${code}`} title="Finding the room" detail="Looking the code up on the server…" onBack={onBack} />
}

// ---------------------------------------------------------------- room

function Connected({ s, mode, section, roomLabel, renderShareBar, banner, onExit, onRetry, onFork }) {
  const [localNotice, setLocalNotice] = useState(null)
  const notice = s.notice || localNotice
  const { clearNotice: clearHookNotice, clearFork, act: hookAct } = s
  const clearNotice = useCallback(() => { clearHookNotice(); setLocalNotice(null) }, [clearHookNotice])

  // Hop once into a fork this tab made. Server forks answer the action with the
  // new session AND broadcast session_forked; either may arrive first.
  const hopped = useRef(null)
  const hop = useCallback((session) => {
    const id = session?.id || session?.roomCode
    if (!id || hopped.current === id) return
    hopped.current = id
    onFork?.(session)
  }, [onFork])
  useEffect(() => {
    if (!s.forkTarget) return
    const target = s.forkTarget
    clearFork()
    hop(target)
  }, [s.forkTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (action, extra) => {
    const res = await hookAct(action, extra)
    if (action === 'fork' && res?.session?.id) hop(res.session)
    return res
  }, [hookAct, hop])

  // A link can name the wrong section (#/sample/s/ID for a Live room): once the
  // room says what it is, swap the URL so the frame, nav and invite bar match.
  const actualMode = s.session?.mode
  useEffect(() => {
    if (!section || !s.session || (actualMode !== 'sample' && actualMode !== 'live') || actualMode === section) return
    navigate(roomPath(actualMode, s.session), { replace: true })
  }, [section, actualMode, s.session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (s.connection === 'error') {
    return <ErrorCard title="Couldn’t open that room" message={s.error || 'Unknown error.'} onRetry={onRetry} onBack={onExit} />
  }

  // Nothing to show until the first snapshot: a joiner may wait a few seconds
  // for the host's tab to answer over the relays.
  if (!s.session) {
    const reconnecting = s.connection === 'closed'
    const detail = mode === 'server'
      ? (reconnecting ? 'Can’t reach the server right now. Retrying…' : 'Connecting to the server…')
      : s.relays === 0
        ? 'Can’t reach the real-time relays yet. Still trying…'
        : 'Looking for the tab that hosts this room…'
    const readout = mode === 'server' ? null
      : s.relays == null ? 'Opening encrypted relays'
        : `${s.relays} relay${s.relays === 1 ? '' : 's'} connected`
    return <StatusCard label={roomLabel} title="Joining the room" detail={detail} readout={readout} onBack={onExit} />
  }

  return (
    <div className="ws-room">
      <SessionWorkspace
        session={s.session}
        you={s.you}
        events={s.events}
        participants={s.participants}
        status={s.status}
        streaming={s.streaming}
        activeTool={s.activeTool}
        connection={s.connection}
        swarm={s.swarm || null}
        blackboard={s.blackboard || null}
        onSend={s.sendMessage}
        onAction={act}
        onTyping={s.setTyping}
        onNotice={setLocalNotice}
        notice={notice}
        noticeProgress={Boolean(s.notice && s.noticeProgress)}
        onClearNotice={clearNotice}
        banner={banner || null}
        shareBar={renderShareBar ? renderShareBar(s.session, s) : null}
      />
    </div>
  )
}

function ServerSession({ sessionId, userName, ...rest }) {
  const s = useSession(sessionId, userName)
  return <Connected s={s} mode="server" roomLabel="Shared room" {...rest} />
}

function LocalSession({ roomCode, userName, apiKey, preferHost, resume, ...rest }) {
  const s = useLocalRoom(roomCode, userName, { apiKey, preferHost, resume })
  return <Connected s={s} mode="static" roomLabel={`Room ${roomCode}`} {...rest} />
}

// Live-connected workspace for one room. `preferHost` is only for the tab that
// just created the room; a retry never claims it from storage outright, it
// resumes like a refresh does. `onFork(session)` belongs to the section, which
// navigates to the fork's route.
export function ActiveSession({
  mode, section = null, sessionId, roomCode, userName, apiKey = null, preferHost = false, resume = false,
  renderShareBar, banner, onExit, onFork,
}) {
  const [attempt, setAttempt] = useState(0)
  const onRetry = useCallback(() => setAttempt((n) => n + 1), [])
  const hostFirst = preferHost && attempt === 0

  const hop = useCallback((session) => {
    // A static fork is created and hosted in this tab, so it enters as the creator.
    const config = session.config || null
    noteArrival(session, {
      created: mode !== 'server',
      fork: true,
      name: session.name,
      pattern: config?.crew === 'team' && PATTERNS[config.pattern] ? config.pattern : null,
    })
    onFork?.(session)
  }, [mode, onFork])

  const shared = { userName, section, renderShareBar, banner, onExit, onRetry, onFork: hop }
  if (mode === 'server') {
    return <ServerSession key={`${sessionId}:${attempt}`} sessionId={sessionId} {...shared} />
  }
  return (
    <LocalSession
      key={`${roomCode}:${attempt}`}
      roomCode={roomCode}
      apiKey={apiKey}
      preferHost={hostFirst}
      resume={!hostFirst && (resume || attempt > 0)}
      {...shared}
    />
  )
}

function RoomEntry({ runtime, section, room, userName, renderShareBar, onExit, onFork }) {
  const key = keyOfRoute(room)
  // Read once on mount (React may render twice in development), consume after.
  const [arrival] = useState(() => peekArrival(key))
  useEffect(() => { arrivals.delete(key) }, [key])
  const [forkBanner, setForkBanner] = useState(() => (arrival?.fork ? arrival : null))
  const [apiKey] = useState(() => (runtime.mode === 'server' ? null : readStoredKey() || null))

  const banner = forkBanner ? (
    <div className="demo-banner ws-fork-banner">
      <Icon name="fork" />
      <span>
        You’re in the fork <strong>“{forkBanner.name || 'Untitled'}”</strong>
        {forkBanner.pattern === 'auto'
          ? ', where the Architect picks the team'
          : forkBanner.pattern ? `, running the ${PATTERNS[forkBanner.pattern].name} architecture` : ''}.
        {' '}The original room is unchanged.
      </span>
      <button type="button" className="replay" onClick={() => setForkBanner(null)}>Dismiss</button>
    </div>
  ) : null

  return (
    <ActiveSession
      mode={runtime.mode}
      section={section}
      sessionId={room.kind === 'session' ? room.id : undefined}
      roomCode={room.kind === 'code' ? room.code : undefined}
      userName={userName}
      apiKey={apiKey}
      preferHost={Boolean(arrival?.created)}
      resume={!arrival?.created}
      renderShareBar={renderShareBar}
      banner={banner}
      onExit={onExit}
      onFork={onFork}
    />
  )
}

// The screen for a room route (#/live/room/CODE, #/sample/s/ID, …). Asks for a
// name first when this browser has none, then enters. Remounts per room, so a
// fork hop or a pasted link always starts clean.
export function SessionRoom({ runtime, section, room, renderShareBar, onExit, onFork }) {
  const [name, setName] = useState(readStoredName)
  const sectionName = section === 'sample' ? 'Sample' : 'Live'

  if (!runtime) {
    return <StatusCard label={sectionName} title="Getting ready" detail="Checking how this site runs rooms…" onBack={onExit} />
  }
  // A link this site can't open says so before asking anyone for a name.
  if (runtime.mode !== 'server' && room.kind === 'session') {
    return (
      <ErrorCard
        title="This link needs the HiveMind server"
        message="It points to a session on a HiveMind server, and this site runs rooms in the browser instead. Ask for the room code, or start a new room here."
        onBack={onExit}
        backLabel={`Back to ${sectionName}`}
      />
    )
  }
  if (!name) {
    return <NameCard room={room} onEnter={(n) => { storeName(n); setName(n) }} onBack={onExit} />
  }
  if (runtime.mode === 'server' && room.kind === 'code') {
    return <CodeResolver key={room.code} code={room.code} section={section} onBack={onExit} />
  }
  return (
    <RoomEntry
      key={keyOfRoute(room)}
      runtime={runtime}
      section={section}
      room={room}
      userName={name}
      renderShareBar={renderShareBar}
      onExit={onExit}
      onFork={onFork}
    />
  )
}
