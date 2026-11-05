// The nine HiveMind architectures: the eight patterns from the agentic
// architectures lecture plus an adaptive "Auto" mode. Pure data, shared by the
// engine (the Architect reads it) and the UI (the pattern picker shows it).

export const PATTERNS = {
  auto: {
    id: 'auto', name: 'Auto', aka: 'Adaptive architecture',
    summary: 'An Architect agent reads the goal and designs the team for it, choosing one of the eight patterns at runtime.',
    usefulWhen: 'You are not sure which shape the work has, or you want to see the system decide.',
    pros: ['The system adapts its own structure to each goal', 'Weighs cost and latency for the brain you picked'],
    cons: ['One extra model call', 'Less predictable than choosing yourself'],
    axes: { control: 'adaptive', execution: 'chosen at runtime', collaboration: 'chosen at runtime', timing: 'runtime' },
    team: ['architect'], baseCalls: 1,
  },
  sequential: {
    id: 'sequential', name: 'Sequential', aka: 'Pipeline, Assembly line',
    summary: 'Specialists work in a fixed line. Each one’s output is the next one’s input.',
    usefulWhen: 'The work has clear stages where one feeds the next.',
    pros: ['Simple and predictable', 'Clear separation of concerns', 'Easy to inspect and gate'],
    cons: ['Inflexible', 'No parallelism', 'Every agent is a point of failure'],
    axes: { control: 'centralized', execution: 'sequential', collaboration: 'review', timing: 'design time' },
    team: ['researcher', 'analyst', 'writer', 'critic'], baseCalls: 5,
  },
  router: {
    id: 'router', name: 'Router', aka: 'Handoff, Greeter',
    summary: 'A Router reads the request and hands it to the single best specialist. No planning, no merging.',
    usefulWhen: 'You need fast delegation, not planning.',
    pros: ['Cheapest team: two calls', 'Clear roles, no planner overhead'],
    cons: ['The router is a single point of failure', 'A wrong route gives a poor answer'],
    axes: { control: 'centralized', execution: 'single handoff', collaboration: 'none', timing: 'runtime routing' },
    team: ['router', 'researcher', 'analyst', 'writer', 'critic', 'interrogator'], baseCalls: 2,
  },
  orchestrator: {
    id: 'orchestrator', name: 'Orchestrator', aka: 'Supervisor, Hub and spoke',
    summary: 'An Orchestrator plans subtasks, delegates them to specialists, and combines the results.',
    usefulWhen: 'The work splits into subtasks that need different expertise.',
    pros: ['Modular, clear authority', 'Specialists stay focused'],
    cons: ['The orchestrator is a bottleneck', 'Everything depends on a good plan'],
    axes: { control: 'centralized', execution: 'delegated, parallel', collaboration: 'combine', timing: 'runtime plan' },
    team: ['orchestrator', 'researcher', 'analyst', 'writer', 'critic', 'interrogator'], baseCalls: 6,
  },
  hierarchical: {
    id: 'hierarchical', name: 'Hierarchical', aka: 'Tree of agents',
    summary: 'A VP splits the goal into workstreams, Managers plan each one for Workers, and results roll back up.',
    usefulWhen: 'The task is big and has natural domain boundaries.',
    pros: ['Good governance', 'Each manager focuses on its subtree', 'Some parallelism'],
    cons: ['A point of failure at every level', 'Management overhead (the bureaucracy tax)'],
    axes: { control: 'hierarchical', execution: 'layered, partly parallel', collaboration: 'review upward', timing: 'runtime plan' },
    team: ['vp', 'manager', 'worker'], baseCalls: 10,
  },
  parallel: {
    id: 'parallel', name: 'Parallel', aka: 'DAG, Workflow graph',
    summary: 'A Planner draws a task graph with dependencies. Independent tasks run at the same time; a Synthesizer joins them.',
    usefulWhen: 'Multi-stage work with independent parts, and you want control over the flow.',
    pros: ['Predictable, graph-shaped execution', 'Parallel where it can be'],
    cons: ['Needs a good graph', 'No gain if the work is really serial'],
    axes: { control: 'centralized', execution: 'directed acyclic graph', collaboration: 'combine', timing: 'runtime graph' },
    team: ['planner', 'researcher', 'analyst', 'writer', 'critic', 'synthesizer'], baseCalls: 7,
  },
  fanout: {
    id: 'fanout', name: 'Fan-out / Fan-in', aka: 'Branch and merge, MapReduce',
    summary: 'A Splitter fans the goal out to several personas who work in parallel; a Combiner merges what comes back.',
    usefulWhen: 'Many independent angles and a principled way to combine them (ideas, reviews, options).',
    pros: ['Massively parallel', 'A deadline gives partial results instead of waiting'],
    cons: ['Only fits independent work', 'Many parallel calls cost more'],
    axes: { control: 'centralized', execution: 'parallel', collaboration: 'merge', timing: 'runtime split' },
    team: ['splitter', 'worker', 'combiner'], baseCalls: 5,
  },
  debate: {
    id: 'debate', name: 'Peer-to-peer', aka: 'Decentralized debate',
    summary: 'Three equal peers debate in rounds, each proposes an answer, and everyone (humans included) votes. The winner writes it up.',
    usefulWhen: 'A decision with real tradeoffs where you want disagreement on the record.',
    pros: ['No central authority', 'Diverse views, explicit consensus', 'Humans vote with the agents'],
    cons: ['Communication cost grows with peers', 'Can stall without tie-breaks'],
    axes: { control: 'decentralized', execution: 'turns in rounds', collaboration: 'debate and vote', timing: 'runtime' },
    team: ['builder', 'skeptic', 'pragmatist'], baseCalls: 7,
  },
  swarm: {
    id: 'swarm', name: 'Swarm', aka: 'Emergent collaboration',
    summary: 'Five agents share a blackboard and take turns by a strategy you choose (priority bids by default), so the order emerges from the work itself.',
    usefulWhen: 'Open-ended problems where the path is not known in advance.',
    pros: ['No single point of failure', 'Diverse coverage of edge cases', 'Emergent behaviour'],
    cons: ['Harder to predict and debug', 'Needs budgets, loop detection and tie-breaks'],
    axes: { control: 'emergent', execution: 'self-organizing', collaboration: 'shared blackboard', timing: 'runtime' },
    team: ['researcher', 'interrogator', 'analyst', 'critic', 'synthesizer'], baseCalls: 9,
  },
}

