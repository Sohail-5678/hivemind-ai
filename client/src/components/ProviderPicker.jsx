import React, { useEffect, useId, useRef, useState } from 'react'
import { api } from '../lib/api'
import { PATTERNS, clampConfig, estimateCalls, estimateSeconds } from '@shared/swarm/patterns.js'
import { sanitizeCrewConfig, roomTypeName } from './SessionWorkspace'

// The setup-form kit shared by Sample and Live: which brains exist, the brain
// picker, the free-tier pace note, and the small pieces both forms are built from.

const STATIC_PROVIDERS = { simulated: { available: true }, free: { available: true }, ollama: { available: false, models: [] }, groq: { available: false, byok: true } }

const GROQ_MODELS = [
  { id: 'llama-3.1-8b-instant', note: 'fastest' },
  { id: 'llama-3.3-70b-versatile', note: 'smartest' },
  { id: 'openai/gpt-oss-20b', note: '' },
]
const GROQ_DEFAULT_MODEL = GROQ_MODELS[0].id

// Short names for summaries ("Hive · Debate · Groq") outside the picker.
export const PROVIDER_NAMES = { free: 'Free model', groq: 'Groq', simulated: 'Scripted', ollama: 'Ollama' }

// Which agent brains are available right now, for the current runtime.
export function useProviders(runtime) {
  const [providers, setProviders] = useState(null)
  useEffect(() => {
    if (!runtime) return undefined
    if (runtime.mode !== 'server') { setProviders(STATIC_PROVIDERS); return undefined }
    let alive = true
    api.providers()
      .then((p) => { if (alive) setProviders(p) })
      .catch(() => { if (alive) setProviders(STATIC_PROVIDERS) })
    return () => { alive = false }
  }, [runtime])
  return providers
}

// The Groq key lives in this tab only (sessionStorage): never in a URL, never on a server.
export function readStoredKey() {
  try { return sessionStorage.getItem('hivemind_groq_key') || '' } catch { return '' }
}
export function storeKey(key) {
  try { if (key) sessionStorage.setItem('hivemind_groq_key', key) } catch { /* fine */ }
}

function defaultOllamaModel(providers) {
  const models = providers?.ollama?.models || []
  return models.find((m) => m.startsWith('llama')) || models[0] || ''
}

// Each brain starts from its own default model; a model never carries across.
export function switchProvider(next, { providers, setProvider, setModel }) {
  setProvider(next)
  if (next === 'ollama') setModel(defaultOllamaModel(providers))
  else if (next === 'groq') setModel(GROQ_DEFAULT_MODEL)
  else setModel('')
}

function brainOptions(serverMode, providers) {
  const ollama = Boolean(providers?.ollama?.available)
  const groqOnServer = Boolean(providers?.groq?.available)
  const options = [
    { id: 'free', name: 'Free model', desc: 'Real answers with no key. About one reply every 30 s.', tag: 'No key', disabled: providers?.free?.available === false },
    { id: 'groq', name: 'Groq', desc: 'A fast real model on a free API key.', tag: groqOnServer ? 'Key on server' : 'Free key' },
    { id: 'simulated', name: 'Scripted', desc: 'Instant and offline. Canned replies, not a model.', tag: 'Offline' },
  ]
  if (serverMode) {
    options.push({ id: 'ollama', name: 'Ollama', desc: ollama ? 'A model running on this machine. Private.' : 'Not detected on this machine.', tag: 'Local', disabled: !ollama })
  }
  return options
}

