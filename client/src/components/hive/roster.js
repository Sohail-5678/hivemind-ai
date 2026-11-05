// Who is on the team, before and during a run. The planned shapes mirror what
// server/swarm/engine.js builds for each pattern, so the faded preview before a
// run is an honest picture of the team that will run, not a decoration.
import { PATTERNS, clampConfig } from '@shared/swarm/patterns.js'
import { ROLES, SPECIALISTS, makeAgent } from '@shared/swarm/roles.js'
import { patternId, teamOf } from './format'

// Engine sizing rules for one config (see each pattern runner in engine.js).
export function teamSize(pattern, config, provider = 'simulated') {
  const cfg = clampConfig(pattern, provider, config || {})
  return {
    managers: Math.max(1, Math.min(3, cfg.width)),
    personas: Math.max(2, Math.min(4, cfg.width)),
    subtasks: Math.min(4, cfg.width + 1),
    tasks: Math.min(5, cfg.width + 2),
    rounds: Math.max(1, Math.min(3, cfg.rounds)),
  }
}

function countFor(pattern, role, size) {
  if (pattern === 'hierarchical' && role === 'manager') return size.managers
  if (pattern === 'hierarchical' && role === 'worker') return size.managers * size.managers
  if (pattern === 'fanout' && role === 'worker') return size.personas
  return 1
}

// [{ id, role, name, glyph, color, description, count }] for config.pattern.
// `count` > 1 marks a role the engine instantiates several times.
export function plannedTeam(config, provider = 'simulated') {
  const pattern = patternId(config)
  const size = teamSize(pattern, config, provider)
  return (PATTERNS[pattern].team || []).map((role) => {
    const a = makeAgent(role)
    const count = countFor(pattern, role, size)
    const name = pattern === 'fanout' && role === 'worker' ? 'Persona' : a.name
    return { id: a.id, role, name, glyph: a.glyph, color: a.color, description: a.description, count, status: 'planned' }
  })
}

function asTarget(role, fallback) {
  const base = ROLES[role]
  return {
    id: role,
    role,
    name: base?.name || fallback?.name || role,
    glyph: base?.glyph || fallback?.glyph || '•',
    color: base?.color || fallback?.color,
    description: base?.description || fallback?.description || '',
  }
}

// Agents a human can @mention. The handle is the role id, which the engine's
// mention matcher accepts for every instance of that role. Uses the live team
// while a run is going (or when the next run keeps the same architecture),
// otherwise the planned team.
export function mentionTargets(config, swarm) {
  const live = teamOf(swarm)
  const pattern = patternId(config)
  const team = config?.crew === 'team'
  const sameArchitecture = !team || !swarm?.requested || swarm.requested === pattern
  let source
  if (live.length && (swarm?.status === 'running' || sameArchitecture)) source = live
  else if (team) source = pattern === 'auto' ? SPECIALISTS.map((r) => makeAgent(r)) : plannedTeam(config)
  else source = []
  const seen = new Set()
  const out = []
  for (const a of source) {
    const role = a?.role
    // The Architect only acts before anyone can reply; the Monitor is not an LLM.
    if (!role || role === 'architect' || role === 'monitor' || seen.has(role)) continue
    seen.add(role)
    out.push(asTarget(role, a))
  }
  return out
}

// A graph in the engine's shape for the planned team: { layout, nodes, edges }.
// Steps the engine decides at run time (plans, splits) appear as open slots.
export function plannedGraph(config, provider = 'simulated') {
  const pattern = patternId(config)
  const size = teamSize(pattern, config, provider)
  const nodes = []
  const edges = []
  const node = (id, role, layer, order = 0, label = null) => {
    const a = role ? makeAgent(role) : null
    nodes.push({ id, agentId: role || id, role, glyph: a?.glyph || '◌', label: label || a?.name || 'Open slot', layer, order, status: 'planned' })
  }
  const edge = (from, to, conditional = false) => edges.push({ from, to, conditional, used: false })

  switch (pattern) {
    case 'sequential':
      ['researcher', 'analyst', 'writer', 'critic'].forEach((r, i) => node(r, r, i))
      edge('researcher', 'analyst'); edge('analyst', 'writer'); edge('writer', 'critic'); edge('critic', 'writer', true)
      return { layout: 'flow', nodes, edges }
    case 'router':
      node('router', 'router', 0)
      SPECIALISTS.forEach((r, i) => { node(r, r, 1, i); edge('router', r, true) })
      return { layout: 'flow', nodes, edges }
    case 'orchestrator':
      node('plan', 'orchestrator', 0, 0, 'Orchestrator · plan')
      for (let i = 1; i <= size.subtasks; i++) { node(`slot-${i}`, null, 1, i, `Subtask ${i}`); edge('plan', `slot-${i}`); edge(`slot-${i}`, 'final') }
      node('final', 'orchestrator', 2, 0, 'Orchestrator · combine')
      return { layout: 'flow', nodes, edges }
    case 'parallel':
      node('plan', 'planner', 0, 0, 'Planner')
      for (let i = 1; i <= size.tasks; i++) { node(`slot-${i}`, null, 1, i, `Task ${i}`); edge('plan', `slot-${i}`); edge(`slot-${i}`, 'synth') }
      node('synth', 'synthesizer', 2)
      return { layout: 'flow', nodes, edges }
    case 'fanout':
      node('split', 'splitter', 0)
      for (let i = 1; i <= size.personas; i++) { node(`persona-${i}`, 'worker', 1, i, `Persona ${i}`); edge('split', `persona-${i}`); edge(`persona-${i}`, 'combine') }
      node('combine', 'combiner', 2)
      return { layout: 'flow', nodes, edges }
    case 'hierarchical':
      node('vp', 'vp', 0, 0, 'VP')
      for (let i = 1; i <= size.managers; i++) {
        node(`manager-${i}`, 'manager', 1, i, `Manager ${i}`)
        edge('vp', `manager-${i}`)
        for (let j = 1; j <= size.managers; j++) {
          node(`worker-${i}-${j}`, 'worker', 2, i * size.managers + j, `Worker ${i}.${j}`)
          edge(`manager-${i}`, `worker-${i}-${j}`)
        }
      }
      return { layout: 'tree', nodes, edges }
    case 'debate': {
      const peers = ['builder', 'skeptic', 'pragmatist']
      peers.forEach((r, i) => { node(r, r, 0, i); edge(r, peers[(i + 1) % peers.length]) })
      return { layout: 'ring', nodes, edges }
    }
    case 'swarm':
      ['researcher', 'interrogator', 'analyst', 'critic', 'synthesizer'].forEach((r, i) => node(r, r, 0, i))
      return { layout: 'ring', nodes, edges }
    default:
      node('architect', 'architect', 0)
      return { layout: 'flow', nodes, edges }
  }
}
