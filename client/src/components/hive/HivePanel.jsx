import React, { useEffect, useId, useRef, useState } from 'react'
import { PATTERNS, PATTERN_ORDER, clampConfig } from '@shared/swarm/patterns.js'
import { HiveGraph } from './HiveGraph'
import { BlackboardPanel } from './BlackboardPanel'
import { AgentRoster } from './AgentRoster'
import { AgentCardModal } from './AgentCardModal'
import { MonitorPanel } from './MonitorPanel'
import { LIVE_AGENT, OUTCOME, boardItemCount, estimateFor, estimateText, patternId, patternName, plural, teamOf } from './format'

const TABS = [['graph', 'Graph'], ['board', 'Board'], ['agents', 'Agents'], ['monitor', 'Monitor']]
const ENDED = { budget: 'Budget hit', paused: 'Paused', stopped: 'Stopped', redirected: 'Redirected', timeout: 'Timed out', lost: 'Host left', error: 'Error' }

function headerState(swarm, status) {
  if (status === 'paused') return { key: 'paused', label: 'Paused' }
  if (swarm?.status === 'running') return { key: 'live', label: 'Live' }
  if (status === 'running') return { key: 'live', label: 'Starting' }
  if (swarm?.status === 'done') {
    const o = swarm.outcome
    return { key: o === 'completed' ? 'done' : o === 'error' ? 'failed' : 'warn', label: o === 'completed' ? 'Done' : ENDED[o] || 'Ended', title: OUTCOME[o] }
  }
  return { key: 'idle', label: 'Ready' }
}

