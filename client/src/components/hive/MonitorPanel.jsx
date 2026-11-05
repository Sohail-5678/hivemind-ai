import React, { useRef } from 'react'
import { PATTERNS, clampConfig } from '@shared/swarm/patterns.js'
import { useNow } from './hooks'
import { OUTCOME, clock, estimateFor, estimateText, explainFlag, patternId, patternName, plural, providerLabel, teamOf } from './format'

const AXES = [['control', 'Control'], ['execution', 'Execution'], ['collaboration', 'Collaboration'], ['timing', 'Timing']]

// Elapsed time that keeps ticking between Monitor updates. The host's clock
// (startedAt) is trusted only when it agrees with the last reported elapsed
// time, so a viewer whose clock is off still sees a sane number.
function useElapsed(swarm) {
  const running = swarm?.status === 'running'
  const reported = Number(swarm?.monitor?.elapsedMs) || 0
  const received = useRef({ value: reported, at: Date.now() })
  if (received.current.value !== reported) received.current = { value: reported, at: Date.now() }
  const now = useNow(running)
  if (!running) return Number(swarm?.stats?.elapsedMs) || reported
  const local = received.current.value + Math.max(0, now - received.current.at)
  const wall = now - (Number(swarm?.startedAt) || 0)
  return Number(swarm?.startedAt) > 0 && wall >= reported && wall - local < 120_000 ? wall : local
}

function Meter({ calls, max }) {
  const total = Math.max(1, Math.min(24, max || 1))
  const used = Math.max(0, Math.min(total, calls))
  const warnAt = Math.ceil(total * 0.8)
  return (
    <div className="hv-meter" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} aria-label="Model calls used">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`hv-cell${i < used ? ' is-used' : ''}${i === total - 1 ? ' is-reserved' : ''}${i === warnAt - 1 ? ' is-warn' : ''}`}
          title={i === total - 1 ? 'Reserved for the final answer' : undefined}
        />
      ))}
    </div>
  )
}

