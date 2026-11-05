import React from 'react'

// Tiny line drawings of the nine architectures, one per pattern id. Pure
// geometry on a 120 x 64 grid; colour and stroke come from docs.css (.doc-shape-*),
// so the same shape reads correctly as a 44 px picker glyph or a card header.
// Nodes are agents (sage); the rose dot in Peer-to-peer is the humans' vote.

const N = ({ x, y, r = 4.5, hub = false }) => <circle className={hub ? 'doc-shape-node doc-shape-hub' : 'doc-shape-node'} cx={x} cy={y} r={r} />
const E = ({ d, opt = false }) => <path className={opt ? 'doc-shape-edge doc-shape-opt' : 'doc-shape-edge'} d={d} />
const line = (a, b) => `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`

// Shortens a segment by the node radii at both ends so edges meet the rims.
function seg(a, b, ra = 4.5, rb = 4.5) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const r2 = (v) => Math.round(v * 10) / 10
  return line([r2(a[0] + ux * ra), r2(a[1] + uy * ra)], [r2(b[0] - ux * rb), r2(b[1] - uy * rb)])
}

const SWARM_RING = [-90, -18, 54, 126, 198].map((deg) => {
  const t = (deg * Math.PI) / 180
  return [Math.round((60 + 25 * Math.cos(t)) * 10) / 10, Math.round((32 + 25 * Math.sin(t)) * 10) / 10]
})

const SHAPES = {
  auto: () => {
    const cands = [[26, 50], [60, 50], [94, 50]]
    return (
      <>
        <path className="doc-shape-node doc-shape-hub" d="M60 5 L68 13 L60 21 L52 13 Z" />
        <E d={seg([60, 21], cands[1], 0, 4.5)} />
        <E opt d={seg([55, 18], cands[0], 0, 4.5)} />
        <E opt d={seg([65, 18], cands[2], 0, 4.5)} />
        {cands.map(([x, y], i) => <N key={i} x={x} y={y} />)}
      </>
    )
  },
  sequential: () => {
    const xs = [14, 42, 70, 98]
    return (
      <>
        {xs.slice(1).map((x, i) => <E key={x} d={seg([xs[i], 38], [x, 38])} />)}
        <E opt d="M98 32.5 C 96 16, 72 16, 70 32.5" />
        {xs.map((x) => <N key={x} x={x} y={38} />)}
      </>
    )
  },
  router: () => {
    const ys = [8, 20, 32, 44, 56]
    return (
      <>
        {ys.map((y) => <E key={y} opt={y !== 32} d={seg([18, 32], [100, y], 6, 3.8)} />)}
        <N x={18} y={32} r={6} hub />
        {ys.map((y) => <N key={y} x={100} y={y} r={3.8} />)}
      </>
    )
  },
  orchestrator: () => {
    const xs = [24, 48, 72, 96]
    return (
      <>
        {xs.map((x) => <E key={`a${x}`} d={seg([60, 9], [x, 32], 6, 4.5)} />)}
        {xs.map((x) => <E key={`b${x}`} d={seg([x, 32], [60, 56], 4.5, 6)} />)}
        <N x={60} y={9} r={6} hub />
        {xs.map((x) => <N key={x} x={x} y={32} />)}
        <N x={60} y={56} r={6} hub />
      </>
    )
  },
  hierarchical: () => {
    const managers = [[34, 32], [86, 32]]
    const workers = [[20, 56, 0], [46, 56, 0], [74, 56, 1], [100, 56, 1]]
    return (
      <>
        {managers.map((m) => <E key={`v${m[0]}`} d={seg([60, 9], m, 6, 5)} />)}
        {workers.map(([x, y, m]) => <E key={`w${x}`} d={seg(managers[m], [x, y], 5, 4)} />)}
        <N x={60} y={9} r={6} hub />
        {managers.map(([x, y]) => <N key={x} x={x} y={y} r={5} />)}
        {workers.map(([x, y]) => <N key={x} x={x} y={y} r={4} />)}
      </>
    )
  },
  parallel: () => {
    const P = [12, 32]
    const n1 = [38, 15]
    const n2 = [38, 49]
    const n3 = [62, 15]
    const n4 = [82, 40]
    const S = [108, 32]
    return (
      <>
        <E d={seg(P, n1, 5.5)} />
        <E d={seg(P, n2, 5.5)} />
        <E d={seg(n1, n3)} />
        <E d={seg(n2, n4)} />
        <E d={seg(n3, n4)} />
        <E d={seg(n4, S, 4.5, 5.5)} />
        <N x={P[0]} y={P[1]} r={5.5} hub />
        {[n1, n2, n3, n4].map(([x, y]) => <N key={`${x}${y}`} x={x} y={y} />)}
        <N x={S[0]} y={S[1]} r={5.5} hub />
      </>
    )
  },
  fanout: () => {
    const ys = [8, 24, 40, 56]
    return (
      <>
        {ys.map((y) => <E key={`a${y}`} d={seg([14, 32], [60, y], 5.5, 4)} />)}
        {ys.map((y) => <E key={`b${y}`} d={seg([60, y], [106, 32], 4, 5.5)} />)}
        <N x={14} y={32} r={5.5} hub />
        {ys.map((y) => <N key={y} x={60} y={y} r={4} />)}
        <N x={106} y={32} r={5.5} hub />
      </>
    )
  },
  debate: () => {
    const peers = [[60, 9], [92, 53], [28, 53]]
    return (
      <>
        {peers.map((p, i) => <E key={`r${i}`} d={seg(p, peers[(i + 1) % 3], 5.5, 5.5)} />)}
        {peers.map((p, i) => <E key={`v${i}`} opt d={seg(p, [60, 38], 5.5, 3)} />)}
        {peers.map(([x, y]) => <N key={x} x={x} y={y} r={5.5} />)}
        <circle className="doc-shape-human" cx={60} cy={38} r={3} />
      </>
    )
  },
  swarm: () => (
    <>
      {SWARM_RING.map(([x, y], i) => <E key={i} opt={i !== 1} d={seg([x, y], [60, 32], 4.5, 9)} />)}
      <rect className="doc-shape-board" x={52} y={24} width={16} height={16} rx={3.5} />
      {SWARM_RING.map(([x, y]) => <N key={`${x}${y}`} x={x} y={y} />)}
    </>
  ),
}

export function PatternShape({ pattern, className = '', title = null }) {
  const draw = SHAPES[pattern] || SHAPES.auto
  return (
    <svg
      className={`doc-shape ${className}`.trim()}
      viewBox="0 0 120 64"
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {draw()}
    </svg>
  )
}
