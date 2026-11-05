import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../lib/api'
import { navigate, roomPath } from '../lib/router'
import { CrewPicker, initialCrewConfig, clearCrewHint } from './hive'
import { useProviders, ProviderFields, FreeTierNote, IdentityBar, SetupManifest, SetupSection, readStoredKey, storeKey } from './ProviderPicker'
import { SessionRoom, StatusCard, createRoom, readStoredName, storeName } from './ActiveSession'
import { Icon } from './Composer'

const CODE_RE = /^[A-Z0-9]{4,10}$/

// Accepts a bare code or a pasted invite link (".../#/join/ABC123").
function readCode(value) {
  const raw = String(value || '')
  const fromLink = raw.match(/join\/([A-Za-z0-9]{4,10})/)
  return (fromLink ? fromLink[1] : raw).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10)
}

function inviteLink(code) {
  return `${window.location.origin}${window.location.pathname}#/join/${code}`
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall back below */ }
  // Plain-http LAN addresses have no async clipboard: use a hidden field.
  const active = document.activeElement
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  } catch {
    return false
  } finally {
    active?.focus?.({ preventScroll: true })
  }
}

function ShareBar({ session, room, runtime }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!session?.roomCode) return null

  const isStatic = runtime?.mode !== 'server'
  const copy = async () => {
    const link = inviteLink(session.roomCode)
    const ok = await copyText(link)
    if (!ok) { room?.notify?.(`Couldn’t copy. The invite link is ${link}`); return }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1800)
  }
  const relays = isStatic ? room?.relays : null

  return (
    <div className="share-bar">
      <span className="label-mono">Invite</span>
      <span className="room-code" aria-label={`Room code ${session.roomCode.split('').join(' ')}`}>{session.roomCode}</span>
      <button type="button" className={`copy-btn${copied ? ' is-done' : ''}`} onClick={copy}>
        <Icon name={copied ? 'check' : 'link'} size={14} />
        <span aria-live="polite">{copied ? 'Copied' : 'Copy invite link'}</span>
      </button>
      {relays != null && (
        <span className={`relay-chip ${relays > 0 ? 'ok' : 'down'}`} title="Encrypted relays this tab is connected to">
          <span className="relay-dot" aria-hidden="true" />
          {relays > 0 ? `Reachable · ${relays} relay${relays === 1 ? '' : 's'}` : 'Not reachable from other devices. Check your network.'}
        </span>
      )}
      <span className="share-note">
        {!isStatic
          ? 'On the same network? They can open this app’s network address and enter the code.'
          : room?.isHost
            ? 'Anyone with the link can join from any device. Rooms are end-to-end encrypted and live in this tab, so keep it open while others are in.'
            : 'The room lives in the host’s browser. If the host leaves, another open tab takes over.'}
      </span>
    </div>
  )
}