export const PATTERN_ORDER = ['auto', 'sequential', 'router', 'orchestrator', 'hierarchical', 'parallel', 'fanout', 'debate', 'swarm']

// Group-chat turn-taking (lecture: Round Robin, Active Agent, Moderator,
// Self-Selection, Priority Score / Auction). Only the two conversational
// patterns take turns; the others run in an order their plan fixes.
export const TURN_TAKING = {
  round_robin: { id: 'round_robin', name: 'Round robin', aka: 'Fixed order', summary: 'Agents speak in a fixed, repeating order. A turn with nothing to work on is skipped.' },
  handoff: { id: 'handoff', name: 'Handoff', aka: 'Active agent', summary: 'The agent that has the floor names who speaks next. A pick that cannot be used falls back to the default rule.' },
  moderator: { id: 'moderator', name: 'Moderator', aka: 'Chat manager', summary: 'A Moderator agent reads the conversation and picks the next speaker each turn. Each real choice costs one extra call.' },
  self_select: { id: 'self_select', name: 'Self-selection', aka: 'Agents opt in', summary: 'Each agent decides for itself whether it has something to add. Up to two speak at once, ties go to a fixed priority, and each has a response limit.' },
  auction: { id: 'auction', name: 'Priority bids', aka: 'Priority score', summary: 'Each agent scores how much it can add right now; the highest bid speaks.' },
}

// Allowed strategies per pattern, default first. Empty: the pattern has no turns.
const TURN_TAKING_BY_PATTERN = {
  debate: ['round_robin', 'moderator', 'auction', 'handoff'],
  swarm: ['auction', 'round_robin', 'moderator', 'self_select', 'handoff'],
}

