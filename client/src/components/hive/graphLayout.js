// Pure layout for the team graph. Takes the engine's graph ({ layout, nodes,
// edges }) and returns positioned nodes and SVG paths in viewBox units:
//   flow  layers left to right (pipelines, plans, fan-out)
//   tree  VP on top, managers, then workers under their own manager
//   ring  equal peers on a circle (debate, swarm); extra nodes sit in the middle
export const NODE_R = 19
const MIN_W = 320

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const byOrder = (a, b) => num(a.order) - num(b.order)
const fit = (space) => Math.max(36, Math.round(space)) // label room in viewBox units

function groupLayers(nodes) {
  const layers = [...new Set(nodes.map((n) => num(n.layer)))].sort((a, b) => a - b)
  return layers.map((l) => nodes.filter((n) => num(n.layer) === l).sort(byOrder))
}

// ---------------------------------------------------------------- flow
function flow(nodes) {
  const COL = 100
  const ROW = 84
  const PAD_X = 56
  const PAD_TOP = 48
  const PAD_BOTTOM = 56
  const cols = groupLayers(nodes)
  const rows = Math.max(...cols.map((c) => c.length))
  const contentW = (cols.length - 1) * COL
  const contentH = (rows - 1) * ROW
  const width = Math.max(MIN_W, contentW + PAD_X * 2)
  const height = PAD_TOP + contentH + PAD_BOTTOM
  const x0 = (width - contentW) / 2
  const out = []
  cols.forEach((col, i) => {
    const top = PAD_TOP + (contentH - (col.length - 1) * ROW) / 2
    col.forEach((n, j) => out.push({ ...n, x: x0 + i * COL, y: top + j * ROW, labelAt: 'below', labelMax: fit(COL - 10) }))
  })
  return { width, height, nodes: out, hub: null }
}

// ---------------------------------------------------------------- tree
function tree(nodes, edges) {
  const LEAF = 78
  const LEVEL = 96
  const PAD_X = 48
  const PAD_TOP = 30 + NODE_R
  const PAD_BOTTOM = 56
  const levels = groupLayers(nodes)
  const roots = levels[0] || []
  const mids = levels[1] || []
  const leaves = levels[2] || []
  const rest = levels.slice(3).flat()
  const midIds = new Set(mids.map((m) => m.id))
  const parentOf = (leaf) => {
    const e = edges.find((x) => (x.to === leaf.id && midIds.has(x.from)) || (x.from === leaf.id && midIds.has(x.to)))
    return e ? (e.to === leaf.id ? e.from : e.to) : null
  }
  const slots = []
  for (const m of mids) {
    const kids = leaves.filter((l) => parentOf(l) === m.id)
    if (kids.length) kids.forEach((k) => slots.push({ leaf: k, mid: m }))
    else slots.push({ leaf: null, mid: m })
  }
  for (const l of leaves) if (!parentOf(l)) slots.push({ leaf: l, mid: null })
  const count = Math.max(slots.length, roots.length, rest.length, 1)
  const contentW = (count - 1) * LEAF
  const width = Math.max(MIN_W, contentW + PAD_X * 2)
  const x0 = (width - contentW) / 2
  const spread = (list, y, gap) => {
    const w = (list.length - 1) * gap
    return list.map((n, i) => ({ ...n, x: width / 2 - w / 2 + i * gap, y }))
  }
  const y = (level) => PAD_TOP + level * LEVEL
  const pos = new Map()
  slots.forEach((s, i) => { if (s.leaf) pos.set(s.leaf.id, { x: x0 + i * LEAF, y: y(2) }) })
  mids.forEach((m) => {
    const idx = slots.map((s, i) => (s.mid?.id === m.id ? i : -1)).filter((i) => i >= 0)
    const x = idx.length ? x0 + (idx.reduce((a, i) => a + i, 0) / idx.length) * LEAF : width / 2
    pos.set(m.id, { x, y: y(1) })
  })
  const midXs = mids.map((m) => pos.get(m.id).x)
  const rootX = midXs.length ? (Math.min(...midXs) + Math.max(...midXs)) / 2 : width / 2
  const out = []
  if (roots.length === 1) out.push({ ...roots[0], x: rootX, y: y(0) })
  else out.push(...spread(roots, y(0), LEAF))
  for (const m of mids) out.push({ ...m, ...pos.get(m.id) })
  for (const l of leaves) out.push({ ...l, ...pos.get(l.id) })
  const levelsUsed = rest.length ? 4 : leaves.length ? 3 : mids.length ? 2 : 1
  if (rest.length) out.push(...spread(rest, y(3), LEAF))
  // Labels may use the space up to the nearest neighbour on the same level.
  const sortedMid = [...midXs].sort((a, b) => a - b)
  const midGap = sortedMid.length > 1 ? Math.min(...sortedMid.slice(1).map((x, i) => x - sortedMid[i])) : 160
  const leafIds = new Set(leaves.map((l) => l.id))
  const labelMax = (n) => {
    if (leafIds.has(n.id)) return fit(LEAF - 10)
    if (midIds.has(n.id)) return fit(Math.min(midGap - 10, 150))
    return fit(rest.length > 1 ? LEAF - 10 : 150)
  }
  return {
    width,
    height: y(levelsUsed - 1) + PAD_BOTTOM,
    nodes: out.map((n) => ({ ...n, labelAt: 'below', labelMax: labelMax(n) })),
    hub: null,
  }
}

