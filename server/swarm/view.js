// Swarm view model. Reduces engine messages into what the UI renders. Shared by
// the browser reducer and the server (which keeps it per room for late joiners),
// so every participant sees the same graph, roster, monitor, votes and board.

export const SWARM_MESSAGE_TYPES = new Set([
  'swarm_started', 'swarm_team', 'swarm_architect', 'swarm_graph', 'swarm_node', 'swarm_edge',
  'swarm_agent_start', 'swarm_token', 'swarm_agent_done', 'swarm_bids', 'swarm_monitor',
  'swarm_vote_open', 'swarm_vote_cast', 'swarm_vote_closed', 'swarm_escalation',
  'swarm_escalation_resolved', 'swarm_final', 'swarm_done', 'blackboard',
])

function freshSwarm(msg) {
  return {
    runId: msg.runId,
    requested: msg.pattern,
    pattern: msg.pattern === 'auto' ? null : msg.pattern,
    provider: msg.provider,
    goal: msg.goal || '',
    status: 'running',
    outcome: null,
    stats: null,
    team: {},
    order: [],
    graph: { layout: 'flow', nodes: [], edges: [], lastFlow: null },
    monitor: { calls: 0, maxCalls: msg.budget || 0, estTokens: 0, elapsedMs: 0, flags: [] },
    bids: null,
    vote: null,
    escalation: null,
    architect: null,
    finalEventId: null,
    startedAt: msg.startedAt || 0,
  }
}

function patchAgent(swarm, agentId, patch) {
  const prev = swarm.team[agentId]
  if (!prev) return swarm
  return { ...swarm, team: { ...swarm.team, [agentId]: { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) } } }
}

// A board frame older than the one we hold (fewer items, written no later) is
// a late copy of something a snapshot already contained.
function staleBoard(current, next) {
  return Boolean(current && next) && (next.seq || 0) < (current.seq || 0) && (next.updatedAt || 0) <= (current.updatedAt || 0)
}

