import React, { useEffect, useId, useRef } from 'react'
import { PATTERNS, PATTERN_ORDER, TURN_TAKING, clampConfig, turnTakingFor } from '@shared/swarm/patterns.js'
import { PatternGlyph, RoomGlyph } from './PatternGlyph'
import { plannedTeam } from './roster'
import { estimateFor, estimateText, glyph, patternId, plural, providerLabel } from './format'

const ROOM_TYPES = {
  sample: [
    { crew: 'single', glyph: 'solo', name: 'Solo', sub: 'You and one agent. Quick answers you can steer as they stream.', meta: '1 person · 1 agent' },
    { crew: 'team', glyph: 'team', name: 'Agent team', sub: 'You and a team of agents, organized by an architecture you choose.', meta: '1 person · a team of agents' },
  ],
  live: [
    { crew: 'single', glyph: 'multiplayer', name: 'Multiplayer', sub: 'Your people and one shared agent, live in the same room.', meta: 'many people · 1 agent' },
    { crew: 'team', glyph: 'hive', name: 'Hive', sub: 'Your people and a team of agents working on one goal together.', meta: 'many people · a team of agents' },
  ],
}

// How the `width` knob reads for each pattern. Values are engine widths; `show`
// is what that width means in the run (see the pattern runners in engine.js).
const WIDTH_KNOB = {
  hierarchical: { label: 'Branching', values: [1, 2, 3], show: (w) => `${w} × ${w}`, hint: (w) => `${plural(w, 'manager')}, ${plural(w, 'worker')} each` },
  fanout: { label: 'Personas', values: [2, 3, 4], show: (w) => String(w), hint: (w) => `${w} personas explore in parallel` },
  orchestrator: { label: 'Subtasks', values: [1, 2, 3], show: (w) => String(Math.min(4, w + 1)), hint: (w) => `Up to ${Math.min(4, w + 1)} delegated subtasks` },
  parallel: { label: 'Tasks', values: [1, 2, 3], show: (w) => String(Math.min(5, w + 2)), hint: (w) => `Up to ${Math.min(5, w + 2)} tasks in the graph` },
}
const AXES = [['control', 'Control'], ['execution', 'Execution'], ['collaboration', 'Collaboration'], ['timing', 'Timing']]

// New rooms start as a single-agent room in both modes; the mode argument keeps
// call sites explicit.
export function defaultCrewConfig(mode) { // eslint-disable-line no-unused-vars
  return { crew: 'single', pattern: 'auto' }
}

const sanitize = (pattern, provider, raw) => ({ crew: 'team', pattern, ...clampConfig(pattern, provider, raw || {}) })

// A room card on Home ("Agent team", "Hive") asks for the team version of the
// setup form it opens. Module scope on purpose: it only has to survive the hop
// from Home to the section, and it goes stale after a few seconds.
const HINT_TTL_MS = 5000
let crewHint = null
export function hintCrew(mode, crew) {
  crewHint = { mode, crew, at: Date.now() }
}
// Read in a state initializer (React may call it twice in development); the
// section clears the hint once it has mounted.
export function initialCrewConfig(mode, provider) {
  const hint = crewHint && crewHint.mode === mode && Date.now() - crewHint.at < HINT_TTL_MS ? crewHint.crew : null
  return hint === 'team' ? sanitize('auto', provider, {}) : defaultCrewConfig(mode)
}
export function clearCrewHint() {
  crewHint = null
}
const derivedBudget = (pattern, provider, cfg) => clampConfig(pattern, provider, { ...cfg, maxCalls: undefined }).maxCalls