// ---------------------------------------------------------------- ring
function ring(nodes) {
  const levels = groupLayers(nodes)
  const onRing = levels[0] || []
  const inner = levels.slice(1).flat()
  const n = onRing.length
  const radius = n <= 1 ? 0 : n === 2 ? 70 : n === 3 ? 84 : 100 + Math.max(0, n - 5) * 12
  const LABEL_W = 100
  const width = Math.max(MIN_W, 2 * (radius + NODE_R + LABEL_W))
  const cx = width / 2
  const cy = 34 + NODE_R + radius
  const height = cy + radius + NODE_R + 50
  const out = onRing.map((node, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, n)
    const sin = Math.sin(a)
    const cos = Math.cos(a)
    const labelAt = sin < -0.5 ? 'above' : sin > 0.5 || n === 1 ? 'below' : cos > 0 ? 'right' : 'left'
    return { ...node, x: cx + radius * cos, y: cy + radius * sin, angle: a, labelAt, labelMax: fit(labelAt === 'left' || labelAt === 'right' ? LABEL_W - 14 : 120) }
  })
  inner.forEach((node, i) => {
    const off = (i - (inner.length - 1) / 2) * 56
    out.push({ ...node, x: cx + off, y: cy, labelAt: 'below', labelMax: fit(90) })
  })
  return { width, height, nodes: out, ring: { cx, cy, radius, count: n }, hub: inner.length || n < 3 ? null : { x: cx, y: cy, r: 31 } }
}

// ---------------------------------------------------------------- edges
const f = (v) => Math.round(v * 10) / 10

function towards(a, b, dist) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: a.x + (dx / len) * dist, y: a.y + (dy / len) * dist }
}

function flowPath(a, b) {
  const R = NODE_R
  if (b.x > a.x + 1) {
    const sx = a.x + R
    const tx = b.x - R - 5
    const dx = Math.max(16, (tx - sx) / 2)
    return `M${f(sx)},${f(a.y)} C${f(sx + dx)},${f(a.y)} ${f(tx - dx)},${f(b.y)} ${f(tx)},${f(b.y)}`
  }
  if (b.x < a.x - 1) {
    // A feedback edge (the Critic sending a draft back) arcs over the line.
    const lift = 30 + Math.abs(a.x - b.x) * 0.06
    return `M${f(a.x)},${f(a.y - R)} C${f(a.x)},${f(a.y - R - lift)} ${f(b.x)},${f(b.y - R - lift)} ${f(b.x)},${f(b.y - R - 5)}`
  }
  const s = towards(a, b, R)
  const t = towards(b, a, R + 5)
  return `M${f(s.x)},${f(s.y)} L${f(t.x)},${f(t.y)}`
}

function treePath(a, b) {
  const R = NODE_R
  const down = b.y >= a.y
  const sy = a.y + (down ? R : -R)
  const ty = b.y + (down ? -R : R)
  const my = (sy + ty) / 2
  return `M${f(a.x)},${f(sy)} C${f(a.x)},${f(my)} ${f(b.x)},${f(my)} ${f(b.x)},${f(ty)}`
}

