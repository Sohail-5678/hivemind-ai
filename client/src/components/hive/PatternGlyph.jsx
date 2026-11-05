import React from 'react'

// Tiny topology drawings, one per architecture: the shape of the team at a
// glance. Hairline strokes in currentColor so the card decides the tone.
const P = {
  auto: {
    nodes: [[24, 16, 3.2], [24, 4], [40, 16], [24, 28], [8, 16]],
    lines: [],
    dashed: ['M24 4 L40 16 L24 28 L8 16 Z'],
  },
  sequential: {
    nodes: [[6, 16], [18, 16], [30, 16], [42, 16]],
    lines: ['M9 16 H15', 'M21 16 H27', 'M33 16 H39'],
    dashed: ['M41 13 C38 6 33 6 31 13'],
  },
  router: {
    nodes: [[8, 16, 3.2], [40, 5], [40, 16], [40, 27]],
    lines: ['M11 16 H37'],
    dashed: ['M11 15 L37 6', 'M11 17 L37 26'],
  },
  orchestrator: {
    nodes: [[24, 16, 3.4], [8, 6], [40, 6], [8, 26], [40, 26]],
    lines: ['M21 14 L10.5 7.5', 'M27 14 L37.5 7.5', 'M21 18 L10.5 24.5', 'M27 18 L37.5 24.5'],
    dashed: [],
  },
  hierarchical: {
    nodes: [[24, 5, 3.2], [14, 16], [34, 16], [9, 27], [19, 27], [29, 27], [39, 27]],
    lines: ['M22 7 L15.5 14', 'M26 7 L32.5 14', 'M13 18 L10 25', 'M15 18 L18 25', 'M33 18 L30 25', 'M35 18 L38 25'],
    dashed: [],
  },
  parallel: {
    nodes: [[6, 16], [19, 8], [19, 24], [31, 16], [43, 16]],
    lines: ['M8.5 14.5 L16.5 9.5', 'M8.5 17.5 L16.5 22.5', 'M21.5 9.5 L28.5 14.5', 'M34 16 H40'],
    dashed: ['M21.5 24 C30 26 36 22 41 17.5'],
  },
  fanout: {
    nodes: [[6, 16, 3.2], [24, 5], [24, 16], [24, 27], [42, 16, 3.2]],
    lines: ['M9 15 L21.5 6', 'M9 16 H21', 'M9 17 L21.5 26', 'M26.5 6 L39 15', 'M27 16 H39', 'M26.5 26 L39 17'],
    dashed: [],
  },
  debate: {
    nodes: [[24, 5], [13.6, 23], [34.4, 23]],
    lines: [],
    circle: [24, 17, 12],
    dashed: [],
  },
  swarm: {
    nodes: [[24, 4], [35.4, 12.3], [31.1, 25.7], [16.9, 25.7], [12.6, 12.3]],
    lines: [],
    circle: [24, 16, 12],
    dashed: ['M24 7 L24 12.2', 'M32.6 13.2 L27.6 14.8', 'M29.3 23.3 L26.2 19.1', 'M18.7 23.3 L21.8 19.1', 'M15.4 13.2 L20.4 14.8'],
    hub: [24, 16],
  },
}

export function PatternGlyph({ pattern, size = 48, className = '' }) {
  const p = P[pattern] || P.auto
  return (
    <svg className={`hv-pglyph ${className}`} width={size} height={(size * 32) / 48} viewBox="0 0 48 32" aria-hidden="true" focusable="false">
      {p.circle && <circle cx={p.circle[0]} cy={p.circle[1]} r={p.circle[2]} className="hv-pglyph-line" />}
      {p.lines.map((d) => <path key={d} d={d} className="hv-pglyph-line" />)}
      {p.dashed.map((d) => <path key={d} d={d} className="hv-pglyph-line is-dashed" />)}
      {p.hub && <rect x={p.hub[0] - 2.6} y={p.hub[1] - 2.6} width="5.2" height="5.2" rx="1.2" className="hv-pglyph-hub" />}
      {p.nodes.map(([x, y, r = 2.4]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} className="hv-pglyph-node" />)}
    </svg>
  )
}

// Room types: rose dots are people, sage dots are agents.
const ROOMS = {
  solo: { humans: [[16, 20]], agents: [[48, 20]], links: [[0, 0]] },
  team: { humans: [[14, 20]], agents: [[44, 9], [54, 24], [40, 31]], links: [[0, 0], [0, 1], [0, 2]], mesh: [[0, 1], [1, 2], [0, 2]] },
  multiplayer: { humans: [[10, 10], [20, 30], [8, 27]], agents: [[48, 20]], links: [[0, 0], [1, 0], [2, 0]] },
  hive: { humans: [[9, 9], [19, 30], [6, 25]], agents: [[44, 8], [55, 21], [44, 32], [35, 19]], links: [[0, 3], [1, 3], [2, 3], [0, 0], [1, 2]], mesh: [[0, 1], [1, 2], [2, 3], [3, 0]] },
}

export function RoomGlyph({ kind, className = '' }) {
  const r = ROOMS[kind] || ROOMS.solo
  return (
    <svg className={`hv-rglyph ${className}`} width="64" height="40" viewBox="0 0 64 40" aria-hidden="true" focusable="false">
      {(r.mesh || []).map(([a, b]) => (
        <line key={`m${a}${b}`} x1={r.agents[a][0]} y1={r.agents[a][1]} x2={r.agents[b][0]} y2={r.agents[b][1]} className="hv-rglyph-mesh" />
      ))}
      {r.links.map(([h, a]) => (
        <line key={`l${h}${a}`} x1={r.humans[h][0]} y1={r.humans[h][1]} x2={r.agents[a][0]} y2={r.agents[a][1]} className="hv-rglyph-link" />
      ))}
      {r.humans.map(([x, y]) => <circle key={`h${x}${y}`} cx={x} cy={y} r="4" className="hv-rglyph-human" />)}
      {r.agents.map(([x, y]) => <circle key={`a${x}${y}`} cx={x} cy={y} r="4" className="hv-rglyph-agent" />)}
    </svg>
  )
}