export function CrewPicker({ mode = 'sample', value, onChange, provider = 'free' }) {
  const id = useId()
  const gridRef = useRef(null)
  const cardRefs = useRef({})
  const turnRefs = useRef({})
  // Knobs follow the pattern's (and the brain's) defaults until the person
  // touches them. Only the knobs actually set are kept: picking a turn-taking
  // strategy must not pin a free-model team size after a switch to another brain.
  const touched = useRef(new Set())
  const kept = () => Object.fromEntries([...touched.current].filter((k) => k in config).map((k) => [k, config[k]]))
  const prevProvider = useRef(provider)
  const config = value || defaultCrewConfig(mode)
  const team = config.crew === 'team'
  const pattern = patternId(config)
  const cfg = clampConfig(pattern, provider, config)
  const emit = (next) => onChange?.(next)

  useEffect(() => {
    if (prevProvider.current === provider) return
    prevProvider.current = provider
    if (!team) return
    emit(sanitize(pattern, provider, kept()))
  }, [provider]) // eslint-disable-line react-hooks/exhaustive-deps

  const chooseCrew = (crew) => {
    if (crew === config.crew) return
    if (crew === 'single') emit({ ...config, crew: 'single', pattern })
    else emit(sanitize(pattern, provider, kept()))
  }

  const choosePattern = (next) => {
    if (next === pattern && team) return
    touched.current = new Set()
    emit(sanitize(next, provider, {}))
  }

  const setKnob = (patch) => {
    for (const k of Object.keys(patch)) touched.current.add(k)
    const next = { ...cfg, ...patch }
    // Width and rounds change the call estimate: keep the budget on its default
    // if it was still on the old default, so the run is not starved.
    if (!('maxCalls' in patch) && cfg.maxCalls === derivedBudget(pattern, provider, cfg)) next.maxCalls = derivedBudget(pattern, provider, next)
    emit(sanitize(pattern, provider, next))
  }

  // Turn-taking cards: a radio group with roving focus, like the grid above.
  const onTurnKey = (e) => {
    const list = turnTakingFor(pattern)
    const i = Math.max(0, list.indexOf(cfg.turnTaking))
    const n = list.length
    let next
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': next = (i + 1) % n; break
      case 'ArrowLeft': case 'ArrowUp': next = (i - 1 + n) % n; break
      case 'Home': next = 0; break
      case 'End': next = n - 1; break
      default: return
    }
    e.preventDefault()
    setKnob({ turnTaking: list[next] })
    turnRefs.current[list[next]]?.focus()
  }

  const onGridKey = (e) => {
    const i = PATTERN_ORDER.indexOf(pattern)
    const tpl = gridRef.current && typeof window !== 'undefined' ? window.getComputedStyle(gridRef.current).gridTemplateColumns : ''
    const cols = Math.max(1, tpl ? tpl.split(' ').filter(Boolean).length : 3)
    const n = PATTERN_ORDER.length
    let next
    switch (e.key) {
      case 'ArrowRight': next = (i + 1) % n; break
      case 'ArrowLeft': next = (i - 1 + n) % n; break
      case 'ArrowDown': next = Math.min(n - 1, i + cols); break
      case 'ArrowUp': next = Math.max(0, i - cols); break
      case 'Home': next = 0; break
      case 'End': next = n - 1; break
      default: return
    }
    e.preventDefault()
    const target = PATTERN_ORDER[next]
    choosePattern(target)
    cardRefs.current[target]?.focus()
  }

  const rooms = ROOM_TYPES[mode] || ROOM_TYPES.sample
  const def = PATTERNS[pattern]
  const est = estimateFor(pattern, provider, cfg)
  const knob = WIDTH_KNOB[pattern]
  const freeTier = provider === 'free'
  const widthValues = knob ? knob.values.filter((w) => !freeTier || w <= 3) : []
  const width = knob ? Math.max(widthValues[0], Math.min(widthValues[widthValues.length - 1], cfg.width)) : cfg.width
  const budgetMin = pattern === 'auto' ? 4 : 2
  const budgetMax = 16
  const estCalls = est.range ? est.range.hi : est.calls
  const estPct = Math.max(0, Math.min(100, ((estCalls - budgetMin) / (budgetMax - budgetMin)) * 100))
  const budgetPct = ((cfg.maxCalls - budgetMin) / (budgetMax - budgetMin)) * 100
  const roster = plannedTeam({ ...cfg, pattern }, provider)
  const turns = turnTakingFor(pattern)
  const turn = TURN_TAKING[cfg.turnTaking]

  return (
    <div className="hv-crew">
      <div className="hv-crew-sec">
        <div className="hv-crew-legend"><span id={`${id}-rooms`} className="label-mono">Room type</span></div>
        <div className="hv-rooms" role="radiogroup" aria-labelledby={`${id}-rooms`}>
          {rooms.map((r) => {
            const on = config.crew === r.crew || (r.crew === 'single' && config.crew !== 'team')
            return (
              <button
                key={r.crew}
                type="button"
                role="radio"
                aria-checked={on}
                className={`hv-room${on ? ' is-on' : ''}`}
                onClick={() => chooseCrew(r.crew)}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
                  e.preventDefault()
                  const other = rooms.find((x) => x.crew !== r.crew)
                  chooseCrew(other.crew)
                  e.currentTarget.parentElement?.querySelector(`[data-crew="${other.crew}"]`)?.focus()
                }}
                tabIndex={on ? 0 : -1}
                data-crew={r.crew}
              >
                <span className="hv-radio" aria-hidden="true" />
                <RoomGlyph kind={r.glyph} className="hv-room-art" />
                <span className="hv-room-name">{r.name}</span>
                <span className="hv-room-sub">{r.sub}</span>
                <span className="hv-room-meta">{r.meta}</span>
              </button>
            )
          })}
        </div>
      </div>

      {team && (
        <>
          <div className="hv-crew-sec">
            <div className="hv-crew-legend">
              <span id={`${id}-arch`} className="label-mono">Architecture</span>
              <span className="hv-crew-count">{`${PATTERN_ORDER.length} architectures`}</span>
            </div>
            <div ref={gridRef} className="hv-arch-grid" role="radiogroup" aria-labelledby={`${id}-arch`} onKeyDown={onGridKey}>
              {PATTERN_ORDER.map((pid) => {
                const p = PATTERNS[pid]
                const on = pid === pattern
                const e = estimateFor(pid, provider, pid === pattern ? cfg : {})
                return (
                  <button
                    key={pid}
                    ref={(el) => { cardRefs.current[pid] = el }}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`${p.name}, ${p.aka}`}
                    aria-describedby={on ? `${id}-summary` : undefined}
                    tabIndex={on ? 0 : -1}
                    className={`hv-arch${on ? ' is-on' : ''}`}
                    onClick={() => choosePattern(pid)}
                  >
                    <PatternGlyph pattern={pid} size={44} />
                    <span className="hv-arch-name">{p.name}</span>
                    <span className="hv-arch-aka">{p.aka}</span>
                    <span className="hv-arch-calls">{e.range ? `${e.range.lo}–${e.range.hi} calls` : plural(e.calls, 'call')}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="hv-detail">
            <div className="hv-detail-head">
              <span className="hv-detail-glyph" aria-hidden="true"><PatternGlyph pattern={pattern} size={64} /></span>
              <div className="hv-detail-title">
                <h3>{def.name}</h3>
                <span className="hv-aka">{def.aka}</span>
              </div>
              <div className="hv-est">
                <span className="label-mono">Estimate</span>
                <strong>{estimateText(est)}</strong>
                <span className="hv-est-sub">{`on the ${providerLabel(provider)}`}</span>
              </div>
            </div>
            <p id={`${id}-summary`} className="hv-detail-summary">{def.summary}</p>
            <p className="hv-when"><span className="label-mono">Useful when</span>{def.usefulWhen}</p>
            <div className="hv-pc">
              <ul className="hv-pros" aria-label="Strengths">{def.pros.map((x) => <li key={x}>{x}</li>)}</ul>
              <ul className="hv-cons" aria-label="Costs">{def.cons.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <dl className="hv-axes">
              {AXES.map(([k, label]) => <div key={k} className="hv-axis"><dt>{label}</dt><dd>{def.axes[k]}</dd></div>)}
            </dl>
            <div className="hv-team" aria-label="Team">
              <span className="label-mono">Team</span>
              <ul className="hv-team-list">
                {roster.map((a) => (
                  <li key={a.id} className="hv-team-chip" title={a.description}>
                    <span className="hv-team-glyph" aria-hidden="true">{glyph(a.glyph)}</span>
                    {a.name}
                    {a.count > 1 && <span className="hv-team-count">{`× ${a.count}`}</span>}
                  </li>
                ))}
                {pattern === 'auto' && <li className="hv-team-chip is-ghost">+ the team it designs</li>}
              </ul>
            </div>
          </div>

          {turns.length > 0 && turn && (
            <div className="hv-crew-sec">
              <div className="hv-crew-legend">
                <span id={`${id}-turns`} className="label-mono">Turn-taking</span>
                <span className="hv-crew-count">{`${turns.length} strategies`}</span>
              </div>
              <div className="hv-arch-grid" role="radiogroup" aria-labelledby={`${id}-turns`} onKeyDown={onTurnKey}>
                {turns.map((tid, i) => {
                  const t = TURN_TAKING[tid]
                  const on = tid === cfg.turnTaking
                  // The same budget rule as the other knobs: calls for this strategy at the current size.
                  const calls = estimateFor(pattern, provider, { ...cfg, turnTaking: tid }).calls
                  return (
                    <button
                      key={tid}
                      ref={(el) => { turnRefs.current[tid] = el }}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={`${t.name}, ${t.aka}`}
                      aria-describedby={on ? `${id}-turn-summary` : undefined}
                      tabIndex={on ? 0 : -1}
                      className={`hv-arch${on ? ' is-on' : ''}`}
                      onClick={() => { if (!on) setKnob({ turnTaking: tid }) }}
                    >
                      <span className="hv-arch-name">{t.name}</span>
                      <span className="hv-arch-aka">{i === 0 ? `${t.aka} · default` : t.aka}</span>
                      <span className="hv-arch-calls">{plural(calls, 'call')}</span>
                    </button>
                  )
                })}
              </div>
              <p id={`${id}-turn-summary`} className="hv-when"><span className="label-mono">{turn.name}</span>{turn.summary}</p>
            </div>
          )}

          <div className="hv-knobs">
            {knob && (
              <fieldset className="hv-knob">
                <legend className="hv-knob-label">{knob.label}</legend>
                <div className="hv-seg">
                  {widthValues.map((w) => (
                    <label key={w} className="hv-seg-opt">
                      <input type="radio" name={`${id}-width`} value={w} checked={width === w} onChange={() => setKnob({ width: w })} />
                      <span>{knob.show(w)}</span>
                    </label>
                  ))}
                </div>
                <span className="hv-knob-hint">{knob.hint(width)}</span>
              </fieldset>
            )}

            {pattern === 'debate' && (
              <fieldset className="hv-knob">
                <legend className="hv-knob-label">Rounds</legend>
                <div className="hv-seg">
                  {[1, 2, 3].map((r) => (
                    <label key={r} className="hv-seg-opt">
                      <input type="radio" name={`${id}-rounds`} value={r} checked={cfg.rounds === r} onChange={() => setKnob({ rounds: r })} />
                      <span>{r}</span>
                    </label>
                  ))}
                </div>
                <span className="hv-knob-hint">{`${plural(cfg.rounds, 'round')} of debate, then a vote`}</span>
              </fieldset>
            )}

            <div className="hv-knob hv-knob-budget">
              <div className="hv-knob-row">
                <label className="hv-knob-label" htmlFor={`${id}-budget`}>Call budget</label>
                <span className="hv-readout">{plural(cfg.maxCalls, 'call')}</span>
              </div>
              <div className="hv-range-wrap">
                <input
                  id={`${id}-budget`}
                  type="range"
                  className="hv-range"
                  min={budgetMin}
                  max={budgetMax}
                  step={1}
                  value={cfg.maxCalls}
                  style={{ '--pct': `${budgetPct}%` }}
                  aria-valuetext={`${cfg.maxCalls} model calls`}
                  onChange={(e) => setKnob({ maxCalls: Number(e.target.value) })}
                />
                <span className="hv-range-mark" style={{ left: `calc(11px + (100% - 22px) * ${(estPct / 100).toFixed(3)})` }} aria-hidden="true" title={`Estimated need: ${plural(estCalls, 'call')}`} />
              </div>
              <span className={`hv-knob-hint${cfg.maxCalls < estCalls ? ' is-warn' : ''}`}>
                {cfg.maxCalls < estCalls
                  ? 'Below the estimate. When the budget runs out, the Monitor asks the room to continue or wrap up.'
                  : 'A hard ceiling on model calls. One is always kept for the final answer.'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