// Returns { swarm, blackboard } or null when the message isn't a swarm message.
// A frame applied twice (a late relay copy after a snapshot) changes nothing.
export function reduceSwarmView(view, msg) {
  if (!msg || !SWARM_MESSAGE_TYPES.has(msg.type)) return null
  const { swarm, blackboard } = view || {}
  if (msg.type === 'blackboard') return { swarm, blackboard: staleBoard(blackboard, msg.board) ? blackboard : msg.board || null }
  if (msg.type === 'swarm_started') return { swarm: swarm?.runId === msg.runId ? swarm : freshSwarm(msg), blackboard }
  if (!swarm || (msg.runId && msg.runId !== swarm.runId)) return { swarm, blackboard }

  switch (msg.type) {
    case 'swarm_team': {
      const team = { ...swarm.team }
      const order = [...swarm.order]
      for (const a of msg.agents || []) {
        if (!team[a.id]) order.push(a.id)
        team[a.id] = { ...(team[a.id] || { status: 'idle', stream: '', task: '' }), ...a }
      }
      return { swarm: { ...swarm, team, order }, blackboard }
    }
    case 'swarm_architect':
      return { swarm: { ...swarm, pattern: msg.pattern, architect: { pattern: msg.pattern, reason: msg.reason } }, blackboard }
    case 'swarm_graph': {
      const statusOf = Object.fromEntries((swarm.graph.nodes || []).map((n) => [n.id, n.status]))
      const nodes = (msg.nodes || []).map((n) => ({ ...n, status: statusOf[n.id] || n.status || 'queued' }))
      // The graph grows mid-run (managers, then their workers): edges the team
      // already flowed along stay marked as used.
      const usedEdges = new Set((swarm.graph.edges || []).filter((e) => e.used).map((e) => `${e.from}>${e.to}`))
      const edges = (msg.edges || []).map((e) => (usedEdges.has(`${e.from}>${e.to}`) ? { ...e, used: true } : e))
      return { swarm: { ...swarm, graph: { ...swarm.graph, layout: msg.layout || 'flow', nodes, edges } }, blackboard }
    }
    case 'swarm_node':
      return { swarm: { ...swarm, graph: { ...swarm.graph, nodes: swarm.graph.nodes.map((n) => (n.id === msg.nodeId ? { ...n, status: msg.status } : n)) } }, blackboard }
    case 'swarm_edge':
      return { swarm: { ...swarm, graph: { ...swarm.graph, lastFlow: { from: msg.from, to: msg.to, seq: (swarm.graph.lastFlow?.seq || 0) + 1 }, edges: swarm.graph.edges.map((e) => (e.from === msg.from && e.to === msg.to ? { ...e, used: true } : e)) } }, blackboard }
    case 'swarm_agent_start':
      return { swarm: patchAgent(swarm, msg.agentId, { status: msg.kind === 'text' || msg.kind === 'debate_turn' ? 'speaking' : 'thinking', task: msg.task || '', stream: '', tokenSeq: 0, kind: msg.kind, nodeId: msg.nodeId }), blackboard }
    case 'swarm_token':
      if (msg.seq && swarm.team[msg.agentId]?.tokenSeq >= msg.seq) return { swarm, blackboard }
      return { swarm: patchAgent(swarm, msg.agentId, (a) => ({ stream: msg.reset ? '' : (a.stream || '') + (msg.delta || ''), ...(msg.seq ? { tokenSeq: msg.seq } : {}) })), blackboard }
    case 'swarm_agent_done':
      return { swarm: patchAgent(swarm, msg.agentId, { status: msg.state === 'TASK_STATE_COMPLETED' ? 'done' : msg.state === 'TASK_STATE_CANCELED' ? 'canceled' : 'failed', stream: '' }), blackboard }
    case 'swarm_bids':
      return { swarm: { ...swarm, bids: { round: msg.round, bids: msg.bids || [] } }, blackboard }
    case 'swarm_monitor':
      return { swarm: { ...swarm, monitor: { calls: msg.calls, maxCalls: msg.maxCalls, estTokens: msg.estTokens, elapsedMs: msg.elapsedMs, flags: msg.flags || [] } }, blackboard }
    case 'swarm_vote_open':
      return { swarm: { ...swarm, vote: { voteId: msg.voteId, question: msg.question, options: msg.options || [], deadline: msg.deadline, humans: msg.humans || [], votes: [], open: true, tally: null, winner: null } }, blackboard }
    case 'swarm_vote_cast': {
      if (!swarm.vote || swarm.vote.voteId !== msg.voteId) return { swarm, blackboard }
      const votes = swarm.vote.votes.filter((v) => !(v.voter.id === msg.voter.id && v.voter.kind === msg.voter.kind))
      return { swarm: { ...swarm, vote: { ...swarm.vote, votes: [...votes, { voter: msg.voter, option: msg.option }] } }, blackboard }
    }
    case 'swarm_vote_closed':
      if (!swarm.vote || swarm.vote.voteId !== msg.voteId) return { swarm, blackboard }
      return { swarm: { ...swarm, vote: { ...swarm.vote, open: false, tally: msg.tally, winner: msg.winner, tieBreak: msg.tieBreak || null } }, blackboard }
    case 'swarm_escalation':
      return { swarm: { ...swarm, escalation: { escalationId: msg.escalationId, kind: msg.kind, reason: msg.reason, options: msg.options, defaultDecision: msg.defaultDecision, deadline: msg.deadline } }, blackboard }
    case 'swarm_escalation_resolved':
      return { swarm: { ...swarm, escalation: swarm.escalation?.escalationId === msg.escalationId ? null : swarm.escalation }, blackboard }
    case 'swarm_final':
      return { swarm: { ...swarm, finalEventId: msg.eventId }, blackboard }
    case 'swarm_done': {
      const team = Object.fromEntries(Object.entries(swarm.team).map(([id, a]) => [id, { ...a, status: a.status === 'speaking' || a.status === 'thinking' ? 'idle' : a.status, stream: '' }]))
      const nodes = swarm.graph.nodes.map((n) => (n.status === 'queued' ? { ...n, status: 'unused' } : n.status === 'running' ? { ...n, status: 'canceled' } : n))
      return { swarm: { ...swarm, team, graph: { ...swarm.graph, nodes }, status: 'done', outcome: msg.outcome, stats: msg.stats || null, vote: swarm.vote ? { ...swarm.vote, open: false } : null, escalation: null }, blackboard }
    }
    default:
      return { swarm, blackboard }
  }
}

// When a run is interrupted (pause/stop/redirect/host lost), close the view honestly.
export function interruptedDone(swarm, outcome) {
  if (!swarm || swarm.status !== 'running') return null
  return { type: 'swarm_done', runId: swarm.runId, outcome, stats: { calls: swarm.monitor.calls, estTokens: swarm.monitor.estTokens, elapsedMs: swarm.monitor.elapsedMs, pattern: swarm.pattern } }
}

// Late-joiner snapshots travel over size-limited relays: keep the view, drop bulk.
export function compactSwarmView(swarm, { streamChars = 600 } = {}) {
  if (!swarm) return null
  const team = Object.fromEntries(Object.entries(swarm.team || {}).map(([id, a]) => [id, { ...a, stream: String(a.stream || '').slice(-streamChars), task: String(a.task || '').slice(0, 160) }]))
  return { ...swarm, team }
}
