// Agent role catalog (lecture: agent role patterns). Pure data + helpers, shared
// by the Node server and the browser host. Every role can render an A2A-style
// agent card for discovery.

export const ROLES = {
  architect: {
    name: 'Architect', glyph: '◇', color: '#CCD0CF',
    description: 'Chooses the multi-agent architecture for a goal, weighing cost, latency and the shape of the work.',
    skills: [{ id: 'choose_architecture', name: 'Choose architecture', description: 'Picks one of the nine HiveMind architectures and explains the tradeoff.', tags: ['meta', 'planning'] }],
    system: 'You are the Architect of a multi-agent team. You do not solve the task yourself. You choose how a team of agents should be organized to solve it, given the constraints you are told about.',
  },
  router: {
    name: 'Router', glyph: '⇢', color: '#9BA8AB',
    description: 'Classifies a request by intent and hands it to the one specialist best suited to answer.',
    skills: [{ id: 'route', name: 'Intent routing', description: 'Reads agent cards and dispatches the request to one specialist.', tags: ['routing', 'triage'] }],
    system: 'You are a Router. You only dispatch work: read the request, compare it with the specialists available, and pick exactly one. You never answer the request yourself.',
  },
  orchestrator: {
    name: 'Orchestrator', glyph: '✳', color: '#8EB69B',
    description: 'Decomposes a goal into subtasks, delegates each to a specialist, and combines their results.',
    skills: [{ id: 'decompose', name: 'Task decomposition', description: 'Splits a goal into delegated subtasks.', tags: ['planning'] }, { id: 'synthesize', name: 'Synthesis', description: 'Combines specialist outputs into one answer.', tags: ['synthesis'] }],
    system: 'You are the Orchestrator of a team of specialist agents. You plan, delegate, and combine. Keep plans small and concrete.',
  },
  planner: {
    name: 'Planner', glyph: '◫', color: '#8EB69B',
    description: 'Turns a goal into a dependency graph of small tasks that can run in parallel where possible.',
    skills: [{ id: 'plan_dag', name: 'Plan a task graph', description: 'Produces tasks with explicit dependencies.', tags: ['planning', 'dag'] }],
    system: 'You are a Planner. You turn a goal into a small graph of tasks with explicit dependencies, so independent tasks can run in parallel.',
  },
  vp: {
    name: 'VP', glyph: '▲', color: '#DAF1DE',
    description: 'Top of a hierarchy: splits a goal into workstreams for managers, then signs off on the combined result.',
    skills: [{ id: 'workstreams', name: 'Workstream planning', description: 'Breaks a goal into independent workstreams.', tags: ['hierarchy', 'planning'] }],
    system: 'You are the VP at the top of a team hierarchy. You set direction: split the goal into workstreams, then review what your managers report and write the final answer.',
  },
  manager: {
    name: 'Manager', glyph: '◆', color: '#A9C9B2',
    description: 'Middle of a hierarchy: breaks one workstream into worker tasks and summarizes the results upward.',
    skills: [{ id: 'local_plan', name: 'Local planning', description: 'Plans one workstream for workers.', tags: ['hierarchy'] }],
    system: 'You are a Manager in a team hierarchy. You own one workstream: plan it for your workers, then summarize their results for the VP.',
  },
  worker: {
    name: 'Worker', glyph: '●', color: '#9BA8AB',
    description: 'Executes one narrowly scoped task and reports the result.',
    skills: [{ id: 'execute', name: 'Execute task', description: 'Completes one focused task.', tags: ['execution'] }],
    system: 'You are a Worker agent. Do exactly the task you are given, concretely and briefly.',
  },
  splitter: {
    name: 'Splitter', glyph: '⑃', color: '#C7A9A3',
    description: 'Fans a goal out into distinct angles so several agents can explore it in parallel.',
    skills: [{ id: 'split', name: 'Fan-out', description: 'Splits a goal into independent perspectives.', tags: ['fan-out'] }],
    system: 'You are a Splitter. You break a goal into distinct, non-overlapping angles that separate agents can explore in parallel.',
  },
  combiner: {
    name: 'Combiner', glyph: '⑂', color: '#DAF1DE',
    description: 'Fans results back in: merges parallel outputs into one answer and notes anything missing.',
    skills: [{ id: 'merge', name: 'Fan-in', description: 'Merges parallel results with tradeoffs.', tags: ['fan-in', 'synthesis'] }],
    system: 'You are a Combiner. You merge several parallel perspectives into one clear answer with tradeoffs, and you say plainly if a perspective is missing.',
  },
  researcher: {
    name: 'Researcher', glyph: '⌕', color: '#8EB69B',
    description: 'Gathers relevant facts from the conversation and general knowledge, and flags what still needs checking.',
    skills: [{ id: 'gather_facts', name: 'Gather facts', description: 'Lists relevant facts and separates fact from opinion.', tags: ['research'] }],
    system: 'You are a Researcher. You gather relevant facts, separate fact from opinion, and flag what is uncertain or needs checking. You have no web access or tools; work from the conversation and general knowledge, and say so when something should be verified.',
  },
  interrogator: {
    name: 'Interrogator', glyph: '?', color: '#E8D2C4',
    description: 'Asks targeted questions to surface missing information, contradictions and ambiguity.',
    skills: [{ id: 'probe', name: 'Probe gaps', description: 'Finds missing information and contradictions.', tags: ['questions'] }],
    system: 'You are an Interrogator. You find what is missing, ambiguous or contradictory, and ask the few sharp questions that would change the answer.',
  },
  analyst: {
    name: 'Analyst', glyph: '◎', color: '#A7B9C2',
    description: 'Weighs the facts, compares options, and commits to concrete decisions.',
    skills: [{ id: 'analyze', name: 'Analyze and decide', description: 'Turns facts into decisions with reasons.', tags: ['analysis'] }],
    system: 'You are an Analyst. You weigh the facts, compare options, and commit to clear decisions with reasons.',
  },
  writer: {
    name: 'Writer', glyph: '✎', color: '#C7A9A3',
    description: 'Writes the deliverable the humans asked for, clearly and in the right format.',
    skills: [{ id: 'write', name: 'Write deliverable', description: 'Drafts the final answer for the humans.', tags: ['writing'] }],
    system: 'You are a Writer. You turn the team’s work into the deliverable the humans asked for: clear, structured, and in the right format.',
  },
  critic: {
    name: 'Critic', glyph: '✓', color: '#D58B82',
    description: 'Verifies drafts: checks claims against the facts, finds gaps, and approves or asks for a revision.',
    skills: [{ id: 'verify', name: 'Verify draft', description: 'Reviews a draft and returns APPROVE or REVISE with fixes.', tags: ['verification'] }],
    system: 'You are a Critic (verifier). You check the draft against the facts, the constraints and the goal. List concrete problems, then end with exactly one line: "VERDICT: APPROVE" or "VERDICT: REVISE".',
  },
  synthesizer: {
    name: 'Synthesizer', glyph: '⬡', color: '#DAF1DE',
    description: 'Pulls the team’s facts and decisions together into a single answer for the humans.',
    skills: [{ id: 'synthesize', name: 'Synthesize', description: 'Writes the combined answer from the shared blackboard.', tags: ['synthesis'] }],
    system: 'You are a Synthesizer. You pull the team’s facts and decisions into one clear answer for the humans.',
  },
  builder: {
    name: 'Builder', glyph: '▣', color: '#8EB69B',
    description: 'Debate peer who argues for the most ambitious workable option.',
    skills: [{ id: 'propose', name: 'Propose', description: 'Argues for an ambitious option.', tags: ['debate'] }],
    system: 'You are the Builder, one of three equal peers in a debate. You argue for the most ambitious option that can actually work.',
  },
  skeptic: {
    name: 'Skeptic', glyph: '⊘', color: '#D58B82',
    description: 'Debate peer who stress-tests every proposal and argues for the safest option.',
    skills: [{ id: 'challenge', name: 'Challenge', description: 'Finds risks and failure modes.', tags: ['debate'] }],
    system: 'You are the Skeptic, one of three equal peers in a debate. You stress-test proposals, name the risks, and argue for the safest option.',
  },
  pragmatist: {
    name: 'Pragmatist', glyph: '⊜', color: '#E8D2C4',
    description: 'Debate peer who looks for the option that ships soonest with acceptable risk.',
    skills: [{ id: 'balance', name: 'Balance', description: 'Finds the practical middle path.', tags: ['debate'] }],
    system: 'You are the Pragmatist, one of three equal peers in a debate. You look for the option that can ship soonest with acceptable risk.',
  },
  monitor: {
    name: 'Monitor', glyph: '◉', color: '#7D8C92',
    description: 'Deterministic observer (not an LLM): watches budget, time, repeated output and flagged inputs, and escalates to the humans.',
    skills: [{ id: 'observe', name: 'Observe and escalate', description: 'Raises budget, loop and policy escalations to humans.', tags: ['governance', 'safety'] }],
    system: '',
  },
}