export function turnTakingFor(patternId) {
  return [...(TURN_TAKING_BY_PATTERN[patternId] || [])]
}

// Picks the Moderator makes in a run, on top of the speakers' own calls. A
// debate's last peer in each round needs no pick; a swarm's first turn has a
// single candidate (only the Researcher has work on an empty board).
function moderatorCalls(patternId, rounds) {
  if (patternId === 'debate') return 2 * rounds
  if (patternId === 'swarm') return 6
  return 0
}

export const PROVIDER_PROFILE = {
  simulated: { concurrency: 4, secondsPerCall: 3, label: 'Scripted demo' },
  free: { concurrency: 1, secondsPerCall: 30, label: 'Free model' },
  groq: { concurrency: 3, secondsPerCall: 4, label: 'Groq' },
  ollama: { concurrency: 1, secondsPerCall: 12, label: 'Ollama' },
}

const MAX_CALLS_CAP = 16

// Default sizing per pattern, shrunk for the slow free tier so a run stays usable.
export function defaultConfig(patternId, provider = 'simulated') {
  const slow = provider === 'free'
  const p = PATTERNS[patternId] || PATTERNS.auto
  const width = slow ? 2 : patternId === 'hierarchical' ? 2 : 3
  const rounds = slow ? 1 : 2
  const config = {
    width,
    rounds,
    turnTaking: turnTakingFor(patternId)[0] || null,
    fanInMs: slow ? 240_000 : 60_000,
  }
  config.maxCalls = Math.min(MAX_CALLS_CAP, estimateCalls(patternId, config) + 2)
  if (p.id === 'auto') config.maxCalls = MAX_CALLS_CAP
  return config
}

export function estimateCalls(patternId, { width = 3, rounds = 2, turnTaking = null } = {}) {
  const extra = turnTaking === 'moderator' ? moderatorCalls(patternId, rounds) : 0
  switch (patternId) {
    case 'sequential': return 5
    case 'router': return 2
    case 'orchestrator': return 2 + Math.min(4, width + 1)
    case 'hierarchical': return 1 + width + width * width + width + 1
    case 'parallel': return 2 + Math.min(5, width + 1)
    case 'fanout': return width + 2
    case 'debate': return 3 * rounds + 1 + extra
    // Round robin and self-selection revisit agents once new facts land.
    case 'swarm': return (turnTaking === 'round_robin' || turnTaking === 'self_select' ? 10 : 9) + extra
    default: return 8
  }
}

export function estimateSeconds(patternId, provider, config) {
  const prof = PROVIDER_PROFILE[provider] || PROVIDER_PROFILE.simulated
  const calls = estimateCalls(patternId, config)
  return Math.round(calls * prof.secondsPerCall / (patternId === 'fanout' || patternId === 'parallel' ? Math.max(1, Math.min(prof.concurrency, 3)) : 1))
}

export function clampConfig(patternId, provider, raw = {}) {
  const base = defaultConfig(patternId, provider)
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d)
  const out = {
    width: num(raw.width, 1, provider === 'free' ? 3 : 4, base.width),
    rounds: num(raw.rounds, 1, 3, base.rounds),
    // A strategy the pattern does not offer (or any, for a pattern with no
    // turns) falls back to the pattern's default.
    turnTaking: turnTakingFor(patternId).includes(raw.turnTaking) ? raw.turnTaking : base.turnTaking,
    fanInMs: num(raw.fanInMs, 10_000, 300_000, base.fanInMs),
  }
  out.maxCalls = num(raw.maxCalls, 2, MAX_CALLS_CAP, Math.min(MAX_CALLS_CAP, estimateCalls(patternId, out) + 2))
  if (patternId === 'auto') out.maxCalls = num(raw.maxCalls, 4, MAX_CALLS_CAP, MAX_CALLS_CAP)
  return out
}

// Skills for the HiveMind agent card: one per architecture.
export function patternSkills() {
  return PATTERN_ORDER.map((id) => ({
    id: `architecture_${id}`,
    name: `${PATTERNS[id].name} team`,
    description: PATTERNS[id].summary,
    tags: ['multi-agent', id],
    examples: [],
  }))
}
