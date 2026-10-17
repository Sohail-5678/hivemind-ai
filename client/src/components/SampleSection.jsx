import React, { useState } from 'react'
import { api } from '../lib/api'
import { ActiveSession } from './ActiveSession'
import { createLocalRoom } from '../hooks/useLocalRoom'
import { useProviders, ProviderFields, readStoredKey, storeKey } from './ProviderPicker'

export function SampleSection({ runtime }) {
  const providers = useProviders(runtime)
  const [name, setName] = useState(() => localStorage.getItem('hivemind_name') || '')
  const [sessionName, setSessionName] = useState('My first agent session')
  const [provider, setProvider] = useState('free')
  const [model, setModel] = useState('')
  const [groqKey, setGroqKey] = useState(readStoredKey)
  const [active, setActive] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setError(null)
    if (!name.trim()) { setError('Enter your name first.'); return }
    if (provider === 'groq' && !groqKey.trim() && !providers?.groq?.available) {
      setError('Groq needs an API key (free at console.groq.com) — or pick Simulated.')
      return
    }
    setBusy(true)
    try {
      localStorage.setItem('hivemind_name', name.trim())
      storeKey(groqKey.trim())
      const key = provider === 'groq' ? groqKey.trim() : null
      if (runtime.mode === 'server') {
        const body = { name: sessionName.trim() || 'Sample session', mode: 'sample', provider, model: model || undefined }
        if (key) body.apiKey = key
        const { session } = await api.createSession(body)
        setActive({ sessionId: session.id, userName: name.trim() })
      } else {
        const session = createLocalRoom({ name: sessionName.trim() || 'Sample session', mode: 'sample', provider, model: model || null })
        setActive({ roomCode: session.roomCode, userName: name.trim(), apiKey: key })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (active) {
    return (
      <>
        <div style={{ marginBottom: 12 }}>
          <button className="back-btn" onClick={() => setActive(null)}>← Leave session</button>
        </div>
        <ActiveSession mode={runtime.mode} sessionId={active.sessionId} roomCode={active.roomCode} userName={active.userName} apiKey={active.apiKey} preferHost onExit={() => setActive(null)} />
      </>
    )
  }

  return (
    <div className="setup-wrap">
      <div className="setup-card glass">
        <h3>Try the agent yourself</h3>
        <p className="hint">A private, solo session to learn the mechanics — send messages, redirect mid-stream, pause, resume, fork. It has no invite code by design; to work with others, use Live.</p>
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
        <button className="btn btn-primary" disabled={busy || !runtime} onClick={start}>{busy ? 'Starting…' : 'Start session'}</button>
      </div>

      <div className="setup-card glass">
        <h3>What to try once you're in</h3>
        <p className="hint">The moves that make HiveMind different from a chat window:</p>
        <div className="info-note">💬 <strong>Send a task</strong> — “Plan a launch for our new feature.”</div>
        <div className="info-note">↪ <strong>Redirect mid-stream</strong> — hit Redirect while it's writing and watch it change course without losing the thread.</div>
        <div className="info-note">⏸ <strong>Pause, then Resume</strong> — the agent picks up exactly where it stopped.</div>
        <div className="info-note">⑂ <strong>Fork</strong> — branch the whole session into a parallel exploration.</div>
      </div>
    </div>
  )
}
