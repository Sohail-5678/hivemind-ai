import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PATTERNS } from '@shared/swarm/patterns.js'
import { ROLES } from '@shared/swarm/roles.js'
import { layoutGraph, edgeFor, NODE_R } from './graphLayout'
import { plannedGraph } from './roster'
import { useReducedMotion } from './hooks'
import { NODE_STATUS, OUTCOME, LIVE_AGENT, boardItemCount, clip, clock, glyph, nodesOf, patternId, plural, roleName, tail, teamOf } from './format'

const R = NODE_R
const PULSE_MS = 900
const MAX_SCALE = 1.15 // small graphs stay crisp instead of ballooning in a wide panel
// Average advances at the label sizes in hive.css (11px Inter, 9px mono).
const chars = (space, w) => Math.max(5, Math.floor((space || 90) / w))
// Graph text is in viewBox units, so it shrinks with the SVG. These are the
// 1:1 sizes in hive.css and the sizes the text should keep on screen.
const BASE_FS = { label: 11, sub: 9, hub: 8, hubValue: 8.5 }
const SCREEN_FS = { label: 11, sub: 9.5, hub: 9, hubValue: 8.5 }
const SUB_MIN_SCALE = 0.75 // below this the second label line is dropped

// Font sizes (viewBox units) that undo the SVG's scale, never below 1:1.
function fontSizes(scale) {
  if (!scale) return { ...BASE_FS, k: 1, vars: undefined }
  const fs = {}
  for (const key of Object.keys(BASE_FS)) fs[key] = Math.max(BASE_FS[key], SCREEN_FS[key] / scale)
  const vars = {
    '--hv-fs-label': `${fs.label.toFixed(2)}px`,
    '--hv-fs-sub': `${fs.sub.toFixed(2)}px`,
    '--hv-fs-hub': `${fs.hub.toFixed(2)}px`,
    '--hv-fs-hub-value': `${fs.hubValue.toFixed(2)}px`,
  }
  return { ...fs, k: fs.label / BASE_FS.label, vars }
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

// Primary line: who (role or persona). Secondary: what this node does, when the
// engine gave it a label of its own (a subtask title, "plan", a workstream).
function labelsFor(node, agent) {
  const title = String(agent?.name || node.label || roleName(node.role) || node.id)
  const [head, ...more] = title.split(' · ')
  let secondary = more.join(' · ')
  if (node.label && node.label !== title) {
    const parts = String(node.label).split(' · ')
    const own = parts.length > 1 ? parts.slice(1).join(' · ') : String(node.label)
    if (own !== head) secondary = own
  }
  const full = node.label && node.label !== title ? `${title}: ${node.label}` : title
  return { primary: head, secondary: cap(secondary), full }
}

// `k` is how much larger than 1:1 the text is drawn; the lines move apart with it.
function labelPos(at, line, k = 1) {
  switch (at) {
    case 'above': return { x: 0, y: line === 0 ? -R - 9 - 12 * k : -R - 9, anchor: 'middle' }
    case 'right': return { x: R + 14, y: line === 0 ? -2 : -2 + 12 * k, anchor: 'start' }
    case 'left': return { x: -R - 14, y: line === 0 ? -2 : -2 + 12 * k, anchor: 'end' }
    default: return { x: 0, y: line === 0 ? R + 6 + 11 * k : R + 6 + 23 * k, anchor: 'middle' }
  }
}

// A partial ring around a swarm node showing its current bid to speak.
function bidArc(score) {
  const k = Math.max(0, Math.min(1, score / 1.6))
  if (k <= 0) return null
  const r = R + 9
  const a0 = -Math.PI / 2
  const a1 = a0 + k * 2 * Math.PI * 0.999
  const p = (a) => `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`
  return `M${p(a0)} A${r},${r} 0 ${k > 0.5 ? 1 : 0} 1 ${p(a1)}`
}

function hubText(pattern, swarm, blackboard, planned) {
  if (pattern === 'swarm') {
    const n = boardItemCount(blackboard)
    return { label: 'Board', value: planned ? 'shared' : plural(n, 'note') }
  }
  if (pattern === 'debate') {
    const vote = planned ? null : swarm?.vote
    const winner = vote?.winner ? (vote.options || []).find((o) => o.id === vote.winner) : null
    return { label: vote ? 'Vote' : 'Debate', value: vote?.open ? 'open' : winner ? winner.by || 'decided' : 'round robin' }
  }
  return { label: 'Team', value: '' }
}

export function HiveGraph({ swarm, blackboard, config, provider = 'simulated', onSelect, preview = false }) {
  const rawId = useId()
  const uid = `hv${rawId.replace(/[^a-zA-Z0-9]/g, '')}`
  const reduced = useReducedMotion()
  const liveNodes = nodesOf(swarm)
  const planned = preview || !liveNodes.length
  const starting = !preview && swarm?.status === 'running' && !liveNodes.length
  const configKey = `${patternId(config)}:${config?.width}:${config?.rounds}:${provider}`

  // swarm.graph keeps its identity while tokens stream, so this only re-lays
  // out when the graph itself changes.
  const graph = useMemo(() => (planned ? plannedGraph(config, provider) : swarm.graph), [planned, planned ? configKey : swarm?.graph]) // eslint-disable-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutGraph(graph), [graph])
  const team = swarm?.team && typeof swarm.team === 'object' && !planned ? swarm.team : {}
  const pattern = planned ? patternId(config) : swarm?.pattern || swarm?.requested || 'auto'
  const running = !planned && swarm?.status === 'running'

  // ------------------------------------------------------------ flow pulse
  const lastFlow = planned ? null : swarm?.graph?.lastFlow
  const seq = lastFlow ? `${swarm?.runId}:${Number(lastFlow.seq) || 0}` : ''
  const prevSeq = useRef(seq)
  const pathRefs = useRef({})
  const pulseRef = useRef(null)
  const [flowing, setFlowing] = useState(null)

  useEffect(() => {
    // Only flows that happen while we watch animate; a late joiner's snapshot
    // carries an old lastFlow that already happened.
    if (seq === prevSeq.current) return undefined
    prevSeq.current = seq
    if (!seq) return undefined
    const hit = edgeFor(layout, lastFlow?.from, lastFlow?.to)
    if (!hit) return undefined
    setFlowing(hit.edge.key)
    const clear = setTimeout(() => setFlowing(null), 1400)
    const path = pathRefs.current[hit.edge.key]
    const dot = pulseRef.current
    let raf = 0
    if (!reduced && path && dot && typeof path.getTotalLength === 'function' && typeof requestAnimationFrame === 'function') {
      const total = path.getTotalLength()
      const t0 = performance.now()
      const step = (t) => {
        const k = Math.min(1, (t - t0) / PULSE_MS)
        const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2
        const p = path.getPointAtLength((hit.reverse ? 1 - e : e) * total)
        dot.setAttribute('cx', p.x.toFixed(1))
        dot.setAttribute('cy', p.y.toFixed(1))
        dot.style.opacity = String(k < 0.12 ? k / 0.12 : k > 0.85 ? (1 - k) / 0.15 : 1)
        if (k < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    return () => {
      clearTimeout(clear)
      if (raf) cancelAnimationFrame(raf)
      if (dot) dot.style.opacity = '0'
    }
  }, [seq]) // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ derived
  const bids = useMemo(() => {
    if (!running || layout.layout !== 'ring' || !Array.isArray(swarm?.bids?.bids)) return null
    const list = swarm.bids.bids.filter((b) => b && b.agentId)
    return { top: list[0]?.agentId || null, byId: Object.fromEntries(list.map((b) => [b.agentId, Number(b.score) || 0])) }
  }, [running, layout.layout, swarm?.bids])

  const liveAgents = planned ? [] : teamOf(swarm).filter((a) => LIVE_AGENT.has(a.status))
  const liveNames = liveAgents.map((a) => a.name).join(', ')
  const hub = layout.hub ? hubText(pattern, swarm, blackboard, planned) : null
  const maxWidth = Math.round(layout.width * MAX_SCALE)

  // The SVG always fits its well (no sideways scroll), so on a narrow screen it
  // is drawn smaller than 1:1. Measure that scale and size the text against it.
  const wellRef = useRef(null)
  const svgRef = useRef(null)
  const [scale, setScale] = useState(null)
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return undefined
    const measure = () => {
      const box = svg.getBoundingClientRect()
      if (!box.width || !layout.width) return
      const s = Math.min(box.width / layout.width, box.height && layout.height ? box.height / layout.height : Infinity)
      const next = Math.round(s * 100) / 100
      setScale((prev) => (prev === next ? prev : next))
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(wellRef.current || svg)
    return () => ro.disconnect()
  }, [layout.width, layout.height])
  const fs = fontSizes(scale)
  const showSub = !scale || scale >= SUB_MIN_SCALE
  const labelW = 6.3 * (fs.label / BASE_FS.label)
  const subW = 5.6 * (fs.sub / BASE_FS.sub)
  const hubK = fs.hub / BASE_FS.hub

  const agentObj = (n, primary) => team[n.agentId] || (n.role ? { id: n.agentId, role: n.role, name: primary, glyph: n.glyph, description: ROLES[n.role]?.description || '' } : null)

  return (
    <div className={`hv-graph${planned ? ' is-planned' : ''}`}>
      <div className="hv-graph-well" ref={wellRef}>
        <svg
          ref={svgRef}
          className="hv-graph-svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ maxWidth, ...(fs.vars || {}) }}
          role="group"
          aria-label={`${PATTERNS[pattern]?.name || 'Agent'} team graph, ${plural(layout.nodes.length, 'step')}${planned ? ', planned' : ''}`}
        >
          <defs>
            <filter id={`${uid}-blur`} x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.4" /></filter>
            <filter id={`${uid}-glow`} x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="6" /></filter>
            <linearGradient id={`${uid}-face`} x1="0.15" y1="0.1" x2="0.85" y2="0.95">
              <stop offset="0" className="hv-stop-hi" />
              <stop offset="1" className="hv-stop-lo" />
            </linearGradient>
            <marker id={`${uid}-arrow-on`} viewBox="0 0 8 8" refX="5.5" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M1.2 1.2 L5.8 4 L1.2 6.8" className="hv-arrow is-used" />
            </marker>
            <marker id={`${uid}-arrow-off`} viewBox="0 0 8 8" refX="5.5" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M1.2 1.2 L5.8 4 L1.2 6.8" className="hv-arrow" />
            </marker>
          </defs>

          {layout.ring && layout.ring.radius > 0 && (
            <g className="hv-orbit" aria-hidden="true">
              <circle cx={layout.ring.cx} cy={layout.ring.cy} r={layout.ring.radius} />
              <circle cx={layout.ring.cx} cy={layout.ring.cy} r={layout.ring.radius + R + 16} className="is-outer" />
            </g>
          )}

          {hub && (
            <g className="hv-hub" transform={`translate(${layout.hub.x},${layout.hub.y})`} aria-hidden="true">
              <circle r={layout.hub.r + 3} className="hv-hub-rim" />
              <circle r={layout.hub.r} className="hv-hub-well" />
              <text className="hv-hub-label" y={(hub.value ? -3 : 3) * hubK} textAnchor="middle">{hub.label}</text>
              {hub.value && <text className="hv-hub-value" y={10 * hubK} textAnchor="middle">{clip(hub.value, Math.max(5, Math.floor(12 * BASE_FS.hubValue / fs.hubValue)))}</text>}
            </g>
          )}

          <g aria-hidden="true">
            {layout.edges.map((e) => {
              const cls = ['hv-edge', e.used ? 'is-used' : 'is-idle', e.conditional && !e.used ? 'is-cond' : '', e.planned ? 'is-planned' : '', flowing === e.key ? 'is-flowing' : ''].filter(Boolean).join(' ')
              const marker = layout.layout === 'flow' ? `url(#${uid}-arrow-${e.used ? 'on' : 'off'})` : undefined
              return <path key={e.key} ref={(el) => { pathRefs.current[e.key] = el }} d={e.d} className={cls} markerEnd={marker} />
            })}
            <circle ref={pulseRef} r="3.6" cx="-20" cy="-20" className="hv-pulse" style={{ opacity: 0 }} />
          </g>

          {layout.nodes.map((n) => {
            const status = n.status || 'queued'
            const agent = team[n.agentId]
            const { primary, secondary, full } = labelsFor(n, agent)
            const g = agent?.glyph || n.glyph || ROLES[n.role]?.glyph
            const score = bids?.byId[n.agentId]
            const sub = showSub ? (score !== undefined ? `bid ${score.toFixed(2)}` : secondary) : ''
            const target = onSelect ? agentObj(n, primary) : null
            const l0 = labelPos(n.labelAt, 0, fs.k)
            const l1 = labelPos(n.labelAt, 1, fs.k)
            const statusText = NODE_STATUS[status] || status
            const interactive = target ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${full}, ${statusText}. Open agent card`,
              onClick: () => onSelect(target),
              onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(target) } },
            } : { role: 'img', 'aria-label': `${full}, ${statusText}` }
            return (
              <g key={n.id} className={`hv-node is-${status}${target ? ' is-interactive' : ''}`} transform={`translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`} {...interactive}>
                <title>{`${full} · ${statusText}`}</title>
                <circle className="hv-node-sd" cx="3.6" cy="4.2" r={R} filter={`url(#${uid}-blur)`} />
                <circle className="hv-node-sl" cx="-3.2" cy="-3.4" r={R - 1} filter={`url(#${uid}-blur)`} />
                {status === 'running' && <circle className="hv-node-glow" r={R + 4} filter={`url(#${uid}-glow)`} />}
                <circle className="hv-node-face" r={R} fill={`url(#${uid}-face)`} />
                <circle className="hv-node-ring" r={R + 4.5} />
                {status === 'running' && <circle className="hv-node-halo" r={R + 4.5} />}
                {score !== undefined && (
                  <>
                    <circle className="hv-bid-track" r={R + 9} />
                    {bidArc(score) && <path className={`hv-bid-arc${bids.top === n.agentId ? ' is-top' : ''}`} d={bidArc(score)} />}
                  </>
                )}
                <text className="hv-node-glyph" textAnchor="middle" dy="0.36em">{glyph(g)}</text>
                <text className="hv-node-label" x={l0.x} y={l0.y} textAnchor={l0.anchor}>{clip(primary, chars(n.labelMax, labelW))}</text>
                {sub && <text className="hv-node-sub" x={l1.x} y={l1.y} textAnchor={l1.anchor}>{clip(sub, chars(n.labelMax, subW))}</text>}
                <circle className="hv-node-focus" r={R + 8} />
              </g>
            )
          })}
        </svg>
      </div>

      <GraphCaption swarm={swarm} planned={planned} starting={starting} pattern={pattern} liveAgents={liveAgents} />
      <span className="hv-sr" aria-live="polite">{running ? (liveNames ? `Working now: ${liveNames}` : 'Handing off') : ''}</span>

      <ul className="hv-legend" aria-label="Graph legend">
        <li><svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" className="hv-edge is-used" /></svg>Handoff</li>
        <li><svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" className="hv-edge is-idle" /></svg>Possible path</li>
        <li><span className="hv-legend-ring" aria-hidden="true" />Working</li>
      </ul>
    </div>
  )
}

function GraphCaption({ swarm, planned, starting, pattern, liveAgents }) {
  if (starting) return <p className="hv-caption is-quiet">Setting up the team.</p>
  if (planned) {
    const slots = pattern === 'orchestrator' || pattern === 'parallel'
    return (
      <p className="hv-caption is-quiet">
        {pattern === 'auto'
          ? 'Preview. When the run starts, the Architect reads the goal and designs the rest of the team.'
          : `Preview of the team. It starts working when someone sends a message.${slots ? ' The open slots are filled by the plan at run time.' : ''}`}
      </p>
    )
  }
  if (swarm?.status === 'running') {
    if (!liveAgents.length) {
      const waiting = swarm.escalation ? 'Waiting for a person to answer the Monitor.' : swarm.vote?.open ? 'Waiting for the vote to close.' : swarm.requested === 'auto' && !swarm.pattern ? 'The Architect is choosing an architecture.' : 'Handing off to the next agent.'
      return <p className="hv-caption is-quiet">{waiting}</p>
    }
    return (
      <div className="hv-caption">
        {liveAgents.slice(0, 3).map((a) => (
          <div key={a.id} className="hv-cap-line">
            <span className="hv-cap-glyph" aria-hidden="true">{glyph(a.glyph)}</span>
            <span className="hv-cap-name">{a.name}</span>
            <span className="hv-cap-text">
              {a.stream ? tail(a.stream, 120) : a.status === 'thinking' ? 'planning' : 'thinking'}
              <span className="hv-caret" aria-hidden="true" />
            </span>
          </div>
        ))}
        {liveAgents.length > 3 && <div className="hv-cap-more">{`and ${plural(liveAgents.length - 3, 'more agent')} working in parallel`}</div>}
      </div>
    )
  }
  const stats = swarm?.stats || swarm?.monitor || {}
  const outcome = OUTCOME[swarm?.outcome] || 'Finished'
  return (
    <p className="hv-caption is-quiet">
      <span className="hv-cap-outcome">{outcome}</span>
      {Number.isFinite(Number(stats.calls)) && <span className="hv-cap-stat">{plural(Number(stats.calls), 'call')}</span>}
      {Number(stats.elapsedMs) > 0 && <span className="hv-cap-stat">{clock(stats.elapsedMs)}</span>}
    </p>
  )
}