export function MonitorPanel({ swarm, config, status, provider = 'simulated' }) {
  const pattern = swarm ? swarm.pattern || swarm.requested || 'auto' : patternId(config)
  const def = PATTERNS[pattern] || PATTERNS.auto
  const elapsed = useElapsed(swarm)

  if (!swarm) {
    const est = estimateFor(pattern, provider, config)
    const cfg = clampConfig(pattern, provider, config || {})
    return (
      <div className="hv-monitor">
        <p className="hv-monitor-intro">The Monitor is plain code, not a model. It watches the call budget, time and repeated output, and asks the people in the room before anything drastic happens.</p>
        <dl className="hv-tiles">
          <div className="hv-tile"><dt>Budget</dt><dd>{plural(cfg.maxCalls, 'call')}</dd></div>
          <div className="hv-tile"><dt>Estimate</dt><dd>{estimateText(est)}</dd></div>
        </dl>
        <Axes def={def} />
        <p className="hv-empty">{`No run yet. Estimates are for the ${providerLabel(provider)}.`}</p>
      </div>
    )
  }

  const monitor = swarm.monitor || {}
  const calls = Number(monitor.calls) || 0
  const maxCalls = Number(monitor.maxCalls) || Number(swarm.stats?.calls) || 0
  const tokens = Number(monitor.estTokens) || 0
  const team = Object.fromEntries(teamOf(swarm).map((a) => [a.id, a]))
  const flags = [...new Set(Array.isArray(monitor.flags) ? monitor.flags : [])]
  const running = swarm.status === 'running'
  const bids = Array.isArray(swarm.bids?.bids) ? swarm.bids.bids.filter((b) => b && b.agentId) : []
  const topScore = Math.max(1, ...bids.map((b) => Number(b.score) || 0))

  return (
    <div className="hv-monitor">
      <section className="hv-msec">
        <div className="hv-msec-head">
          <h3 className="hv-sec-title">Model calls</h3>
          <span className="hv-readout">{`${calls} / ${maxCalls || '?'}`}</span>
        </div>
        {maxCalls > 0 && <Meter calls={calls} max={maxCalls} />}
        <p className="hv-meter-note">The last cell is reserved for the final answer. At the limit the Monitor escalates to the room.</p>
      </section>

      <dl className="hv-tiles">
        <div className="hv-tile"><dt>Est. tokens</dt><dd>{tokens.toLocaleString('en-US')}</dd></div>
        <div className="hv-tile"><dt>Elapsed</dt><dd>{clock(elapsed)}</dd></div>
        <div className="hv-tile"><dt>Agents</dt><dd>{Object.keys(team).length}</dd></div>
        <div className="hv-tile"><dt>Brain</dt><dd>{providerLabel(swarm.provider || provider)}</dd></div>
      </dl>

      {!running && swarm.outcome && (
        <section className={`hv-outcome is-${swarm.outcome === 'completed' ? 'ok' : swarm.outcome === 'error' ? 'bad' : 'warn'}`}>
          <span className="label-mono">Outcome</span>
          <strong>{OUTCOME[swarm.outcome] || swarm.outcome}</strong>
          <span className="hv-outcome-stats">{`${plural(Number(swarm.stats?.calls ?? calls) || 0, 'call')} · ${clock(swarm.stats?.elapsedMs ?? elapsed)} · ${patternName(swarm.stats?.pattern || pattern)}`}</span>
        </section>
      )}

      <section className="hv-msec">
        <div className="hv-msec-head"><h3 className="hv-sec-title">Flags</h3><span className="hv-sec-count">{flags.length}</span></div>
        {flags.length ? (
          <ul className="hv-flags">
            {flags.map((f) => {
              const x = explainFlag(f, { team, pattern })
              return (
                <li key={f} className="hv-flag">
                  <span className="hv-flag-mark" aria-hidden="true" />
                  <div><strong>{x.title}</strong>{x.body && <p>{x.body}</p>}</div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="hv-empty">Nothing flagged. The Monitor watches the budget, repeated output and flagged messages.</p>
        )}
      </section>

      {swarm.architect && (
        <section className="hv-msec hv-architect">
          <div className="hv-msec-head"><h3 className="hv-sec-title">Architect’s choice</h3></div>
          <p><strong>{patternName(swarm.architect.pattern)}</strong>{swarm.architect.reason ? `: ${swarm.architect.reason}` : ''}</p>
        </section>
      )}

      {bids.length > 0 && (
        <section className="hv-msec">
          <div className="hv-msec-head">
            <h3 className="hv-sec-title">{`Bids to speak, turn ${Number(swarm.bids.round) || 1}`}</h3>
          </div>
          <ol className="hv-bids">
            {bids.map((b, i) => {
              const score = Number(b.score) || 0
              return (
                <li key={b.agentId} className={`hv-bid${i === 0 ? ' is-top' : ''}`}>
                  <span className="hv-bid-name">{team[b.agentId]?.name || b.agentId}</span>
                  <span className="hv-bid-bar" aria-hidden="true"><span style={{ width: `${Math.round((score / topScore) * 100)}%` }} /></span>
                  <span className="hv-bid-score">{score.toFixed(2)}</span>
                  {b.reason && <span className="hv-bid-why">{b.reason}</span>}
                </li>
              )
            })}
          </ol>
          <p className="hv-meter-note">The highest bid speaks. Scores are plain rules over the board, so every turn is explainable.</p>
        </section>
      )}

      <Axes def={def} />
      {status === 'paused' && <p className="hv-empty">The room is paused. Resume continues the goal with a fresh run.</p>}
    </div>
  )
}

function Axes({ def }) {
  return (
    <section className="hv-msec">
      <div className="hv-msec-head"><h3 className="hv-sec-title">{`${def.name} design`}</h3></div>
      <dl className="hv-axes">
        {AXES.map(([k, label]) => (
          <div key={k} className="hv-axis"><dt>{label}</dt><dd>{def.axes?.[k] || 'n/a'}</dd></div>
        ))}
      </dl>
    </section>
  )
}
