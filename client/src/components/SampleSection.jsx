import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { navigate, roomPath } from '../lib/router'
import { CrewPicker, initialCrewConfig, clearCrewHint } from './hive'
import { useProviders, ProviderFields, FreeTierNote, IdentityBar, SetupManifest, SetupSection, readStoredKey, storeKey } from './ProviderPicker'
import { SessionRoom, StatusCard, createRoom, readStoredName, storeName } from './ActiveSession'
import { Icon } from './Composer'
import { PATTERNS } from '@shared/swarm/patterns.js'

// The moves worth trying once inside, for one agent and for a team. `fits`
// marks a tip that the chosen architecture shows off best.
const SOLO_TIPS = [
  { icon: 'message', title: 'Give it a task', text: '“Plan a launch for our new feature.”' },
  { icon: 'redirect', title: 'Redirect mid-answer', text: 'Hit Redirect while it writes. It changes course and keeps the thread.' },
  { icon: 'pause', title: 'Pause, then resume', text: 'It picks up exactly where it stopped.' },
  { icon: 'fork', title: 'Fork', text: 'Branch the whole session to try another direction. The original stays as it was.' },
]
const TEAM_TIPS = [
  { icon: 'pin', title: 'Pin a constraint', text: 'Open the Board and pin something like “budget under $5k”. Every agent has to respect it.' },
  { icon: 'at', title: '@mention an agent', text: '“@critic check the numbers.” In a Swarm it raises that agent’s bid to speak; in other teams the agent sees your note marked for it.', fits: ['swarm'] },
  { icon: 'vote', title: 'Vote in a debate', text: 'With Peer-to-peer, the agents propose answers and you vote alongside them. Ties go to the humans.', fits: ['debate'] },
  { icon: 'flag', title: 'Approve an escalation', text: 'When the Monitor hits the budget or spots a loop, it stops and asks you: continue or wrap up.' },
  { icon: 'fork', title: 'Fork with another architecture', text: 'Re-run the same goal with a different team and compare the calls, the time and the answer.' },
]

function TipsCard({ config }) {
  const team = config?.crew === 'team'
  const tips = team ? TEAM_TIPS : SOLO_TIPS
  const pattern = PATTERNS[config?.pattern] ? config.pattern : 'auto'
  const uid = useId()
  return (
    <section className="setup-card is-secondary setup-tips" aria-labelledby={`${uid}-tips`}>
      <div className="setup-head">
        <span className="label-mono">{team ? 'Agent team' : 'Solo'}</span>
        <h2 id={`${uid}-tips`}>What to try once you’re in</h2>
        <p>{team ? 'You’re part of the team, not just watching it.' : 'The moves that make this more than a chat window.'}</p>
      </div>
      <ol className="setup-tip-list">
        {tips.map((t) => (
          <li key={t.title} className="setup-tip">
            <span className="setup-tip-icon" aria-hidden="true"><Icon name={t.icon} /></span>
            <span className="setup-tip-body">
              <span className="setup-tip-title">
                {t.title}
                {t.fits?.includes(pattern) && <span className="badge agent">This team</span>}
              </span>
              <span className="setup-tip-text">{t.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {team && (
        <p className="setup-foot">
          Agents have no tools. They work from the conversation and what they already know, and flag anything that needs checking.
        </p>
      )}
    </section>
  )
}

function SampleSetup({ runtime, providers, draft, setDraft }) {
  const [name, setName] = useState(readStoredName)
  const [groqKey, setGroqKey] = useState(readStoredKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const nameRef = useRef(null)
  const uid = useId()
  const { sessionName, config, provider, model } = draft
  const patch = useCallback((next) => setDraft((d) => ({ ...d, ...next })), [setDraft])

  const start = async (e) => {
    e?.preventDefault()
    if (busy) return
    setError(null)
    const who = name.trim().slice(0, 40)
    if (!who) { setError('Enter your name first.'); nameRef.current?.focus(); return }
    const key = groqKey.trim()
    if (provider === 'groq' && !key && !providers?.groq?.available) {
      setError('Groq needs an API key (free at console.groq.com), or pick another brain.')
      return
    }
    setBusy(true)
    try {
      storeName(who)
      storeKey(key)
      const session = await createRoom(runtime, {
        mode: 'sample',
        name: sessionName.trim() || 'Sample session',
        provider,
        model,
        apiKey: provider === 'groq' ? key || null : null,
        config,
      })
      navigate(roomPath('sample', session))
    } catch (err) {
      setError(err?.message || 'Couldn’t start the session. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-wrap">
      <IdentityBar name={name} setName={setName} inputRef={nameRef} note="Shown on your messages. Saved in this browser." />
      <form className="setup-card is-primary" onSubmit={start} aria-labelledby={`${uid}-start`} noValidate>
        <div className="setup-head">
          <span className="label-mono">Private</span>
          <h2 id={`${uid}-start`}>Start a private session</h2>
          <p>Just you and the agents, to learn the moves. There’s no invite code; to work with others, use Live.</p>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-session`}>Session name</label>
          <input id={`${uid}-session`} value={sessionName} maxLength={80} onChange={(e) => patch({ sessionName: e.target.value })} />
        </div>
        <SetupSection>
          <CrewPicker mode="sample" value={config} onChange={(next) => patch({ config: next })} provider={provider} />
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
        {error && <div className="error-note" role="alert">{error}</div>}
        <div className="setup-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Starting…' : 'Start session'}</button>
          <SetupManifest mode="sample" config={config} provider={provider} />
        </div>
      </form>
      <TipsCard config={config} />
    </div>
  )
}

export function SampleSection({ runtime, route }) {
  const providers = useProviders(runtime)
  // The form survives a trip into a session and back.
  const [draft, setDraft] = useState(() => ({ sessionName: 'My first agent session', config: initialCrewConfig('sample', 'free'), provider: 'free', model: '' }))
  useEffect(() => { clearCrewHint() }, [])
  const exit = useCallback(() => navigate('/sample'), [])
  const fork = useCallback((session) => navigate(roomPath('sample', session)), [])

  if (route?.room) {
    return <SessionRoom runtime={runtime} section="sample" room={route.room} onExit={exit} onFork={fork} />
  }
  if (!runtime) {
    return <StatusCard label="Sample" title="Getting ready" detail="Checking how this site runs rooms…" />
  }
  return <SampleSetup runtime={runtime} providers={providers} draft={draft} setDraft={setDraft} />
}
