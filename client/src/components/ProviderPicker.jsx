import React, { useEffect, useState } from 'react'
import { api } from '../lib/api'

const STATIC_PROVIDERS = { simulated: { available: true }, ollama: { available: false, models: [] }, groq: { available: false, byok: true } }

// Which agent brains are available right now, for the current runtime.
export function useProviders(runtime) {
  const [providers, setProviders] = useState(null)
  useEffect(() => {
    if (!runtime) return
    if (runtime.mode !== 'server') { setProviders(STATIC_PROVIDERS); return }
    api.providers().then(setProviders).catch(() => setProviders(STATIC_PROVIDERS))
  }, [runtime])
  return providers
}

export function readStoredKey() {
  try { return sessionStorage.getItem('hivemind_groq_key') || '' } catch { return '' }
}
export function storeKey(key) {
  try { if (key) sessionStorage.setItem('hivemind_groq_key', key) } catch { /* fine */ }
}

export function ProviderFields({ runtime, providers, provider, setProvider, model, setModel, groqKey, setGroqKey }) {
  const ollamaAvailable = Boolean(providers?.ollama?.available)
  const serverMode = runtime?.mode === 'server'

  useEffect(() => {
    // Default to a real local model when one is detected.
    if (ollamaAvailable && provider === 'simulated' && !model) {
      setProvider('ollama')
      setModel(providers.ollama.models.find((m) => m.startsWith('llama')) || providers.ollama.models[0] || '')
    }
  }, [ollamaAvailable]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="field">
        <label>Agent brain</label>
        <select
          value={provider}
          onChange={(e) => {
            // Each brain starts from its own default model — never carry one across.
            const next = e.target.value
            setProvider(next)
            if (next === 'ollama') {
              const models = providers?.ollama?.models || []
              setModel(models.find((m) => m.startsWith('llama')) || models[0] || '')
            } else if (next === 'groq') {
              setModel('llama-3.1-8b-instant')
            } else {
              setModel('')
            }
          }}
        >
          <option value="simulated">Simulated — instant, no setup</option>
          {serverMode && (
            <option value="ollama" disabled={!ollamaAvailable}>
              {ollamaAvailable ? 'Ollama — local model, private' : 'Ollama — not detected on this machine'}
            </option>
          )}
          <option value="groq">Groq — real LLM, free API key</option>
        </select>
      </div>
      {provider === 'ollama' && ollamaAvailable && (
        <div className="field">
          <label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {providers.ollama.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}
      {provider === 'groq' && (
        <>
          <div className="field">
            <label>Groq API key {providers?.groq?.available ? '(optional — server already has one)' : ''}</label>
            <input
              type="password"
              value={groqKey}
              placeholder="gsk_…  (used for this session only, never stored on a server)"
              onChange={(e) => setGroqKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Model</label>
            <select value={model || 'llama-3.1-8b-instant'} onChange={(e) => setModel(e.target.value)}>
              <option value="llama-3.1-8b-instant">llama-3.1-8b-instant — fastest</option>
              <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile — smartest</option>
              <option value="openai/gpt-oss-20b">openai/gpt-oss-20b</option>
            </select>
          </div>
          <div className="info-note">Free key at console.groq.com → API Keys. It goes straight from your browser to Groq{serverMode ? ' via this server' : ' via an edge proxy'} and is never persisted.</div>
        </>
      )}
    </>
  )
}