// `labelledBy` points the radio group at a visible heading when the form has one.
export function ProviderFields({ runtime, providers, provider, setProvider, model, setModel, groqKey, setGroqKey, labelledBy }) {
  const ollamaAvailable = Boolean(providers?.ollama?.available)
  const serverMode = runtime?.mode === 'server'
  const uid = useId()
  const optionRefs = useRef({})

  useEffect(() => {
    // Default to a real local model when one is detected.
    if (ollamaAvailable && provider === 'free' && !model) {
      setProvider('ollama')
      setModel(defaultOllamaModel(providers))
    }
  }, [ollamaAvailable]) // eslint-disable-line react-hooks/exhaustive-deps

  const options = brainOptions(serverMode, providers)
  const enabled = options.filter((o) => !o.disabled)
  // Roving tabindex: the checked option is the one Tab lands on (or the first, if none is).
  const focusId = enabled.some((o) => o.id === provider) ? provider : enabled[0]?.id

  const choose = (next) => {
    if (next === provider) return
    switchProvider(next, { providers, setProvider, setModel })
  }

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    if (!enabled.length) return
    const at = Math.max(0, enabled.findIndex((o) => o.id === provider))
    const next = e.key === 'Home' ? enabled[0]
      : e.key === 'End' ? enabled[enabled.length - 1]
        : enabled[(at + step + enabled.length) % enabled.length]
    choose(next.id)
    optionRefs.current[next.id]?.focus()
  }

  const current = options.find((o) => o.id === provider) || null

  return (
    <div className="provider-picker">
      <div className="provider-seg" role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : 'Agent brain'} onKeyDown={onKeyDown}>
        {options.map((o) => {
          const checked = o.id === provider
          return (
            <button
              key={o.id}
              ref={(el) => { optionRefs.current[o.id] = el }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-describedby={checked && current ? `${uid}-detail` : undefined}
              disabled={o.disabled}
              title={o.disabled ? o.desc : undefined}
              tabIndex={o.id === focusId ? 0 : -1}
              className={`provider-opt${checked ? ' is-checked' : ''}`}
              onClick={() => choose(o.id)}
            >
              <span className="provider-mark" aria-hidden="true" />
              {o.name}
              {o.disabled && <span className="ws-sr"> ({o.desc.replace(/\.$/, '').toLowerCase()})</span>}
            </button>
          )
        })}
      </div>
      {current && (
        <p className="provider-detail" id={`${uid}-detail`}>
          <span className="badge agent">{current.tag}</span>
          <span>{current.desc}</span>
        </p>
      )}

      {provider === 'ollama' && ollamaAvailable && (
        <div className="field">
          <label htmlFor={`${uid}-ollama`}>Model</label>
          <select id={`${uid}-ollama`} value={model} onChange={(e) => setModel(e.target.value)}>
            {providers.ollama.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}

      {provider === 'groq' && (
        <div className="provider-groq">
          <div className="setup-row">
            <div className="field">
              <label htmlFor={`${uid}-key`}>
                Groq API key{providers?.groq?.available ? <span className="provider-optional"> optional, this server has one</span> : null}
              </label>
              <input
                id={`${uid}-key`}
                type="password"
                value={groqKey}
                placeholder="gsk_…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setGroqKey(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-groq-model`}>Model</label>
              <select id={`${uid}-groq-model`} value={model || GROQ_DEFAULT_MODEL} onChange={(e) => setModel(e.target.value)}>
                {GROQ_MODELS.map((m) => <option key={m.id} value={m.id}>{m.note ? `${m.id} (${m.note})` : m.id}</option>)}
              </select>
            </div>
          </div>
          <p className="provider-note">
            Get a free key at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer noopener">console.groq.com</a> under API Keys.
            It goes from your browser to Groq {serverMode ? 'through this server' : 'through an edge proxy'}, stays in this tab only, and is never saved on a server.
          </p>
        </div>
      )}
    </div>
  )
}

export function formatDuration(seconds) {
  const s = Math.max(1, Math.round(Number(seconds) || 0))
  if (s < 90) return `${s} s`
  return `${Math.round(s / 60)} min`
}

// A team on the free tier is honest-but-slow: say so before the room exists,
// with the real estimate, and offer the two fast brains in one click.
export function FreeTierNote({ runtime, providers, provider, config, setProvider, setModel }) {
  if (provider !== 'free' || config?.crew !== 'team') return null
  const pattern = PATTERNS[config.pattern] ? config.pattern : 'auto'
  const sized = clampConfig(pattern, 'free', config)
  const calls = estimateCalls(pattern, sized)
  const seconds = estimateSeconds(pattern, 'free', sized)
  const where = runtime?.mode === 'server' ? 'from this server' : 'from each device'
  const use = (next) => switchProvider(next, { providers, setProvider, setModel })

  return (
    <div className="provider-warn" role="note">
      <div className="provider-warn-head">
        <span className="provider-warn-dot" aria-hidden="true" />
        <span className="label-mono">Free tier pace</span>
        <span className="provider-warn-readout">~{calls} calls · ~{formatDuration(seconds)}</span>
      </div>
      <p>
        The free model answers about once every 30 seconds {where}, so this team needs
        roughly {formatDuration(seconds)} per goal{pattern === 'auto' ? ', depending on the architecture the Architect picks' : ''}.
        For a fast demo, switch to Groq with a free key or to the scripted brain.
      </p>
      <div className="provider-warn-actions">
        <button type="button" className="btn btn-sm" onClick={() => use('groq')}>Use Groq</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => use('simulated')}>Use the scripted brain</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- form pieces

function initials(name) {
  return String(name || '').trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

// One name for the whole screen, previewed as the avatar the room will show.
export function IdentityBar({ name, setName, inputRef, note = 'Shown to everyone in the room. Saved in this browser.' }) {
  const uid = useId()
  const mark = initials(name)
  return (
    <div className="setup-identity">
      <span className={`avatar-neu human setup-avatar${mark ? '' : ' is-empty'}`} aria-hidden="true">{mark}</span>
      <div className="field">
        <label htmlFor={`${uid}-name`}>Your name</label>
        <input
          id={`${uid}-name`}
          ref={inputRef}
          value={name}
          maxLength={40}
          placeholder="e.g. Alex"
          autoComplete="nickname"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <p className="setup-identity-note">{note}</p>
    </div>
  )
}

// A divided block of a setup card. Without a label it is only the divider
// (CrewPicker brings its own legends).
export function SetupSection({ label = null, labelId, aside = null, children }) {
  return (
    <section className="setup-section" aria-labelledby={label ? labelId : undefined}>
      {label && (
        <div className="setup-section-head">
          <h3 id={labelId} className="label-mono">{label}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

// What the button will create, as a mono readout: "Hive · Debate · ~7 calls · Groq".
export function SetupManifest({ mode, config, provider }) {
  const clean = sanitizeCrewConfig(config, provider)
  const items = [roomTypeName(mode, clean.crew)]
  if (clean.crew === 'team') items.push(PATTERNS[clean.pattern].name, `~${estimateCalls(clean.pattern, clean)} calls`)
  items.push(PROVIDER_NAMES[provider] || provider)
  return (
    <ul className="setup-manifest" aria-label="This room">
      {items.map((t) => <li key={t}>{t}</li>)}
    </ul>
  )
}