// The team side panel: what the agents are doing (Graph), what they share
// (Board), who they are (Agents) and what the Monitor sees (Monitor).
export function HivePanel({ swarm, blackboard, config, you, participants, status = 'idle', onAction, provider = 'simulated', readOnly = false }) {
  const id = useId()
  const [tab, setTab] = useState('graph')
  const [card, setCard] = useState(null)
  const tabRefs = useRef({})
  const cfg = config && typeof config === 'object' ? config : { crew: 'single', pattern: 'auto' }
  const configured = patternId(cfg)
  const brain = swarm?.provider || provider

  const idle = status === 'idle' && swarm?.status !== 'running'
  // After someone switches the architecture between runs, the graph previews
  // the next team; the last run stays one click away.
  const nextDiffers = Boolean(swarm) && idle && cfg.crew === 'team' && swarm.requested && swarm.requested !== configured
  const [graphView, setGraphView] = useState('next')
  useEffect(() => { setGraphView('next') }, [configured, swarm?.runId])
  const preview = !swarm || (nextDiffers && graphView === 'next')

  const shown = preview ? configured : swarm.pattern || swarm.requested || configured
  const choosing = !preview && swarm?.requested === 'auto' && !swarm?.pattern
  const def = PATTERNS[shown] || PATTERNS.auto
  const state = preview && swarm ? { key: 'idle', label: 'Ready', title: 'Showing the team for the next run' } : headerState(swarm, status)
  const team = preview ? [] : teamOf(swarm)
  const liveCount = team.filter((a) => LIVE_AGENT.has(a.status)).length
  const boardCount = boardItemCount(blackboard)
  const flagCount = preview ? 0 : new Set(Array.isArray(swarm?.monitor?.flags) ? swarm.monitor.flags : []).size
  const people = Array.isArray(participants) ? participants.length : 0

  const onTabKey = (e) => {
    const i = TABS.findIndex(([k]) => k === tab)
    let n = null
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = TABS.length - 1
    if (n === null) return
    e.preventDefault()
    setTab(TABS[n][0])
    tabRefs.current[TABS[n][0]]?.focus()
  }

  const counts = {
    board: boardCount ? { n: boardCount, label: plural(boardCount, 'item') } : null,
    agents: liveCount ? { n: liveCount, live: true, label: `${liveCount} working` } : team.length ? { n: team.length, label: plural(team.length, 'agent') } : null,
    monitor: flagCount ? { n: flagCount, warn: true, label: plural(flagCount, 'flag') } : null,
  }

  // A region, not a second <aside>: the room's side column is already the landmark.
  return (
    <section className="hv-panel" aria-label="Agent team">
      <header className="hv-head">
        <div className="hv-head-text">
          <span className="label-mono">{cfg.crew === 'team' || swarm ? (people > 1 ? `Hive · ${people} people` : 'Agent team') : 'Single agent'}</span>
          <h2 className="hv-title">
            {choosing ? 'Auto' : def.name}
            {!preview && swarm?.requested === 'auto' && swarm?.pattern && <span className="hv-title-tag">chosen by the Architect</span>}
          </h2>
          <span className="hv-aka">{choosing ? 'The Architect is choosing an architecture' : def.aka}</span>
        </div>
        <span className={`hv-state is-${state.key}`} title={state.title}>
          <span className={`dot${state.key === 'live' ? ' live' : state.key === 'failed' ? ' danger' : ''}`} aria-hidden="true" />
          {state.label}
        </span>
      </header>

      {nextDiffers && (
        <div className="hv-next" role="group" aria-label="Which team to show">
          <span>{`Next run: ${patternName(configured)}`}</span>
          <div className="seg hv-next-seg">
            <button type="button" className={graphView === 'next' ? 'active' : ''} aria-pressed={graphView === 'next'} onClick={() => setGraphView('next')}>Next</button>
            <button type="button" className={graphView === 'last' ? 'active' : ''} aria-pressed={graphView === 'last'} onClick={() => setGraphView('last')}>Last run</button>
          </div>
        </div>
      )}

      <div className="seg hv-tabs" role="tablist" aria-label="Team views" onKeyDown={onTabKey}>
        {TABS.map(([k, label]) => (
          <button
            key={k}
            ref={(el) => { tabRefs.current[k] = el }}
            type="button"
            role="tab"
            id={`${id}-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`${id}-pane`}
            tabIndex={tab === k ? 0 : -1}
            className={tab === k ? 'active' : ''}
            onClick={() => setTab(k)}
          >
            {label}
            {counts[k] && (
              <span className={`hv-tab-count${counts[k].live ? ' is-live' : counts[k].warn ? ' is-warn' : ''}`}>
                <span aria-hidden="true">{counts[k].n}</span>
                <span className="hv-sr">{`, ${counts[k].label}`}</span>
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="hv-body" role="tabpanel" id={`${id}-pane`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
        {tab === 'graph' && (
          <div className="hv-pane">
            <p className="hv-summary">{def.summary}</p>
            <HiveGraph
              swarm={preview ? null : swarm}
              blackboard={blackboard}
              config={preview ? cfg : { ...cfg, pattern: shown }}
              provider={brain}
              onSelect={setCard}
              preview={preview}
            />
          </div>
        )}
        {tab === 'board' && (
          <div className="hv-pane">
            <BlackboardPanel blackboard={blackboard} onAction={onAction} readOnly={readOnly} you={you} />
          </div>
        )}
        {tab === 'agents' && (
          <div className="hv-pane">
            <AgentRoster swarm={preview ? null : swarm} config={preview ? cfg : { ...cfg, pattern: shown }} provider={brain} onOpen={setCard} />
          </div>
        )}
        {tab === 'monitor' && (
          <div className="hv-pane">
            <MonitorPanel swarm={preview ? null : swarm} config={cfg} status={status} provider={brain} />
          </div>
        )}
      </div>

      {idle && !readOnly && (
        <ArchitectureSwitch config={cfg} provider={brain} onAction={onAction} readOnly={readOnly} hasRun={Boolean(swarm)} />
      )}

      <AgentCardModal agent={card} onClose={() => setCard(null)} />
    </section>
  )
}

// Between runs: change this room's architecture, or branch the room and run the
// same goal under another one to compare them side by side.
function ArchitectureSwitch({ config, provider, onAction, readOnly, hasRun }) {
  const id = useId()
  const current = config.crew === 'team' ? patternId(config) : null
  // Collapsed to one row by default so the panel keeps its height for the team.
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState(current || 'auto')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const toggleRef = useRef(null)
  useEffect(() => { setPick(current || 'auto') }, [current])

  const disabled = readOnly || typeof onAction !== 'function'
  const same = pick === current
  const est = estimateFor(pick, provider, {})

  const run = async (action, extra) => {
    if (disabled || busy) return
    setBusy(action)
    setError(null)
    try {
      await onAction(action, extra)
      if (action === 'set_config') {
        // The focused button collapses with the body: keep focus on the toggle.
        toggleRef.current?.focus({ preventScroll: true })
        setOpen(false)
      }
    } catch (err) {
      setError(err?.message || 'That did not go through. Try again.')
    } finally {
      setBusy(null)
    }
  }

  // New defaults for the new pattern: the old budget may be too small for it.
  const switchTo = () => run('set_config', { config: { ...config, crew: 'team', pattern: pick, ...clampConfig(pick, provider, {}) } })
  const fork = () => run('fork', { pattern: pick })

  return (
    <div className={`hv-switch${open ? '' : ' is-closed'}`}>
      <button ref={toggleRef} type="button" className="hv-switch-toggle" aria-expanded={open} aria-controls={open ? `${id}-body` : undefined} onClick={() => setOpen((v) => !v)}>
        <span>{hasRun ? 'Try another architecture' : 'Change architecture'}</span>
        <span className="hv-switch-chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="hv-switch-body" id={`${id}-body`}>
          <label className="hv-sr" htmlFor={`${id}-pick`}>Architecture</label>
          <span className="hv-select-wrap">
            <select id={`${id}-pick`} className="hv-select" value={pick} disabled={disabled} onChange={(e) => setPick(e.target.value)}>
              {PATTERN_ORDER.map((p) => <option key={p} value={p}>{`${PATTERNS[p].name}${p === current ? ' (current)' : ''}`}</option>)}
            </select>
          </span>
          {!same && <p className="hv-switch-est">{`${estimateText(est)}. ${PATTERNS[pick].usefulWhen}`}</p>}
          <div className="hv-switch-actions">
            <button type="button" className="btn btn-sm" disabled={disabled || same || busy !== null} onClick={switchTo}>
              {busy === 'set_config' ? 'Switching' : 'Switch architecture'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={disabled || same || busy !== null || !hasRun} onClick={fork} title={hasRun ? undefined : 'Run the team once, then fork to compare'}>
              {busy === 'fork' ? 'Forking' : 'Fork with another architecture'}
            </button>
          </div>
          {error && <p className="hv-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
