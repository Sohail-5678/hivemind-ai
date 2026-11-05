// Scripted brain for agent teams. No model behind it: it produces role-shaped
// text and valid JSON plans anchored to the goal's topic, so the whole multi-agent
// engine can be demonstrated (and tested) with zero keys and zero network.
// The engine marks every scripted message as such; the UI says so.
import { topicOf } from '../simulated.js'

function abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

// The abort listener goes when the timer fires: a paced run sleeps hundreds of
// times on one signal.
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError())
  const onAbort = () => { clearTimeout(t); reject(abortError()) }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
  signal?.addEventListener('abort', onAbort, { once: true })
})

function hash(s) {
  let h = 0
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

const pick = (arr, seed) => arr[seed % arr.length]

export function chooseArchitectureHeuristic(goal) {
  const g = String(goal || '').toLowerCase()
  if (/\b(brainstorm|ideas?|names?|options|angles|perspectives|slogans?)\b/.test(g)) return { pattern: 'fanout', reason: 'The goal asks for many independent ideas that can be explored in parallel and merged.' }
  if (/\b(should we|decide|decision|vs\.?|versus|or not|trade-?offs?|pros and cons)\b/.test(g)) return { pattern: 'debate', reason: 'This is a decision with real tradeoffs, so equal peers should argue it out and vote.' }
  if (/\b(launch|roadmap|program|strategy|go-to-market|org|company|end to end)\b/.test(g)) return { pattern: 'hierarchical', reason: 'The goal is large with natural workstreams, so a VP and managers can split it cleanly.' }
  if (/\b(plan|steps|pipeline|process|migrate|build|implement|schedule)\b/.test(g)) return { pattern: 'parallel', reason: 'The work has stages with some independent parts, so a dependency graph lets those run in parallel.' }
  if (/\b(report|write|draft|essay|email|memo|summary|summari[sz]e)\b/.test(g)) return { pattern: 'sequential', reason: 'This is a document: research, analysis, writing and review feed each other in a fixed order.' }
  if (g.split(/\s+/).length <= 8 || /^\s*(what|who|when|where|how|why|is|are|can|does)\b/.test(g)) return { pattern: 'router', reason: 'A short, direct question only needs the one right specialist, which is the cheapest team.' }
  if (/\b(explore|investigate|figure out|unknown|research|root cause)\b/.test(g)) return { pattern: 'swarm', reason: 'The path is not known in advance, so a self-organizing swarm on a shared blackboard fits.' }
  return { pattern: 'orchestrator', reason: 'The goal splits into a few subtasks needing different expertise, so an orchestrator can delegate and combine.' }
}

export function routeHeuristic(goal) {
  const g = String(goal || '').toLowerCase()
  if (/\b(write|draft|email|post|copy|rewrite)\b/.test(g)) return 'writer'
  if (/\b(review|check|critique|audit|verify|wrong)\b/.test(g)) return 'critic'
  if (/\b(compare|analy[sz]e|decide|which|should)\b/.test(g)) return 'analyst'
  if (/\b(unclear|requirements|scope|clarify)\b/.test(g)) return 'interrogator'
  return 'researcher'
}

export function scriptedJSON(kind, ctx) {
  const topic = ctx.topic
  const width = Math.max(1, Math.min(4, ctx.width || 3))
  switch (kind) {
    case 'architect': {
      const c = chooseArchitectureHeuristic(ctx.goal)
      return c
    }
    case 'route': {
      const agent = routeHeuristic(ctx.goal)
      return { agent, reason: `The request is mainly a ${agent === 'researcher' ? 'fact-finding' : agent} job, so the ${agent} is the best single specialist.` }
    }
    case 'orchestrator_plan': {
      const subtasks = [
        { id: 's1', title: `Gather the key facts about ${topic}`, agent: 'researcher', dependsOn: [] },
        { id: 's2', title: `List the open questions and risks for ${topic}`, agent: 'interrogator', dependsOn: [] },
        { id: 's3', title: `Weigh the options and recommend one`, agent: 'analyst', dependsOn: ['s1', 's2'] },
      ]
      if (width >= 3) subtasks.push({ id: 's4', title: 'Check the recommendation for gaps', agent: 'critic', dependsOn: ['s3'] })
      return { subtasks }
    }
    case 'vp_plan': {
      const streams = [
        { title: 'Product and users', brief: `What the people affected need from ${topic}.` },
        { title: 'Execution and risk', brief: `How to carry out ${topic}, and what could go wrong.` },
        { title: 'Measurement', brief: `How we will know whether ${topic} worked.` },
      ]
      return { workstreams: streams.slice(0, width) }
    }
    case 'manager_plan': {
      const ws = ctx.workstream || 'the workstream'
      const tasks = [
        { title: `List the must-haves for ${ws.toLowerCase()}` },
        { title: `Identify the biggest risk in ${ws.toLowerCase()} and a mitigation` },
        { title: `Define one success measure for ${ws.toLowerCase()}` },
      ]
      return { tasks: tasks.slice(0, width) }
    }
    case 'dag_plan': {
      const nodes = [
        { id: 'n1', title: `Collect facts on ${topic}`, agent: 'researcher', dependsOn: [] },
        { id: 'n2', title: `Surface open questions`, agent: 'interrogator', dependsOn: [] },
        { id: 'n3', title: `Analyze options`, agent: 'analyst', dependsOn: ['n1'] },
        { id: 'n4', title: `Draft the plan`, agent: 'writer', dependsOn: ['n2', 'n3'] },
        { id: 'n5', title: `Review the draft`, agent: 'critic', dependsOn: ['n4'] },
      ]
      return { nodes: nodes.slice(0, Math.max(3, width + 1)) }
    }
    case 'split': {
      const angles = [
        { title: `The user's view of ${topic}`, persona: 'Customer advocate' },
        { title: `What could go wrong with ${topic}`, persona: 'Risk analyst' },
        { title: `The most ambitious take on ${topic}`, persona: 'Visionary' },
        { title: `The cheapest workable take on ${topic}`, persona: 'Frugal engineer' },
      ]
      return { angles: angles.slice(0, width) }
    }
    default:
      return {}
  }
}

function textFor(agent, kind, ctx) {
  const topic = ctx.topic
  const seed = hash(`${agent.id}|${ctx.goal}|${ctx.turn || 0}`)
  const role = agent.role
  const focus = agent.focus ? ` (${agent.focus})` : ''
  const lead = ctx.fallback ? 'The language model didn’t respond in time, so this is the scripted stand-in.\n\n' : ''

  if (kind === 'debate_turn') {
    const stance = {
      builder: `I'd go big on ${topic}: build the version people will talk about, then cut scope only where the data forces us.`,
      skeptic: `Before we commit to ${topic}, we need to price the failure modes. The plan that looks cheapest often isn't once support and rework land.`,
      pragmatist: `There's a middle path on ${topic}: ship the smallest version that tests the main bet in two weeks, then decide on the bigger build with real numbers.`,
    }[role] || `My view on ${topic} is to keep it simple.`
    let out = `${lead}${stance}`
    if (ctx.prevTurns) out += `\n\nResponding to the others: ${pick(['the strongest point so far is the focus on a quick test', 'I agree on the risk, but not on waiting', 'we are closer than it looks; the disagreement is about timing'], seed)}.`
    if (ctx.final) {
      const proposal = { builder: `Go all in on ${topic}, behind a feature flag so it can be rolled back.`, skeptic: `Run a two week risk review before committing to ${topic}.`, pragmatist: `Start with a two week pilot on ${topic} for one team, then decide.` }[role]
      const vote = { builder: 'Pragmatist', skeptic: 'Pragmatist', pragmatist: 'Builder' }[role]
      out += `\n\nPROPOSAL: ${proposal}\nVOTE: ${vote}`
    }
    return out
  }

  switch (role) {
    case 'researcher':
      return `${lead}Here is what we can say about ${topic}${focus} without outside sources.\n\nFACT: ${capital(topic)} touches more than one team, so ownership needs to be explicit.\nFACT: The first users will judge it on speed and clarity, not on feature count.\nFACT: There is at least one cheaper alternative the team should compare against.\nQUESTION: What does success look like in numbers for ${topic}?\n\nAnything above that depends on current market data should be checked before it is relied on.`
    case 'interrogator':
      return `${lead}A few questions would change the answer on ${topic}:\n\nQUESTION: Who is the single owner, and who signs off?\nQUESTION: What is the deadline, and is it fixed?\nQUESTION: What have we already ruled out, and why?\n\nUntil these are answered I'd treat any timeline as a guess.`
    case 'analyst':
      return `${lead}Weighing what's on the board for ${topic}:\n\nThe facts point to a narrow first version. The open questions are mostly about ownership and timing, which a short pilot answers cheaply.\n\nDECISION: Start with a two week pilot on ${topic} for one team.\nDECISION: Name one owner and one success measure before work starts.`
    case 'writer':
      return `${lead}**${capital(topic)}: recommended plan**\n\n1. **Pilot first.** Two weeks, one team, one owner.\n2. **Measure one thing.** Pick the single number that proves it works.\n3. **Decide with data.** Expand, change course, or stop at the end of the pilot.\n\n**Risks:** unclear ownership and a moving deadline; both are handled by naming an owner up front.`
    case 'critic': {
      const revise = ctx.allowRevise && !ctx.reviewedBefore
      return revise
        ? `${lead}The draft is clear, but it never says who owns the pilot or what number counts as success, and both are on the board as open questions.\n\nVERDICT: REVISE`
        : `${lead}The draft matches the goal, respects the constraints on the board, and the decisions are backed by the facts gathered. No blocking issues.\n\nVERDICT: APPROVE`
    }
    case 'worker':
      return `${lead}${capital(ctx.task || `Work on ${topic}`)}${focus}:\n\n- ${pick(['Keep the first version small enough to finish in two weeks.', 'Make one person accountable for the outcome.', 'Measure adoption in the first week, not just at the end.'], seed)}\n- ${pick(['Write down what is out of scope so it stays out.', 'Plan the rollback before the rollout.', 'Collect feedback from three real users before expanding.'], seed >>> 3)}\n\nFACT: ${pick(['Small pilots surface ownership problems early.', 'Rollback plans are cheapest to write before launch.', 'Early user feedback changes priorities more than internal debate.'], seed >>> 5)}`
    case 'manager':
      return `${lead}Summary for ${ctx.workstream || 'my workstream'}: the workers agree on a small first version, a named owner, and one early measure. The main risk is scope creep; the mitigation is a written out-of-scope list.\n\nDECISION: ${ctx.workstream || 'This workstream'} commits to a two week first slice.`
    case 'splitter':
    case 'planner':
    case 'router':
    case 'architect':
      return `${lead}Plan ready for ${topic}.`
    default: {
      // Final answers: orchestrator, vp, synthesizer, combiner, or a debate winner.
      const intro = ctx.final ? `**${capital(topic)}: the team's answer**` : `**${capital(topic)}**`
      return `${lead}${intro}\n\n- **Start small:** a two week pilot for one team, with one named owner.\n- **Measure:** agree one success number before work starts.\n- **Decide with data:** expand, adjust, or stop when the pilot ends.\n\n**What the team disagreed on:** how ambitious the first version should be. The plan above keeps the bold option open without betting on it yet.\n\n**Still open:** ${pick(['who signs off', 'the exact deadline', 'the budget ceiling'], seed)}; the humans in the room should settle it.`
    }
  }
}

function capital(s) {
  const t = String(s || '').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : t
}

// Streams scripted output with wall-clock pacing (background tabs throttle timers).
export async function scriptedCall({ agent, kind, ctx, signal, onDelta, pace = true }) {
  const isJson = kind !== 'text' && kind !== 'debate_turn'
  const topic = topicOf(ctx.goal || '')
  const full = { ...ctx, topic }
  const text = isJson ? JSON.stringify(scriptedJSON(kind, full)) : textFor(agent, kind, full)
  if (!pace) { if (!isJson) onDelta?.(text); return text }
  await sleep(isJson ? 500 : 350, signal)
  if (isJson) return text
  const words = text.split(/(?<=\s)/)
  const schedule = []
  let t = 0
  for (let i = 0; i < words.length; i++) { t += 14 + (hash(words[i] + i) % 22); schedule.push(t) }
  const start = Date.now()
  let i = 0
  while (i < words.length) {
    if (signal?.aborted) throw abortError()
    const elapsed = Date.now() - start
    // i++ outside the optional call: with no onDelta its arguments never run.
    while (i < words.length && schedule[i] <= elapsed) { const word = words[i++]; onDelta?.(word) }
    if (i < words.length) await sleep(Math.max(1, schedule[i] - (Date.now() - start)), signal)
  }
  return text
}