function LiveSetup({ runtime, providers, draft, setDraft, joinCode }) {
  const [name, setName] = useState(readStoredName)
  const [groqKey, setGroqKey] = useState(readStoredKey)
  const [code, setCode] = useState(() => joinCode || '')
  const [busy, setBusy] = useState(null) // 'create' | 'join' | null
  const [createError, setCreateError] = useState(null)
  const [joinError, setJoinError] = useState(null)
  const nameRef = useRef(null)
  const codeRef = useRef(null)
  const joinBtnRef = useRef(null)
  const joinCardRef = useRef(null)
  const uid = useId()
  const { sessionName, config, provider, model } = draft
  const patch = useCallback((next) => setDraft((d) => ({ ...d, ...next })), [setDraft])

  // #/join/CODE: prefill the code and put the cursor where the next keystroke belongs.
  useEffect(() => {
    if (!joinCode) return
    setCode(joinCode)
    setJoinError(null)
    const target = readStoredName() ? joinBtnRef.current : nameRef.current
    target?.focus({ preventScroll: true })
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    joinCardRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [joinCode])

  const requireName = (setError) => {
    const who = name.trim().slice(0, 40)
    if (!who) { setError('Enter your name first.'); nameRef.current?.focus(); return null }
    storeName(who)
    return who
  }

  const create = async (e) => {
    e?.preventDefault()
    if (busy) return
    setCreateError(null)
    if (!requireName(setCreateError)) return
    const key = groqKey.trim()
    if (provider === 'groq' && !key && !providers?.groq?.available) {
      setCreateError('Groq needs an API key (free at console.groq.com), or pick another brain.')
      return
    }
    setBusy('create')
    try {
      storeKey(key)
      const session = await createRoom(runtime, {
        mode: 'live',
        name: sessionName.trim() || 'Team session',
        provider,
        model,
        apiKey: provider === 'groq' ? key || null : null,
        config,
      })
      navigate(roomPath('live', session))
    } catch (err) {
      setCreateError(err?.message || 'Couldn’t create the room. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const join = async (e) => {
    e?.preventDefault()
    if (busy) return
    setJoinError(null)
    if (!requireName(setJoinError)) return
    const trimmed = readCode(code)
    if (!CODE_RE.test(trimmed)) {
      setJoinError('Room codes are 4 to 10 letters and numbers, like TXVHNS.')
      codeRef.current?.focus()
      return
    }
    if (runtime.mode !== 'server') { navigate(`/live/room/${trimmed}`); return }
    setBusy('join')
    try {
      const data = await api.joinByCode(trimmed)
      if (!data?.session?.id) throw new Error('No session found for that code.')
      navigate(roomPath('live', data.session))
    } catch (err) {
      setJoinError(err?.message || 'Couldn’t join that room.')
    } finally {
      setBusy(null)
    }
  }

  const startCard = (
    <form className="setup-card is-primary" onSubmit={create} aria-labelledby={`${uid}-start`} noValidate>
      <div className="setup-head">
        <span className="label-mono">New room</span>
        <h2 id={`${uid}-start`}>Start a room</h2>
        <p>You get a room code. Everyone who joins works with the same agents, live.</p>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-session`}>Room name</label>
        <input id={`${uid}-session`} value={sessionName} maxLength={80} onChange={(e) => patch({ sessionName: e.target.value })} />
      </div>
      <SetupSection>
        <CrewPicker mode="live" value={config} onChange={(next) => patch({ config: next })} provider={provider} />
      </SetupSection>
      <SetupSection label="Agent brain" labelId={`${uid}-brain`}>
        <ProviderFields
          runtime={runtime}
          providers={providers}
          provider={provider}
          setProvider={(p) => patch({ provider: p })}
          model={model}
          setModel={(m) => patch({ model: m })}
          groqKey={groqKey}
          setGroqKey={setGroqKey}
          labelledBy={`${uid}-brain`}
        />
        <FreeTierNote
          runtime={runtime}
          providers={providers}
          provider={provider}
          config={config}
          setProvider={(p) => patch({ provider: p })}
          setModel={(m) => patch({ model: m })}
        />
      </SetupSection>
      {createError && <div className="error-note" role="alert">{createError}</div>}
      <div className="setup-actions">
        <button type="submit" className="btn btn-primary" disabled={Boolean(busy)}>
          {busy === 'create' ? 'Creating…' : 'Create room'}
        </button>
        <SetupManifest mode="live" config={config} provider={provider} />
      </div>
    </form>
  )

  const joinCard = (
    <form
      ref={joinCardRef}
      className={`setup-card is-secondary${joinCode ? ' is-target' : ''}`}
      onSubmit={join}
      aria-labelledby={`${uid}-join`}
      noValidate
    >
      <div className="setup-head">
        <span className="label-mono">Have a code?</span>
        <h2 id={`${uid}-join`}>Join with a code</h2>
        <p>Enter the code someone shared, or paste their invite link.</p>
      </div>
      <div className="field setup-code">
        <label htmlFor={`${uid}-code`}>Room code</label>
        <input
          id={`${uid}-code`}
          ref={codeRef}
          value={code}
          placeholder="TXVHNS"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          aria-invalid={Boolean(joinError) || undefined}
          aria-describedby={joinError ? `${uid}-join-error` : undefined}
          onChange={(e) => { setCode(readCode(e.target.value)); if (joinError) setJoinError(null) }}
        />
      </div>
      {joinError && <div id={`${uid}-join-error`} className="error-note" role="alert">{joinError}</div>}
      <button ref={joinBtnRef} type="submit" className="btn btn-human" disabled={Boolean(busy)}>
        {busy === 'join' ? 'Joining…' : 'Join room'}
      </button>
      <p className="setup-foot">
        {runtime.mode === 'server'
          ? 'Try it on one machine: open a second tab and join the same code.'
          : 'Try it across devices: create a room here, then open the invite link on your phone.'}
      </p>
    </form>
  )

  return (
    <div className="setup-wrap">
      <IdentityBar name={name} setName={setName} inputRef={nameRef} />
      {startCard}
      {joinCard}
    </div>
  )
}

export function LiveSection({ runtime, route }) {
  const providers = useProviders(runtime)
  // The form survives a trip into a room and back.
  const [draft, setDraft] = useState(() => ({ sessionName: 'Team session', config: initialCrewConfig('live', 'free'), provider: 'free', model: '' }))
  useEffect(() => { clearCrewHint() }, [])
  const exit = useCallback(() => navigate('/live'), [])
  const fork = useCallback((session) => navigate(roomPath('live', session)), [])
  const renderShareBar = useCallback((session, room) => <ShareBar session={session} room={room} runtime={runtime} />, [runtime])

  if (route?.room) {
    return <SessionRoom runtime={runtime} section="live" room={route.room} renderShareBar={renderShareBar} onExit={exit} onFork={fork} />
  }
  if (!runtime) {
    return <StatusCard label="Live" title="Getting ready" detail="Checking how this site runs rooms…" />
  }
  return <LiveSetup runtime={runtime} providers={providers} draft={draft} setDraft={setDraft} joinCode={route?.join || ''} />
}