function ringPath(a, b, meta) {
  const R = NODE_R
  const { cx, cy, radius, count } = meta
  const ia = a.angle
  const ib = b.angle
  if (ia !== undefined && ib !== undefined && radius > 0) {
    const step = (2 * Math.PI) / count
    let delta = ib - ia
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta <= -Math.PI) delta += 2 * Math.PI
    if (Math.abs(Math.abs(delta) - step) < 1e-6 || count <= 3) {
      // Neighbours on the ring talk along the ring itself.
      const trim = (R + 4) / radius
      const sign = delta >= 0 ? 1 : -1
      const s = ia + sign * trim
      const e = ib - sign * trim
      const pt = (ang) => `${f(cx + radius * Math.cos(ang))},${f(cy + radius * Math.sin(ang))}`
      return `M${pt(s)} A${f(radius)},${f(radius)} 0 0 ${sign > 0 ? 1 : 0} ${pt(e)}`
    }
  }
  // Chords bow toward the centre, through the shared blackboard.
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const c = { x: mid.x + (cx - mid.x) * 0.5, y: mid.y + (cy - mid.y) * 0.5 }
  const s = towards(a, c, R + 2)
  const t = towards(b, c, R + 4)
  return `M${f(s.x)},${f(s.y)} Q${f(c.x)},${f(c.y)} ${f(t.x)},${f(t.y)}`
}

// An edge is "used" when the engine said so. The view drops that flag each time
// the graph grows (swarm_graph replaces the edge list), so a plain edge whose
// two ends have both run also counts. Conditional edges keep the exact flag:
// a Critic that approved never sent the draft back.
const STARTED = new Set(['running', 'done', 'failed', 'canceled'])
function wasUsed(e, from, to) {
  if (e.used) return true
  if (e.conditional) return false
  return STARTED.has(from.status) && STARTED.has(to.status) && from.status !== 'running'
}

// An endpoint that names an agent rather than a node (node ids and agent ids
// differ in most patterns) resolves to that agent's most recent node.
function resolver(byId) {
  const latest = new Map()
  for (const n of byId.values()) {
    const prev = latest.get(n.agentId)
    if (!prev || num(n.layer) >= num(prev.layer)) latest.set(n.agentId, n)
  }
  return (id) => (byId.has(id) ? id : latest.get(id)?.id ?? null)
}

function buildEdges(layout, rawEdges, byId, meta) {
  const merge = layout !== 'flow' // tree and ring draw a pair of opposite flows as one line
  const resolve = resolver(byId)
  const index = new Map()
  const list = []
  for (const raw of Array.isArray(rawEdges) ? rawEdges : []) {
    if (!raw) continue
    const e = { ...raw, from: resolve(raw.from), to: resolve(raw.to) }
    if (!e.from || !e.to || e.from === e.to) continue
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    const key = merge ? [e.from, e.to].sort().join('|') : `${e.from}|${e.to}`
    const used = wasUsed(e, a, b)
    const prev = index.get(key)
    if (prev) {
      prev.used = prev.used || used
      prev.conditional = prev.conditional && Boolean(e.conditional)
      continue
    }
    const d = layout === 'tree' ? treePath(a, b) : layout === 'ring' ? ringPath(a, b, meta) : flowPath(a, b)
    const item = { key, from: e.from, to: e.to, used, conditional: Boolean(e.conditional), planned: a.status === 'planned' || b.status === 'planned', d }
    index.set(key, item)
    list.push(item)
  }
  return list
}

export function edgeFor(layoutResult, from, to) {
  if (!layoutResult || !from || !to) return null
  const resolve = resolver(new Map(layoutResult.nodes.map((n) => [n.id, n])))
  const a = resolve(from)
  const b = resolve(to)
  if (!a || !b) return null
  const merge = layoutResult.layout !== 'flow'
  const key = merge ? [a, b].sort().join('|') : `${a}|${b}`
  const edge = layoutResult.edges.find((e) => e.key === key)
  return edge ? { edge, reverse: edge.from !== a } : null
}

export function layoutGraph(graph) {
  const layout = graph?.layout === 'tree' || graph?.layout === 'ring' ? graph.layout : 'flow'
  const seen = new Set()
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((n) => {
    if (!n || n.id === undefined || n.id === null || seen.has(n.id)) return false
    seen.add(n.id)
    return true
  })
  if (!nodes.length) return { layout, width: MIN_W, height: 150, nodes: [], edges: [], hub: null, ring: null }
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const placed = layout === 'tree' ? tree(nodes, edges) : layout === 'ring' ? ring(nodes) : flow(nodes)
  const byId = new Map(placed.nodes.map((n) => [n.id, n]))
  return { layout, ring: null, ...placed, edges: buildEdges(layout, edges, byId, placed.ring) }
}
