import React, { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { ActiveSession } from './ActiveSession'
import { createLocalRoom } from '../hooks/useLocalRoom'
import { useProviders, ProviderFields, readStoredKey, storeKey } from './ProviderPicker'

export function LiveSection({ runtime, initialCode = '' }) {
  const providers = useProviders(runtime)
  const [name, setName] = useState(() => localStorage.getItem('hivemind_name') || '')
  const [sessionName, setSessionName] = useState('Team session')
  const [provider, setProvider] = useState('simulated')
  const [model, setModel] = useState('')
  const [groqKey, setGroqKey] = useState(readStoredKey)
  const [code, setCode] = useState(initialCode)
  const [active, setActive] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => { if (initialCode) setCode(initialCode) }, [initialCode])

  const requireName = () => {
    if (!name.trim()) { setError('Enter your name first.'); return false }
    localStorage.setItem('hivemind_name', name.trim())
    return true
  }

  const create = async () => {
    setError(null)
    if (!requireName()) return
    if (provider === 'groq' && !groqKey.trim() && !providers?.groq?.available) {
      setError('Groq needs an API key (free at console.groq.com) — or pick Simulated.')
      return
    }
    setBusy(true)
    try {
      storeKey(groqKey.trim())
      const key = provider === 'groq' ? groqKey.trim() : null
      if (runtime.mode === 'server') {
        const body = { name: sessionName.trim() || 'Team session', mode: 'live', provider, model: model || undefined }
        if (key) body.apiKey = key
        const { session } = await api.createSession(body)
        setActive({ sessionId: session.id, userName: name.trim(), preferHost: true })
      } else {
        const session = createLocalRoom({ name: sessionName.trim() || 'Team session', mode: 'live', provider, model: model || null })
        setActive({ roomCode: session.roomCode, userName: name.trim(), apiKey: key, preferHost: true })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    setError(null)
    if (!requireName()) return
    const trimmed = code.trim().toUpperCase()
    if (!trimmed) { setError('Enter a room code.'); return }
    setBusy(true)
    try {
      if (runtime.mode === 'server') {
        const { session } = await api.joinByCode(trimmed)
        setActive({ sessionId: session.id, userName: name.trim(), preferHost: false })
      } else {
        setActive({ roomCode: trimmed, userName: name.trim(), apiKey: groqKey.trim() || null, preferHost: false })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const copyInvite = (session) => {
    const url = `${window.location.origin}/#/join/${session.roomCode}`
    navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const leave = () => { setActive(null); window.location.hash = '' }

  if (active) {
    const isStatic = runtime.mode !== 'server'
    return (
      <>
        <div style={{ marginBottom: 12 }}>
          <button className="back-btn" onClick={leave}>← Leave session</button>
        </div>
        <ActiveSession
          mode={runtime.mode}
          sessionId={active.sessionId}
          roomCode={active.roomCode}
          userName={active.userName}
          apiKey={active.apiKey}
          preferHost={active.preferHost}
          onExit={leave}
          renderShareBar={(session) => session && (
            <div className="share-bar">
              <span>Invite your team:</span>
              <span className="room-code">{session.roomCode}</span>
              <button className="copy-btn" onClick={() => copyInvite(session)}>{copied ? '✓ Copied' : 'Copy invite link'}</button>
              <span style={{ opacity: 0.8 }}>
                {isStatic
                  ? 'Open the link in another tab of this browser — it syncs live. Run the Node server locally for cross-device rooms.'
                  : 'Same WiFi? They can open this app\'s Network URL and enter the code.'}
              </span>
            </div>
          )}
        />
      </>
    )
  }

  return (
    <div className="setup-wrap">
      <div className="setup-card glass">
        <h3>Start a team session</h3>
        <p className="hint">You get a room code — anyone who joins sees the same live agent, in real time.</p>
        {error && <div className="error-note">{error}</div>}
        <div className="field">
          <label>Your name</label>
          <input value={name} maxLength={40} placeholder="e.g. Alex" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Session name</label>
          <input value={sessionName} maxLength={80} onChange={(e) => setSessionName(e.target.value)} />
        </div>
        <ProviderFields runtime={runtime} providers={providers} provider={provider} setProvider={setProvider} model={model} setModel={setModel} groqKey={groqKey} setGroqKey={setGroqKey} />
        <button className="btn btn-primary" disabled={busy || !runtime} onClick={create}>{busy ? 'Creating…' : 'Create session'}</button>
      </div>

      <div className="setup-card glass">
        <h3>Join with a code</h3>
        <p className="hint">Someone shared a room code or invite link with you? Enter it here.</p>
        <div className="field">
          <label>Your name</label>
          <input value={name} maxLength={40} placeholder="e.g. Sam" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Room code</label>
          <input
            value={code}
            maxLength={8}
            placeholder="e.g. TXVHNS"
            style={{ textTransform: 'uppercase', letterSpacing: '0.15em', fontFamily: 'var(--mono)' }}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') join() }}
          />
        </div>
        <button className="btn btn-red" disabled={busy || !runtime} onClick={join}>{busy ? 'Joining…' : 'Join session'}</button>
        <div className="info-note">
          {runtime?.mode === 'server'
            ? 'Tip: open two browser tabs and join the same code to see the multiplayer magic on one machine.'
            : 'Tip: create a session, then open the invite link in a second tab — both tabs share one live agent.'}
        </div>
      </div>
    </div>
  )
}