export const SPECIALISTS = ['researcher', 'analyst', 'writer', 'critic', 'interrogator']

// An agent instance in a run. Dynamic agents (workers, managers, fan-out personas)
// share a base role but get their own id and label.
export function makeAgent(role, { id = role, label = null, focus = null } = {}) {
  const base = ROLES[role] || ROLES.worker
  return {
    id,
    role,
    name: label || base.name,
    glyph: base.glyph,
    color: base.color,
    focus,
    description: focus ? `${base.description} Focus: ${focus}` : base.description,
  }
}

export function agentAuthor(agent) {
  return { id: agent.id, name: agent.name, color: agent.color, glyph: agent.glyph, kind: 'agent', role: agent.role }
}

// A2A-style agent card (discovery metadata). HiveMind publishes these as static
// JSON; it does not expose an A2A RPC endpoint.
export function agentCard(roleId, baseUrl = 'https://hivemind-agents.vercel.app') {
  const r = ROLES[roleId]
  if (!r) return null
  return {
    protocolVersion: '0.3.0',
    name: `HiveMind ${r.name}`,
    description: r.description,
    url: `${baseUrl}/agents/${roleId}.json`,
    version: '1.0.0',
    provider: { organization: 'HiveMind' },
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: r.skills.map((s) => ({ ...s, examples: [] })),
  }
}

export function hiveCard(baseUrl = 'https://hivemind-agents.vercel.app', patternSkills = []) {
  return {
    protocolVersion: '0.3.0',
    name: 'HiveMind',
    description: 'A shared room where a team of humans and a team of AI agents work on one goal together. Choose from nine multi-agent architectures.',
    url: baseUrl,
    version: '1.0.0',
    provider: { organization: 'HiveMind' },
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: patternSkills,
  }
}
