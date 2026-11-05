// HiveMind multi-agent engine. Pure ES module: no Node or DOM APIs, so the Node
// server and the static host tab run the exact same orchestration.
//
// Implements the eight architecture patterns from the agentic architectures
// lecture plus an adaptive Architect, on top of a shared blackboard, with a
// deterministic Monitor that escalates to the humans in the room.
import { ROLES, SPECIALISTS, makeAgent, agentAuthor } from './roles.js'
import { PATTERNS, PATTERN_ORDER, PROVIDER_PROFILE, clampConfig, estimateCalls, turnTakingFor } from './patterns.js'
import { emptyBoard, normalizeBoard, addItem, setText, applyTags, stripTags, renderBoard, BOARD_KINDS } from './blackboard.js'
import { newTask, newMessage, a2aMeta, TASK_STATE } from './a2a.js'
import { extractJSON, asString, asArray } from './json.js'
import { scriptedCall, scriptedJSON, chooseArchitectureHeuristic, routeHeuristic } from './scripted.js'
import { topicOf } from '../simulated.js'
import { flagInjection, DATA_LABEL } from './guard.js'

const FLUSH_MS = 90
const ESCALATION_WAIT_MS = 30_000
const VOTE_WINDOW_MS = 20_000
const HARD_CALL_CAP = 24
const INPUT_MAX = 900
const HISTORY_MAX = 6
const USER_MAX = 9000 // characters in an agent's user turn
const GOAL_KEEP = 1500 // a long goal is trimmed to this before the teammates' inputs are

export class WrapUp extends Error {
  constructor() { super('wrap_up'); this.name = 'WrapUp' }
}

function abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

function isAbort(err, signal) {
  return err?.name === 'AbortError' || Boolean(signal?.aborted)
}

function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); break }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

// A freed slot passes straight to the next waiter (still counted as active), so
// a newcomer can never slip in between and exceed the provider's concurrency.
// Exported for the tests.
export function semaphore(n) {
  let active = 0
  const queue = []
  return async (fn) => {
    if (active >= n) await new Promise((r) => queue.push(r))
    else active++
    try { return await fn() } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
}

// Like Promise.all, but waits for every branch to settle before it rethrows, so
// no branch is still calling a model or persisting once the team wraps up.
async function allBranches(promises) {
  const settled = await Promise.allSettled(promises)
  const failed = settled.find((x) => x.status === 'rejected' && x.reason?.name !== 'WrapUp') || settled.find((x) => x.status === 'rejected')
  if (failed) throw failed.reason
  return settled.map((x) => x.value)
}

function cut(text, max) {
  return text.length <= max ? text : max > 1 ? `${text.slice(0, max - 1)}…` : ''
}

function words(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2))
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

const SPECIALIST_SET = new Set(SPECIALISTS)

export function createSwarmRun(opts) {
  const {
    runId, contextId, goal = '', history = [], humans = () => [],
    llm = { provider: 'simulated' }, emit = () => {}, persist = () => null, directives = () => [],
    signal = new AbortController().signal, idGen, now = () => Date.now(), pace = true, flushMs = FLUSH_MS,
  } = opts
  const provider = llm.provider || 'simulated'
  const profile = PROVIDER_PROFILE[provider] || PROVIDER_PROFILE.simulated
  const requested = PATTERNS[opts.pattern] ? opts.pattern : 'auto'
  // The goal is human text like any other: flagged phrasing reaches agents as data.
  const goalFlagged = flagInjection(goal)
  let counter = 0
  const ids = (prefix) => `${prefix}_${idGen ? idGen() : `${runId}_${++counter}`}`

  const S = {
    pattern: requested,
    config: clampConfig(requested, provider, opts.config || {}),
    // Pins, facts and decisions carry over between runs; the answer does not.
    board: setText(setText(setText(normalizeBoard(opts.board || emptyBoard()), 'final', '', now()), 'draft', '', now()), 'goal', goal, now()),
    calls: 0,
    reserved: 0,          // calls past the Monitor that have not finished yet
    budgetDecision: null, // the humans' pending answer to a budget escalation
    estTokens: 0,
    startedAt: now(),
    flags: [],
    loopCount: 0,
    loopEscalated: false,
    budgetEscalated: false,
    lastByAgent: new Map(),
    seenDirectiveIds: new Set(),
    consumedMentions: new Set(),
    escalations: new Map(),
    votes: new Map(),
    notices: new Set(),
    team: new Map(),
    graph: { layout: 'flow', nodes: [], edges: [] },
    outputs: [],
  }
  S.budget = S.config.maxCalls
  const sem = semaphore(Math.max(1, llm.concurrency || profile.concurrency))

  // ------------------------------------------------------------------ emit
  const emitBoard = () => emit({ type: 'blackboard', board: S.board })
  const monitorEmit = () => emit({ type: 'swarm_monitor', runId, calls: S.calls, maxCalls: S.budget, estTokens: S.estTokens, elapsedMs: now() - S.startedAt, flags: [...S.flags] })
  const note = (kind, content, meta = {}) => persist({
    type: 'swarm_note',
    author: { id: 'monitor', name: kind === 'architect' ? 'Architect' : kind === 'vote' ? 'Vote' : kind === 'plan' ? 'Plan' : 'Monitor', color: ROLES.monitor.color, glyph: ROLES.monitor.glyph, kind: 'system' },
    content,
    meta: { runId, kind, ...meta },
  })
  const noticeOnce = (key, notice) => {
    if (S.notices.has(key)) return
    S.notices.add(key)
    emit({ type: 'agent_notice', notice })
  }

  function register(agent) {
    if (S.team.has(agent.id)) return agent
    S.team.set(agent.id, agent)
    emit({ type: 'swarm_team', runId, agents: [{ id: agent.id, name: agent.name, role: agent.role, color: agent.color, glyph: agent.glyph, description: agent.description }] })
    return agent
  }

  function emitGraph() {
    emit({ type: 'swarm_graph', runId, layout: S.graph.layout, nodes: S.graph.nodes, edges: S.graph.edges })
  }
  function setGraph(layout, nodes = [], edges = []) {
    S.graph = { layout, nodes: [], edges: [] }
    addToGraph(nodes, edges)
  }
  function addToGraph(nodes = [], edges = []) {
    for (const n of nodes) {
      if (S.graph.nodes.some((x) => x.id === n.id)) continue
      const agent = S.team.get(n.agentId)
      S.graph.nodes.push({ id: n.id, label: asString(n.label, 60) || agent?.name || n.id, agentId: n.agentId, role: agent?.role, glyph: agent?.glyph, color: agent?.color, layer: n.layer || 0, order: n.order || 0, status: 'queued' })
    }
    for (const e of edges) {
      if (!e || e.from === e.to) continue
      if (S.graph.edges.some((x) => x.from === e.from && x.to === e.to)) continue
      S.graph.edges.push({ from: e.from, to: e.to, conditional: Boolean(e.conditional) })
    }
    emitGraph()
  }
  const nodeStatus = (nodeId, status) => { if (nodeId) emit({ type: 'swarm_node', runId, nodeId, status }) }
  const flow = (from, to, extra = {}) => {
    if (!from || !to || from === to) return
    if (!S.graph.edges.some((e) => e.from === from && e.to === to)) addToGraph([], [{ from, to, ...extra }])
    emit({ type: 'swarm_edge', runId, from, to })
  }

  // ------------------------------------------------------------------ humans
  function mentionsOf(text) {
    return [...String(text || '').matchAll(/@([a-z][\w-]*)/gi)].map((m) => m[1].toLowerCase())
  }
  function mentionsAgent(text, agent) {
    const m = mentionsOf(text)
    if (!m.length) return false
    const keys = new Set([agent.id.toLowerCase(), agent.role, agent.name.toLowerCase().split(/[\s·]+/)[0]])
    return m.some((x) => keys.has(x))
  }
  function currentDirectives() {
    return (directives() || []).filter((d) => d && d.content).slice(-HISTORY_MAX)
  }

  // ------------------------------------------------------------------ prompts
  function toInput(r) {
    if (!r) return null
    return { from: r.agent?.name || r.from || 'Teammate', text: String(r.prose ?? r.text ?? '').slice(0, INPUT_MAX), taskId: r.task?.id || r.taskId || null }
  }

  function buildPrompt(agent, { task, inputs = [], kind = 'text', schema = '' }) {
    const people = humans().map((h) => h.name).filter(Boolean)
    const team = [...S.team.values()].filter((a) => a.id !== agent.id).map((a) => a.name).slice(0, 8)
    const textRules = [
      'Write for the team: concise, concrete, under about 170 words unless you are writing the final answer.',
      'When you establish something the team should share, put it on its own line starting with "FACT:", "QUESTION:" or "DECISION:" so it lands on the shared blackboard.',
      'Respect every constraint the humans pinned. The humans have the final say.',
      'You have no tools and no web access. Never claim to have searched, browsed or run anything.',
    ]
    const system = [
      ROLES[agent.role]?.system || ROLES.worker.system,
      agent.focus ? `Your focus: ${agent.focus}.` : '',
      `You are one agent in a HiveMind ${PATTERNS[S.pattern]?.name || 'multi-agent'} team${team.length ? ` with ${team.join(', ')}` : ''}, working in a shared room with ${people.length ? `the humans ${people.join(', ')}` : 'the humans who asked'}. Everyone can see your output live.`,
      kind === 'text' || kind === 'debate_turn' ? textRules.join(' ') : `Reply with only one JSON object and nothing else. ${schema}`,
    ].filter(Boolean).join('\n')

    const ds = currentDirectives()
    for (const d of ds) S.seenDirectiveIds.add(d.id)
    const directiveLines = ds.map((d) => {
      const forYou = mentionsAgent(d.content, agent)
      const flagged = d.flagged ? ` ${DATA_LABEL}` : ''
      return `- ${d.author?.name || 'A human'}${forYou ? ' (to you)' : ''}: ${String(d.content).slice(0, 300)}${flagged}`
    })
    const hist = (history || []).slice(-HISTORY_MAX).map((h) => `- ${h.author?.name || h.role || 'Someone'}: ${String(h.content || '').slice(0, 280)}`)
    const ins = inputs.map(toInput).filter(Boolean)

    // The user turn is capped at USER_MAX and the task must survive the cap.
    // Space goes first to the task, the board and the humans' mid-run messages,
    // then the goal (up to GOAL_KEEP), the teammates' inputs, the rest of a long
    // goal, and the history last. Each section costs its length plus a separator.
    let room = USER_MAX
    const take = (text, max = room) => {
      const out = text ? cut(text, Math.min(max, room)) : ''
      if (out) room -= out.length + 2
      return out
    }
    const taskText = take(`Your task: ${task}`)
    const boardText = take(`Shared blackboard:\n${renderBoard(S.board)}`)
    const directiveText = take(directiveLines.length ? `Messages from the humans during this run:\n${directiveLines.join('\n')}` : '')
    const goalLine = `Goal from the humans: ${goal}${goalFlagged ? ` ${DATA_LABEL}` : ''}`
    let goalText = take(goalLine, GOAL_KEEP)
    let inputText = ''
    if (ins.length) {
      // Short inputs keep their full text; the long ones share what is left.
      const labels = ins.map((i) => `[${i.from}]\n`)
      let left = room - 32 - labels.reduce((n, l) => n + l.length + 2, 0)
      const sizes = []
      ins.map((_, k) => k).sort((a, b) => ins[a].text.length - ins[b].text.length).forEach((k, n) => {
        sizes[k] = Math.max(0, Math.min(ins[k].text.length, Math.floor(left / (ins.length - n))))
        left -= sizes[k]
      })
      inputText = take(`Inputs from your teammates:\n${ins.map((i, k) => labels[k] + cut(i.text, sizes[k])).join('\n\n')}`)
    }
    if (goalText !== goalLine) {
      if (goalText) room += goalText.length + 2
      goalText = take(goalLine)
    }
    const histText = take(hist.length ? `Recent conversation:\n${hist.join('\n')}` : '')

    const user = [goalText, boardText, histText, directiveText, inputText, taskText].filter(Boolean).join('\n\n')
    return [{ role: 'system', content: system }, { role: 'user', content: user }]
  }

  // ------------------------------------------------------------------ monitor
  // A call counts against the budget from the moment it passes here (reserved),
  // not when it finishes, so branches that start together can't all slip in
  // under the same count. At the budget the Monitor escalates once, and every
  // branch that reaches it meanwhile waits for the humans' decision instead of
  // deciding for them. `reserve = false` only asks (the swarm's look-ahead).
  async function beforeCall(final, reserve = true) {
    if (signal.aborted) throw abortError()
    if (final) {
      if (S.calls + S.reserved >= HARD_CALL_CAP) throw new WrapUp()
    } else {
      // Checked again after every wait, with no await before the reservation.
      while (S.budgetDecision || S.calls + S.reserved >= S.budget - 1) {
        if (S.budgetDecision) { await S.budgetDecision; continue }
        if (S.budgetEscalated) throw new WrapUp()
        S.budgetEscalated = true
        S.budgetDecision = escalate('budget', `The team has used ${S.calls + S.reserved} of its ${S.budget} model calls.`, 'wrap_up')
          .then((decision) => {
            if (decision === 'continue' && S.budget + 4 <= HARD_CALL_CAP) { S.budget += 4; monitorEmit() }
          })
          .finally(() => { S.budgetDecision = null })
      }
      if (!S.flags.includes('budget_80') && S.calls >= Math.ceil(S.budget * 0.8)) {
        S.flags.push('budget_80')
        monitorEmit()
      }
    }
    if (reserve) S.reserved++
  }

  // Only what agents say is checked for repeats: a Moderator naming the same
  // speaker for the same reason twice is doing its job.
  function afterCall(agent, text, kind) {
    if (kind === 'text' || kind === 'debate_turn') {
      const w = words(text)
      const prev = S.lastByAgent.get(agent.id)
      if (prev && w.size > 8 && jaccard(prev, w) > 0.9) {
        S.loopCount++
        S.flags.push(`loop:${agent.id}`)
        note('monitor', `Monitor: ${agent.name} repeated itself almost word for word.${loopConsequence()}`)
      }
      S.lastByAgent.set(agent.id, w)
    }
    monitorEmit()
  }

  // What a repeat costs, in the words of the strategy that is running (the
  // UI says the same: format.js explainFlag).
  function loopConsequence() {
    if (S.pattern !== 'swarm') return ''
    const t = S.config.turnTaking
    const cost = t === 'self_select' ? ' It moves to the back of the queue when it opts in.' : t === 'auction' ? ' Its bids are penalized.' : ''
    return `${cost} A second repeat makes the Monitor ask the room.`
  }

  async function escalate(kind, reason, defaultDecision) {
    const id = ids('esc')
    const waitMs = humans().length ? ESCALATION_WAIT_MS : 0
    note('escalation', `Monitor: ${reason} Waiting for a human to choose: continue or wrap up.`, { escalationId: id })
    emit({ type: 'swarm_escalation', runId, escalationId: id, kind, reason, options: ['continue', 'wrap_up'], defaultDecision, deadline: now() + waitMs })
    const decision = await new Promise((resolve) => {
      let timer = null
      const finish = (d, by) => {
        if (!S.escalations.has(id)) return
        S.escalations.delete(id)
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (d === '__abort') return resolve(d)
        emit({ type: 'swarm_escalation_resolved', runId, escalationId: id, decision: d, by: by || null })
        note('escalation', `${by ? by.name : 'No one answered in time, so the Monitor'} chose to ${d === 'continue' ? 'let the team continue' : 'wrap up'}.`, { escalationId: id, decision: d })
        resolve(d)
      }
      const onAbort = () => finish('__abort')
      S.escalations.set(id, finish)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish(defaultDecision, null), waitMs)
    })
    if (decision === '__abort') throw abortError()
    return decision
  }

  // ------------------------------------------------------------------ model call
  async function callModel(agent, kind, messages, { maxTokens, onDelta, resetStream, signal: callSignal, scriptedCtx }) {
    const ctx = { goal, width: S.config.width, ...scriptedCtx }
    if (provider === 'simulated' || typeof llm.call !== 'function') {
      return { text: await scriptedCall({ agent, kind, ctx, signal: callSignal, onDelta, pace }), scripted: true }
    }
    try {
      const text = await llm.call({ messages, maxTokens, signal: callSignal, onDelta, agent, kind })
      if (!String(text || '').trim()) throw new Error('empty response')
      return { text, scripted: false }
    } catch (err) {
      if (isAbort(err, callSignal)) throw err
      noticeOnce(`fallback:${agent.id}`, `${profile.label} didn't answer for the ${agent.name} (${String(err?.message || err).slice(0, 60)}). The scripted stand-in covered that step.`)
      resetStream?.()
      return { text: await scriptedCall({ agent, kind, ctx: { ...ctx, fallback: true }, signal: callSignal, onDelta, pace }), scripted: true }
    }
  }

  // The single primitive every pattern uses.
  async function runAgent(agent, { nodeId = null, task, inputs = [], kind = 'text', schema = '', maxTokens = 450, final = false, scriptedCtx = {}, signal: localSignal = null }) {
    register(agent)
    await beforeCall(final)
    const callSignal = localSignal ? anySignal([signal, localSignal]) : signal
    const refs = inputs.map(toInput).filter(Boolean).map((i) => i.taskId)
    const taskRec = newTask({ id: ids('task'), contextId, agentId: agent.id, title: task })
    nodeStatus(nodeId, 'running')
    emit({ type: 'swarm_agent_start', runId, agentId: agent.id, nodeId, taskId: taskRec.id, task: asString(task, 160), kind })

    const streams = kind === 'text' || kind === 'debate_turn'
    let pending = ''
    let timer = null
    let tokenSeq = 0 // per step, so a view can drop a token frame it already applied
    const flush = () => {
      if (!pending) return
      emit({ type: 'swarm_token', runId, agentId: agent.id, delta: pending, seq: ++tokenSeq })
      pending = ''
    }
    const onDelta = streams ? (d) => {
      pending += d
      if (!timer) timer = setTimeout(() => { timer = null; flush() }, flushMs)
    } : undefined
    const resetStream = () => {
      if (timer) { clearTimeout(timer); timer = null }
      pending = ''
      if (streams) emit({ type: 'swarm_token', runId, agentId: agent.id, delta: '', reset: true, seq: ++tokenSeq })
    }

    let result
    try {
      result = await sem(() => {
        if (callSignal.aborted) throw abortError()
        return callModel(agent, kind, buildPrompt(agent, { task, inputs, kind, schema }), { maxTokens, onDelta, resetStream, signal: callSignal, scriptedCtx })
      })
    } catch (err) {
      S.reserved--
      if (timer) clearTimeout(timer)
      flush()
      const state = isAbort(err, callSignal) ? TASK_STATE.canceled : TASK_STATE.failed
      nodeStatus(nodeId, state === TASK_STATE.canceled ? 'canceled' : 'failed')
      emit({ type: 'swarm_agent_done', runId, agentId: agent.id, nodeId, state })
      throw err
    }
    S.reserved--
    S.calls++
    if (timer) clearTimeout(timer)
    flush()

    S.estTokens += Math.round((messages_len(agent, task, inputs) + String(result.text).length) / 4)
    afterCall(agent, result.text, kind)

    if (!streams) {
      emit({ type: 'swarm_agent_done', runId, agentId: agent.id, nodeId, state: TASK_STATE.completed })
      nodeStatus(nodeId, 'done')
      return { agent, text: result.text, json: extractJSON(result.text), scripted: result.scripted, task: taskRec }
    }

    const by = { ...agentAuthor(agent), kind: 'agent' }
    const tagged = applyTags(S.board, result.text, by, now())
    if (tagged.items.length) { S.board = tagged.board; emitBoard() }
    let prose = stripTags(result.text)
    if (!prose && tagged.items.length) prose = tagged.items.map((i) => `- ${i.kind === 'facts' ? 'Fact' : i.kind === 'questions' ? 'Question' : i.kind === 'decisions' ? 'Decision' : 'Plan'}: ${i.text}`).join('\n')
    const message = newMessage({ messageId: ids('msg'), task: taskRec, text: prose, referenceTaskIds: refs })
    const event = persist({
      type: 'agent_message',
      author: by,
      content: prose || '(no output)',
      meta: {
        runId, pattern: S.pattern, role: agent.role, nodeId, final: final || undefined,
        scripted: result.scripted || undefined,
        a2a: a2aMeta(taskRec, message, TASK_STATE.completed),
        control: Object.keys(tagged.control).length ? tagged.control : undefined,
      },
    })
    emit({ type: 'swarm_agent_done', runId, agentId: agent.id, nodeId, state: TASK_STATE.completed, eventId: event?.id || null })
    nodeStatus(nodeId, 'done')
    const out = { agent, nodeId, text: result.text, prose, control: tagged.control, items: tagged.items, task: taskRec, event, scripted: result.scripted }
    S.outputs.push(out)
    if (final) { S.board = setText(S.board, 'final', prose, now()); emitBoard() }
    return out
  }

  function messages_len(agent, task, inputs) {
    return 1200 + String(task || '').length + inputs.map(toInput).filter(Boolean).reduce((n, i) => n + i.text.length, 0)
  }

  function markFinal(out, why) {
    if (!out) return
    S.board = setText(S.board, 'final', out.prose, now())
    emitBoard()
    if (out.event?.id) emit({ type: 'swarm_final', runId, eventId: out.event.id })
    if (why) note('plan', why)
  }

  // Runs tasks with dependencies; deps may only point to earlier tasks, so the
  // graph is acyclic by construction. Independent tasks run concurrently.
  async function runDag(tasks, exec) {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const started = new Map()
    const start = (t) => {
      if (started.has(t.id)) return started.get(t.id)
      const p = (async () => {
        const deps = await Promise.all(t.dependsOn.map((d) => start(byId.get(d))))
        return exec(t, deps)
      })()
      started.set(t.id, p)
      return p
    }
    return allBranches(tasks.map(start))
  }

  // A plan id the model repeated gets a fresh one, never one already taken
  // (two "s2" tasks must not collapse into one in runDag).
  function uniqueId(id, known, prefix, i) {
    let out = id
    for (let k = i + 1; known.has(out); k++) out = `${prefix}${k}`
    return out
  }

  function cleanDeps(list, knownBefore) {
    return [...new Set(asArray(list, 5).map((d) => asString(String(d), 20)))].filter((d) => knownBefore.has(d))
  }

  const agentFor = (role) => register(makeAgent(SPECIALIST_SET.has(role) ? role : 'researcher'))

  // ================================================================ patterns
  async function architect() {
    const A = register(makeAgent('architect'))
    setGraph('flow', [{ id: 'architect', agentId: A.id, layer: 0, order: 0 }])
    const options = PATTERN_ORDER.filter((p) => p !== 'auto')
    const remaining = S.budget - 1
    const catalog = options.map((id) => {
      const p = PATTERNS[id]
      return `- ${id}: ${p.name} (${p.aka}). ${p.summary} Useful when: ${p.usefulWhen} About ${estimateCalls(id, clampConfig(id, provider, {}))} model calls.`
    }).join('\n')
    const r = await runAgent(A, {
      nodeId: 'architect', kind: 'architect', maxTokens: 220,
      task: `Choose how the agent team should be organized for this goal.\n\nArchitectures:\n${catalog}\n\nConstraints: the brain is ${profile.label} (about ${profile.secondsPerCall} s per model call, ${profile.concurrency} call(s) at a time) and the team has ${remaining} model calls left. Prefer the cheapest architecture that fits the shape of the work.`,
      schema: `Schema: {"pattern": one of ${JSON.stringify(options)}, "reason": "one sentence"}`,
    })
    let pattern = options.includes(r.json?.pattern) ? r.json.pattern : null
    let reason = asString(r.json?.reason, 240)
    if (!pattern) { const h = chooseArchitectureHeuristic(goal); pattern = h.pattern; reason = h.reason }
    const cfg = clampConfig(pattern, provider, {})
    if (estimateCalls(pattern, cfg) > remaining) {
      const fallback = estimateCalls('sequential', cfg) <= remaining ? 'sequential' : 'router'
      reason = `${reason} It would need more model calls than the budget allows, so the Architect scaled down to ${PATTERNS[fallback].name}.`
      pattern = fallback
    }
    S.pattern = pattern
    S.config = { ...clampConfig(pattern, provider, {}), maxCalls: S.budget }
    emit({ type: 'swarm_architect', runId, pattern, reason, turnTaking: S.config.turnTaking })
    note('architect', `Architect chose ${PATTERNS[pattern].name} (${PATTERNS[pattern].aka}): ${reason}`, { pattern })
    return pattern
  }

  async function sequential() {
    const [R, A, W, C] = ['researcher', 'analyst', 'writer', 'critic'].map((r) => register(makeAgent(r)))
    setGraph('flow',
      [{ id: 'r', agentId: R.id, layer: 0 }, { id: 'a', agentId: A.id, layer: 1 }, { id: 'w', agentId: W.id, layer: 2 }, { id: 'c', agentId: C.id, layer: 3 }],
      [{ from: 'r', to: 'a' }, { from: 'a', to: 'w' }, { from: 'w', to: 'c' }, { from: 'c', to: 'w', conditional: true }])
    const r = await runAgent(R, { nodeId: 'r', task: 'Gather the facts the team needs for this goal. Flag anything uncertain.' })
    flow('r', 'a')
    const a = await runAgent(A, { nodeId: 'a', task: 'Analyze the researcher’s facts and commit to the key decisions.', inputs: [r] })
    flow('a', 'w')
    let w = await runAgent(W, { nodeId: 'w', task: 'Write the deliverable the humans asked for, built on the analyst’s decisions.', inputs: [a, r], maxTokens: 650 })
    S.board = setText(S.board, 'draft', w.prose, now())
    emitBoard()
    flow('w', 'c')
    const c = await runAgent(C, { nodeId: 'c', task: 'Review the draft against the goal, the facts and the humans’ constraints.', inputs: [w], scriptedCtx: { allowRevise: true, reviewedBefore: false } })
    if (/REVISE/i.test(c.control?.verdict || '')) {
      flow('c', 'w')
      w = await runAgent(W, { nodeId: 'w', task: 'Revise the draft to fix every issue the Critic raised. Output the complete final answer.', inputs: [w, c], final: true, maxTokens: 700 })
    } else {
      markFinal(w, 'The Critic approved the Writer’s draft as the final answer.')
    }
  }

  async function router() {
    const R = register(makeAgent('router'))
    const specs = SPECIALISTS.map((r) => register(makeAgent(r)))
    setGraph('flow', [{ id: 'router', agentId: R.id, layer: 0 }, ...specs.map((s, i) => ({ id: s.id, agentId: s.id, layer: 1, order: i }))], specs.map((s) => ({ from: 'router', to: s.id, conditional: true })))
    const cards = specs.map((s) => `- ${s.id}: ${s.description}`).join('\n')
    const r = await runAgent(R, {
      nodeId: 'router', kind: 'route', maxTokens: 160,
      task: `Read the request and pick exactly one specialist to answer it.\n\nSpecialists (from their agent cards):\n${cards}`,
      schema: `Schema: {"agent": one of ${JSON.stringify(SPECIALISTS)}, "reason": "one sentence"}`,
    })
    let choice = SPECIALIST_SET.has(r.json?.agent) ? r.json.agent : null
    let reason = asString(r.json?.reason, 200)
    if (!choice) { choice = routeHeuristic(goal); reason = reason || 'Chosen by keyword routing because the plan could not be read.' }
    for (const s of specs) if (s.id !== choice) nodeStatus(s.id, 'skipped')
    note('plan', `Router handed the request to the ${ROLES[choice].name}: ${reason}`)
    flow('router', choice)
    await runAgent(specs.find((s) => s.id === choice), { nodeId: choice, task: 'You are the only specialist on this request. Answer it fully for the humans.', final: true, maxTokens: 700 })
  }

  async function orchestrator() {
    const O = register(makeAgent('orchestrator'))
    setGraph('flow', [{ id: 'plan', agentId: O.id, layer: 0, label: 'Orchestrator · plan' }])
    const max = Math.min(4, S.config.width + 1)
    const p = await runAgent(O, {
      nodeId: 'plan', kind: 'orchestrator_plan', maxTokens: 400,
      task: `Decompose the goal into 2 to ${max} subtasks and assign each to one specialist (${SPECIALISTS.join(', ')}). A subtask may depend on earlier subtasks.`,
      schema: 'Schema: {"subtasks": [{"id": "s1", "title": "short task", "agent": "researcher", "dependsOn": []}]}',
    })
    let raw = asArray(p.json?.subtasks, max)
    if (!raw.length) raw = scriptedJSON('orchestrator_plan', { goal, topic: topicOf(goal), width: S.config.width }).subtasks.slice(0, max)
    const known = new Set()
    const subtasks = raw.map((t, i) => {
      const id = asString(t?.id, 20) || `s${i + 1}`
      const item = { id: uniqueId(id, known, 's', i), title: asString(t?.title, 140) || `Subtask ${i + 1}`, agent: SPECIALIST_SET.has(t?.agent) ? t.agent : 'researcher', dependsOn: cleanDeps(t?.dependsOn, known) }
      known.add(item.id)
      return item
    })
    for (const t of subtasks) { S.board = addItem(S.board, 'plan', `${t.title} (${ROLES[t.agent].name})`, { ...agentAuthor(O), kind: 'agent' }, now()) }
    emitBoard()
    note('plan', `Orchestrator's plan: ${subtasks.map((t, i) => `${i + 1}) ${t.title} → ${ROLES[t.agent].name}`).join('; ')}`)
    const depth = layersOf(subtasks)
    const finalLayer = Math.max(1, ...Object.values(depth)) + 1
    addToGraph(
      [...subtasks.map((t, i) => ({ id: t.id, agentId: agentFor(t.agent).id, label: t.title, layer: depth[t.id], order: i })), { id: 'final', agentId: O.id, label: 'Orchestrator · combine', layer: finalLayer }],
      [...subtasks.filter((t) => !t.dependsOn.length).map((t) => ({ from: 'plan', to: t.id })), ...subtasks.flatMap((t) => t.dependsOn.map((d) => ({ from: d, to: t.id }))), ...sinks(subtasks).map((id) => ({ from: id, to: 'final' }))])
    const results = await runDag(subtasks, async (t, deps) => {
      flow(t.dependsOn[0] || 'plan', t.id)
      return runAgent(agentFor(t.agent), { nodeId: t.id, task: t.title, inputs: deps })
    })
    for (const id of sinks(subtasks)) flow(id, 'final')
    await runAgent(O, { nodeId: 'final', task: 'Combine the specialists’ results into one answer for the humans. Resolve conflicts explicitly.', inputs: results, final: true, maxTokens: 750 })
  }

  async function hierarchical() {
    const VP = register(makeAgent('vp'))
    setGraph('tree', [{ id: 'vp', agentId: VP.id, layer: 0, label: 'VP' }])
    const width = Math.max(1, Math.min(3, S.config.width))
    const plan = await runAgent(VP, {
      nodeId: 'vp', kind: 'vp_plan', maxTokens: 350,
      task: `Split the goal into ${width} independent workstreams, one per manager.`,
      schema: 'Schema: {"workstreams": [{"title": "short name", "brief": "one sentence"}]}',
    })
    let streams = asArray(plan.json?.workstreams, width).map((w, i) => ({ title: asString(w?.title, 50) || `Workstream ${i + 1}`, brief: asString(w?.brief, 200) }))
    if (!streams.length) streams = scriptedJSON('vp_plan', { goal, topic: topicOf(goal), width }).workstreams
    note('plan', `VP's workstreams: ${streams.map((s) => s.title).join('; ')}`)
    const managers = streams.map((s, i) => register(makeAgent('manager', { id: `manager-${i + 1}`, label: `Manager · ${s.title}`, focus: s.title })))
    addToGraph(managers.map((m, i) => ({ id: m.id, agentId: m.id, layer: 1, order: i })), managers.map((m) => ({ from: 'vp', to: m.id })))

    const summaries = await allBranches(streams.map(async (ws, i) => {
      const M = managers[i]
      flow('vp', M.id)
      const mp = await runAgent(M, {
        nodeId: M.id, kind: 'manager_plan', maxTokens: 300, scriptedCtx: { workstream: ws.title },
        task: `Plan your workstream "${ws.title}" (${ws.brief}) as ${width} small worker tasks.`,
        schema: 'Schema: {"tasks": [{"title": "short task"}]}',
      })
      let tasks = asArray(mp.json?.tasks, width).map((t, j) => asString(t?.title, 120) || `Task ${j + 1}`)
      if (!tasks.length) tasks = scriptedJSON('manager_plan', { goal, topic: topicOf(goal), width, workstream: ws.title }).tasks.map((t) => t.title)
      const workers = tasks.map((title, j) => register(makeAgent('worker', { id: `worker-${i + 1}-${j + 1}`, label: `Worker · ${title.split(' ').slice(0, 4).join(' ')}`, focus: title })))
      addToGraph(workers.map((w, j) => ({ id: w.id, agentId: w.id, label: tasks[j], layer: 2, order: i * width + j })), workers.map((w) => ({ from: M.id, to: w.id })))
      const outs = await allBranches(workers.map((w, j) => {
        flow(M.id, w.id)
        return runAgent(w, { nodeId: w.id, task: tasks[j], scriptedCtx: { task: tasks[j] } })
      }))
      for (const w of workers) flow(w.id, M.id)
      return runAgent(M, { nodeId: M.id, task: `Summarize your workers’ results on "${ws.title}" for the VP. Keep the decisions.`, inputs: outs, scriptedCtx: { workstream: ws.title } })
    }))
    for (const m of managers) flow(m.id, 'vp')
    await runAgent(VP, { nodeId: 'vp', task: 'Review the managers’ reports and write the final answer for the humans.', inputs: summaries, final: true, maxTokens: 750 })
  }

  async function parallel() {
    const P = register(makeAgent('planner'))
    setGraph('flow', [{ id: 'plan', agentId: P.id, layer: 0, label: 'Planner' }])
    const max = Math.min(5, S.config.width + 2)
    const p = await runAgent(P, {
      nodeId: 'plan', kind: 'dag_plan', maxTokens: 450,
      task: `Turn the goal into 3 to ${max} tasks with explicit dependencies, so independent tasks can run in parallel. Assign each to one of: ${SPECIALISTS.join(', ')}. A task may only depend on tasks listed before it.`,
      schema: 'Schema: {"nodes": [{"id": "n1", "title": "short task", "agent": "researcher", "dependsOn": []}]}',
    })
    let raw = asArray(p.json?.nodes, max)
    if (raw.length < 2) raw = scriptedJSON('dag_plan', { goal, topic: topicOf(goal), width: S.config.width }).nodes.slice(0, max)
    const known = new Set()
    const tasks = raw.map((t, i) => {
      const id = asString(t?.id, 20) || `n${i + 1}`
      const item = { id: uniqueId(id, known, 'n', i), title: asString(t?.title, 140) || `Task ${i + 1}`, agent: SPECIALIST_SET.has(t?.agent) ? t.agent : 'researcher', dependsOn: cleanDeps(t?.dependsOn, known) }
      known.add(item.id)
      return item
    })
    for (const t of tasks) S.board = addItem(S.board, 'plan', `${t.title} (${ROLES[t.agent].name})`, { ...agentAuthor(P), kind: 'agent' }, now())
    emitBoard()
    const depth = layersOf(tasks)
    const SY = register(makeAgent('synthesizer'))
    const synthLayer = Math.max(1, ...Object.values(depth)) + 1
    addToGraph(
      [...tasks.map((t, i) => ({ id: t.id, agentId: agentFor(t.agent).id, label: t.title, layer: depth[t.id], order: i })), { id: 'synth', agentId: SY.id, layer: synthLayer }],
      [...tasks.filter((t) => !t.dependsOn.length).map((t) => ({ from: 'plan', to: t.id })), ...tasks.flatMap((t) => t.dependsOn.map((d) => ({ from: d, to: t.id }))), ...sinks(tasks).map((id) => ({ from: id, to: 'synth' }))])
    note('plan', `Planner's task graph: ${tasks.map((t) => `${t.id} ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`).join('; ')}`)
    const results = await runDag(tasks, async (t, deps) => {
      for (const d of t.dependsOn) flow(d, t.id)
      if (!t.dependsOn.length) flow('plan', t.id)
      return runAgent(agentFor(t.agent), { nodeId: t.id, task: t.title, inputs: deps })
    })
    for (const id of sinks(tasks)) flow(id, 'synth')
    await runAgent(SY, { nodeId: 'synth', task: 'Join every task’s result into one answer for the humans.', inputs: results, final: true, maxTokens: 750 })
  }

  async function fanout() {
    const SP = register(makeAgent('splitter'))
    const CB = register(makeAgent('combiner'))
    setGraph('flow', [{ id: 'split', agentId: SP.id, layer: 0 }])
    const n = Math.max(2, Math.min(4, S.config.width))
    const s = await runAgent(SP, {
      nodeId: 'split', kind: 'split', maxTokens: 350,
      task: `Fan the goal out into ${n} distinct angles, each explored by a different persona.`,
      schema: 'Schema: {"angles": [{"title": "the angle", "persona": "who explores it"}]}',
    })
    let angles = asArray(s.json?.angles, n).map((a, i) => ({ title: asString(a?.title, 120) || `Angle ${i + 1}`, persona: asString(a?.persona, 40) || `Perspective ${i + 1}` }))
    if (angles.length < 2) angles = scriptedJSON('split', { goal, topic: topicOf(goal), width: n }).angles
    const workers = angles.map((a, i) => register(makeAgent('worker', { id: `persona-${i + 1}`, label: a.persona, focus: a.title })))
    addToGraph(
      [...workers.map((w, i) => ({ id: w.id, agentId: w.id, label: angles[i].persona, layer: 1, order: i })), { id: 'combine', agentId: CB.id, layer: 2 }],
      [...workers.map((w) => ({ from: 'split', to: w.id })), ...workers.map((w) => ({ from: w.id, to: 'combine' }))])
    note('plan', `Fan-out: ${angles.map((a) => `${a.persona} on "${a.title}"`).join('; ')}`)

    // Fan-in deadline (lecture: timeouts allow partial results). Once the window
    // closes, unfinished personas are cut off as long as at least one finished.
    const controllers = workers.map(() => new AbortController())
    let finished = 0
    let windowClosed = false
    const cutoff = () => controllers.forEach((c, i) => { if (!done[i]) c.abort() })
    const done = workers.map(() => false)
    const timer = setTimeout(() => { windowClosed = true; if (finished > 0) cutoff() }, S.config.fanInMs)
    const settled = await Promise.allSettled(workers.map((w, i) => {
      flow('split', w.id)
      return runAgent(w, { nodeId: w.id, task: `Explore this angle as the ${angles[i].persona}: ${angles[i].title}`, signal: controllers[i].signal, scriptedCtx: { task: angles[i].title } })
        .then((r) => { done[i] = true; finished++; flow(w.id, 'combine'); if (windowClosed) cutoff(); return r })
    }))
    clearTimeout(timer)
    if (signal.aborted) throw abortError()
    const wrap = settled.find((x) => x.status === 'rejected' && x.reason?.name === 'WrapUp')
    const results = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value)
    const missing = workers.filter((_, i) => settled[i].status !== 'fulfilled')
    for (const m of missing) nodeStatus(m.id, 'skipped')
    if (missing.length && results.length) note('monitor', `${wrap ? 'Budget reached' : 'Fan-in deadline'}: combining ${results.length} of ${workers.length} perspectives. Missing: ${missing.map((m) => m.name).join(', ')}.`)
    if (!results.length) throw wrap?.reason || new WrapUp()
    await runAgent(CB, { nodeId: 'combine', task: `Merge the perspectives into one answer with tradeoffs.${missing.length ? ` These perspectives did not report ${wrap ? 'before the budget ran out' : 'in time'}: ${missing.map((m) => m.name).join(', ')}. Say so.` : ''}`, inputs: results, final: true, maxTokens: 750 })
  }

  // ================================================================ turn-taking
  // Debate and swarm follow S.config.turnTaking (patterns.js TURN_TAKING). Each
  // turn emits one decision (swarm_bids, the name older views know): who got
  // the floor, by which rule (bids, order, moderator, handoff, self) and why.
  const SELF_MAX = 2   // self-selection: at most this many speakers per turn
  const SELF_LIMIT = 3 // ... and this many turns per agent, unless a human calls on it
  let turnSeq = 0

  function strategyFor(pattern) {
    const allowed = turnTakingFor(pattern)
    return allowed.includes(S.config.turnTaking) ? S.config.turnTaking : allowed[0]
  }

  function emitTurn({ strategy, speakers, by, reason, bids = [], optIns = null, debateRound = null }) {
    emit({
      type: 'swarm_bids', runId, round: ++turnSeq, strategy, bids,
      speakers: speakers.map((a) => a.id), by, reason: asString(reason, 300),
      ...(optIns ? { optIns } : {}), ...(debateRound ? { debateRound } : {}),
    })
  }

  const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five']
  const countWord = (n) => COUNT_WORDS[n] || String(n)
  const nameList = (agents) => {
    const names = agents.map((a) => a.name)
    return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
  const keysOf = (a) => [a.role, a.id.toLowerCase(), a.name.toLowerCase()]
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namedAt = (text, a) => {
    let at = -1
    for (const key of keysOf(a)) {
      const m = new RegExp(`(^|[^a-z])${escapeRe(key)}(?![a-z])`).exec(text)
      if (m && (at < 0 || m.index < at)) at = m.index
    }
    return at
  }
  // "NEXT: the Skeptic", "@critic", "Critic." -> the first agent it names, or null.
  function namedAgent(text, agents) {
    const t = String(text || '').toLowerCase()
    let best = null
    let bestAt = Infinity
    for (const a of agents) {
      const at = namedAt(t, a)
      if (at >= 0 && at < bestAt) { best = a; bestAt = at }
    }
    return best
  }
  const info = (a) => ({ id: a.id, role: a.role, name: a.name })
  // Handoff: the NEXT control line, or else a last line that starts with
  // "Next:" in any case (a model that writes "Next: critic" still named
  // someone; that line stays in the prose, since it may be an ordinary step).
  function nextLineOf(out) {
    if (out?.control?.next) return String(out.control.next)
    const lines = String(out?.text || '').split('\n').map((l) => l.trim()).filter(Boolean)
    const m = /^[-*\s]*\**\s*next\s*\**\s*[:：]\s*(.{1,80})$/i.exec(lines[lines.length - 1] || '')
    return m ? m[1].replace(/\*+/g, '').trim() : ''
  }

  // One Moderator call. Its pick must be one of the candidates; the caller
  // falls back to its default rule otherwise.
  async function moderate(M, { candidates, task, moderation, inputs }) {
    const r = await runAgent(M, {
      nodeId: 'moderator', kind: 'moderate', maxTokens: 160, inputs, task,
      schema: `Schema: {"speaker": one of ${JSON.stringify(candidates.map((a) => a.id))}, "reason": "one sentence"}`,
      scriptedCtx: { moderation },
    })
    const raw = typeof r.json?.speaker === 'string' ? r.json.speaker : ''
    const pick = candidates.find((a) => a.id === raw) || (raw ? namedAgent(raw, candidates) : null)
    return { pick, reason: asString(r.json?.reason, 240), raw: asString(raw, 40) }
  }

  async function debate() {
    const peers = ['builder', 'skeptic', 'pragmatist'].map((r) => register(makeAgent(r)))
    const strategy = strategyFor('debate')
    const M = strategy === 'moderator' ? register(makeAgent('moderator')) : null
    // The Moderator sits in the middle of the ring it runs.
    setGraph('ring',
      [...peers.map((p, i) => ({ id: p.id, agentId: p.id, layer: 0, order: i })), ...(M ? [{ id: 'moderator', agentId: M.id, layer: 1 }] : [])],
      peers.map((p, i) => ({ from: p.id, to: peers[(i + 1) % peers.length].id })))
    const rounds = Math.max(1, Math.min(3, S.config.rounds))
    const turns = []
    // How often the others challenged (named) a peer since it last spoke, and
    // at which turn: the bids weigh it, the Moderator sees who was challenged.
    const pressure = new Map(peers.map((p) => [p.id, { count: 0, at: -1 }]))
    let prev = null
    let nextPick = null // handoff: the NEXT line of the peer that just spoke
    for (let round = 1; round <= rounds; round++) {
      const left = [...peers]
      while (left.length) {
        // At the budget the Monitor asks the room before anyone gets the floor
        // (as in the swarm), so no turn is announced for a peer who never speaks.
        if (S.calls + S.reserved >= S.budget - 1) await beforeCall(false, false)
        const last = round === rounds
        const ds = currentDirectives()
        const pick = await debateTurn({ strategy, M, peers, round, rounds, left, prev, nextPick, turns, pressure, ds })
        const peer = pick.peer
        left.splice(left.indexOf(peer), 1)
        emitTurn({ strategy, speakers: [peer], by: pick.by, reason: pick.reason, bids: pick.bids || [], debateRound: round })
        for (const d of ds) if (mentionsAgent(d.content, peer)) S.consumedMentions.add(`${d.id}:${peer.id}`)
        if (pick.by === 'moderator') flow('moderator', peer.id)
        if (prev) flow(prev.id, peer.id)
        // Handoff: the speaker names who goes next whenever there is a choice.
        const options = strategy !== 'handoff' ? [] : left.length > 1 ? left : !left.length && round < rounds ? peers.filter((p) => p !== peer) : []
        const handLine = options.length ? ` End with one line "NEXT: <name>" naming the peer who should speak next: ${options.map((p) => p.name).join(' or ')}. Never yourself.` : ''
        const t = await runAgent(peer, {
          nodeId: peer.id, kind: 'debate_turn', maxTokens: 380,
          task: (last
            ? 'Final round. State your final position in a few sentences, then end with two lines: "PROPOSAL: <your recommendation in one sentence>" and "VOTE: <the name of the other peer whose proposal you support, never yourself>".'
            : `Round ${round}. Make your case and respond directly to the other peers' points.`) + handLine,
          inputs: turns.slice(-3),
          scriptedCtx: { final: last, prevTurns: turns.length > 0, turn: turns.length, replyTo: prev?.name || null, handoff: options.length ? options.map(info) : null },
        })
        turns.push(t)
        const prose = String(t.prose || '').toLowerCase()
        for (const p of peers) {
          if (p === peer || namedAt(prose, p) < 0) continue
          const s = pressure.get(p.id)
          s.count++
          s.at = turns.length - 1
        }
        pressure.get(peer.id).count = 0
        nextPick = options.length ? nextLineOf(t) : null
        prev = peer
      }
    }
    const finals = turns.slice(-peers.length)
    const options = peers.map((p) => {
      const t = finals.find((x) => x.agent.id === p.id)
      const prop = asString(t?.control?.proposal, 200) || asString((t?.prose || '').split(/(?<=[.!?])\s/)[0], 200) || `${p.name}'s position`
      return { id: p.id, label: prop, by: p.name }
    })
    const agentVotes = finals.map((t) => {
      const v = String(t.control?.vote || '').toLowerCase()
      const target = peers.find((p) => p.id !== t.agent.id && v.includes(p.name.toLowerCase()))
      return target ? { voter: { id: t.agent.id, name: t.agent.name }, option: target.id, why: '' } : null
    }).filter(Boolean)
    const winner = await vote({ question: 'Which proposal should the team adopt?', options, agentVotes })
    const W = peers.find((p) => p.id === winner) || peers[2]
    flow(prev?.id, W.id)
    await runAgent(W, { nodeId: W.id, task: 'Your proposal won the vote. Write the final answer for the humans and fairly note the strongest objection that was raised.', inputs: turns.slice(-6), final: true, maxTokens: 700 })
  }

  // Who speaks next in a debate round. Every peer still speaks exactly once
  // per round; the strategy only orders the round.
  async function debateTurn({ strategy, M, peers, round, rounds, left, prev, nextPick, turns, pressure, ds }) {
    // The peer after the previous speaker on the ring, among those still to speak.
    const nextInOrder = () => {
      const i = prev ? peers.indexOf(prev) : -1
      for (let k = 1; k <= peers.length; k++) {
        const p = peers[(i + k) % peers.length]
        if (left.includes(p) && (p !== prev || left.length === 1)) return p
      }
      return left[0]
    }
    if (strategy === 'round_robin') return { peer: left[0], by: 'order', reason: `The ${left[0].name} is next in the fixed order.` }
    if (left.length === 1) return { peer: left[0], by: 'order', reason: `Only the ${left[0].name} has not spoken in round ${round} yet.` }
    const mentionOf = (p) => ds.find((d) => !S.consumedMentions.has(`${d.id}:${p.id}`) && mentionsAgent(d.content, p))

    if (strategy === 'auction') {
      const bids = left.map((p) => {
        const s = pressure.get(p.id)
        let score = 0.3
        const why = []
        if (s.count) { score += 0.35 * Math.min(3, s.count); why.push(`challenged ${s.count === 1 ? 'once' : `${s.count} times`} since it last spoke`) }
        const mention = mentionOf(p)
        if (mention) { score += 0.6; why.push(`${mention.author?.name || 'a human'} called on it`) }
        if (p === prev) { score -= 0.5; why.push('just spoke') }
        return { agentId: p.id, score: Math.round(Math.max(0, Math.min(2, score)) * 100) / 100, reason: why.join(', ') || 'nobody has challenged it yet', at: s.at }
      }).sort((x, y) => y.score - x.score || y.at - x.at || peers.findIndex((p) => p.id === x.agentId) - peers.findIndex((p) => p.id === y.agentId))
      // Ties go to the peer challenged most recently, then to seat order.
      const [first, second] = bids
      const tie = second && second.score === first.score ? (second.at !== first.at ? ' (a tie: it was challenged most recently)' : ' (a tie, so seat order decides)') : ''
      const top = peers.find((p) => p.id === first.agentId)
      return { peer: top, by: 'bids', bids: bids.map(({ at, ...b }) => b), reason: `The ${top.name} bid highest: ${first.reason}${tie}.` } // eslint-disable-line no-unused-vars
    }

    if (strategy === 'handoff') {
      if (!prev) return { peer: left[0], by: 'order', reason: `The ${left[0].name} opens the debate.` }
      const named = nextPick ? namedAgent(nextPick, peers) : null
      if (named && named !== prev && left.includes(named)) return { peer: named, by: 'handoff', reason: `The ${prev.name} handed the floor to the ${named.name}.` }
      const fb = nextInOrder()
      const why = !nextPick ? `The ${prev.name} did not name anyone`
        : !named ? `The ${prev.name} named "${asString(nextPick, 30)}", who is not in this debate`
          : named === prev ? `The ${prev.name} named itself`
            : `The ${prev.name} named the ${named.name}, who already spoke this round`
      return { peer: fb, by: 'order', reason: `${why}, so the next peer in order, the ${fb.name}, speaks.` }
    }

    // Moderator. The last speaker never opens the next round while others wait.
    const candidates = prev && left.includes(prev) ? left.filter((p) => p !== prev) : left
    // Calls are short: every peer's turn comes before the Moderator's picks.
    const turnsLeft = (rounds - round) * peers.length + left.length
    if (S.budget - 1 - S.calls - S.reserved < turnsLeft + 1) {
      const fb = nextInOrder()
      return { peer: fb, by: 'order', reason: `Calls are short, so the Moderator stepped aside and the ${fb.name} speaks in order.` }
    }
    const lastTurn = turns[turns.length - 1]
    const lastProse = String(lastTurn?.prose || '').toLowerCase()
    const challenged = prev ? candidates.filter((p) => namedAt(lastProse, p) >= 0).sort((a, b) => namedAt(lastProse, a) - namedAt(lastProse, b))[0] : null
    const moderation = { pattern: 'debate', candidates: candidates.map(info), last: prev ? info(prev) : null, addressed: challenged?.role || null, mentioned: candidates.find(mentionOf)?.role || null }
    const task = `Round ${round} of ${rounds} of the debate. Choose which peer speaks next: ${candidates.map((p) => `${p.id} (${p.name}: ${ROLES[p.role].description})`).join('; ')}. Prefer the peer the debate needs most right now, for example one who was just challenged or whose view is missing.`
    const { pick, reason, raw } = await moderate(M, { candidates, task, moderation, inputs: turns.slice(-3) })
    if (pick) return { peer: pick, by: 'moderator', reason: reason || `The Moderator gave the floor to the ${pick.name}.` }
    const fb = nextInOrder()
    return { peer: fb, by: 'order', reason: `The Moderator's pick${raw ? ` ("${raw}")` : ''} could not be used, so the next peer in order, the ${fb.name}, speaks.` }
  }

  async function swarm() {
    const roster = ['researcher', 'interrogator', 'analyst', 'critic', 'synthesizer'].map((r) => register(makeAgent(r)))
    const strategy = strategyFor('swarm')
    const M = strategy === 'moderator' ? register(makeAgent('moderator')) : null
    setGraph('ring', [...roster.map((a, i) => ({ id: a.id, agentId: a.id, layer: 0, order: i })), ...(M ? [{ id: 'moderator', agentId: M.id, layer: 1 }] : [])], [])
    const byRole = Object.fromEntries(roster.map((a) => [a.role, a]))
    const byId = (id) => roster.find((a) => a.id === id)
    const counts = (b) => ({ facts: b.facts.length, questions: b.questions.length, decisions: b.decisions.length })
    const zero = { facts: 0, questions: 0, decisions: 0 }
    const spoke = new Map(roster.map((a) => [a.id, 0]))
    const seenAt = new Map(roster.map((a) => [a.id, zero]))  // the board when it last got the floor
    const afterAt = new Map(roster.map((a) => [a.id, zero])) // the board when its last turn ended
    let last = []        // the previous turn's speakers
    let draftSeq = 0
    let draftAt = zero   // the board the latest draft was written from
    let reviewedSeq = 0
    let reviseRequested = false
    let revisedOnce = false
    let turn = 0
    let rrNext = 0       // round robin: where the fixed order resumes
    let nextPick = null  // handoff: the NEXT line of the agent that just spoke
    const priority = ['critic', 'synthesizer', 'analyst', 'researcher', 'interrogator']
    const RR_ORDER = ['researcher', 'interrogator', 'analyst', 'synthesizer', 'critic']
    const latestDraft = () => [...S.outputs].reverse().find((o) => o.agent.role === 'synthesizer')

    while (true) {
      if (signal.aborted) throw abortError()
      // One call is held back for the answer. At the budget the Monitor asks the
      // humans first (beforeCall): continue buys 4 calls, anything else wraps up.
      if (S.budget - S.calls <= 1) await beforeCall(false, false)
      const remaining = S.budget - S.calls
      const b = S.board
      const cur = counts(b) // the board this turn's choice reads
      const ds = currentDirectives()
      const mentionOf = (a) => ds.find((d) => !S.consumedMentions.has(`${d.id}:${a.id}`) && mentionsAgent(d.content, a))
      const looped = (a) => S.flags.includes(`loop:${a.id}`)

      // Priority bids (the auction, and the fallback for a handoff or a
      // Moderator pick that cannot be used).
      const scoreBids = () => roster.map((a) => {
        let score = 0
        const why = []
        const seen = seenAt.get(a.id)
        switch (a.role) {
          case 'researcher':
            score = 0.35
            if (b.facts.length < 3) { score += 0.45; why.push('few facts on the board') }
            if (b.questions.length > seen.questions) { score += 0.15; why.push('new questions to answer') }
            break
          case 'interrogator':
            score = 0.25
            if (spoke.get(a.id) === 0 && b.facts.length >= 1 && b.questions.length < 3) { score += 0.62; why.push('nobody has probed for gaps yet') }
            if (spoke.get(a.id) >= 1) { score -= 0.3; why.push('already asked its questions') }
            break
          case 'analyst':
            score = 0.25
            if (b.facts.length >= 3 && b.decisions.length === 0) { score += 0.55; why.push('enough facts to decide') }
            if (b.facts.length > seen.facts && b.decisions.length > 0) { score += 0.1; why.push('new facts since its last decision') }
            break
          case 'synthesizer':
            score = 0.15
            if (b.decisions.length >= 1 && !draftSeq) { score += 0.7; why.push('decisions exist but no draft') }
            if (reviseRequested) { score += 0.75; why.push('the Critic asked for a revision') }
            if (remaining <= 3 && !draftSeq) { score += 1; why.push('budget is nearly spent') }
            break
          case 'critic':
            score = 0.1
            if (draftSeq > reviewedSeq) { score += 0.85; why.push('there is an unreviewed draft') }
            break
        }
        const mention = mentionOf(a)
        if (mention) { score += 0.6; why.push(`${mention.author?.name || 'a human'} called on it`) }
        if (last.includes(a)) { score -= 0.5; why.push('just spoke') }
        if (looped(a)) { score -= 0.4; why.push('repeated itself') }
        return { agentId: a.id, score: Math.round(Math.max(0, Math.min(2, score)) * 100) / 100, reason: why.join(', ') || 'nothing new to add' }
      }).sort((x, y) => y.score - x.score || priority.indexOf(byId(x.agentId).role) - priority.indexOf(byId(y.agentId).role))
      const byBids = (why) => {
        const bids = scoreBids()
        const top = byId(bids[0].agentId)
        const tie = bids[1] && bids[1].score === bids[0].score ? ' (a tie, so the fixed priority decides)' : ''
        return { speakers: [top], by: 'bids', bids, reason: why ? `${why}, so the highest bid speaks: the ${top.name}.` : `The ${top.name} bid highest: ${bids[0].reason}${tie}.` }
      }

      // What an agent has to work on right now (null: nothing). Round robin
      // skips an agent with no work, self-selection is opting in with it, and
      // the Moderator only chooses among agents that have some.
      const workOf = (a) => {
        const mention = mentionOf(a)
        if (mention) return `${mention.author?.name || 'a human'} called on it`
        const after = afterAt.get(a.id)
        const spoken = spoke.get(a.id) > 0
        const newFacts = cur.facts > after.facts
        switch (a.role) {
          case 'researcher':
            if (cur.facts < 3) return 'the board needs more facts'
            if (cur.questions > after.questions) return 'there are new questions it can answer'
            return null
          case 'interrogator':
            if (!cur.facts) return null
            if (!spoken) return 'nobody has probed the facts for gaps'
            return newFacts && cur.questions < 3 ? 'new facts to probe' : null
          case 'analyst':
            if (!cur.facts) return null
            if (!cur.decisions) return cur.facts >= 3 ? 'enough facts to decide' : 'facts to weigh'
            return spoken && newFacts ? 'new facts since its last decision' : null
          case 'synthesizer':
            if (reviseRequested) return 'the Critic asked for a revision'
            if (!draftSeq && cur.decisions) return 'decisions but no draft yet'
            if (!draftSeq && remaining <= 3) return 'the budget is nearly spent'
            return draftSeq && cur.decisions > draftAt.decisions ? 'new decisions since the last draft' : null
          case 'critic':
            return draftSeq > reviewedSeq ? 'there is an unreviewed draft' : null
          default:
            return null
        }
      }
      // Nobody has anything to add: the Synthesizer drafts if the board moved
      // since the last draft (and it may still speak); otherwise the latest
      // draft stands.
      const nobody = (by, why, { synthesizerMay = true } = {}) => {
        const moved = !draftSeq || cur.facts > draftAt.facts || cur.decisions > draftAt.decisions
        if (moved && (synthesizerMay || !draftSeq)) return { speakers: [byRole.synthesizer], by, reason: `${why}, so the Synthesizer drafts from the board.` }
        return { done: `${why}, so the latest draft stands as the answer.` }
      }

      let d
      if (strategy === 'round_robin') {
        const skipped = []
        for (let k = 0; k < RR_ORDER.length && !d; k++) {
          const a = byRole[RR_ORDER[(rrNext + k) % RR_ORDER.length]]
          if (!workOf(a)) { skipped.push(a); continue }
          rrNext = (rrNext + k + 1) % RR_ORDER.length
          d = { speakers: [a], by: 'order', reason: `The ${a.name} is next in the fixed order${skipped.length ? `, after skipping the ${nameList(skipped)} with nothing to work on` : ''}.` }
        }
        if (!d) d = nobody('order', 'Nobody in the fixed order had anything to work on')
      } else if (strategy === 'self_select') {
        // The lecture's self-selection needs tie-breaks and response limits:
        // a fixed priority, at most SELF_MAX at once, SELF_LIMIT turns each.
        const limited = []
        const optIns = []
        for (const a of roster) {
          const why = workOf(a)
          if (!why) continue
          if (spoke.get(a.id) >= SELF_LIMIT && !mentionOf(a)) { limited.push(a); continue }
          optIns.push({ a, why })
        }
        optIns.sort((x, y) => Number(looped(x.a)) - Number(looped(y.a)) || priority.indexOf(x.a.role) - priority.indexOf(y.a.role))
        const room = Math.max(1, Math.min(SELF_MAX, S.budget - S.calls - S.reserved - 1))
        const speakers = []
        for (const x of optIns) {
          if (speakers.length >= room) break
          // The Critic never reviews a draft the Synthesizer is rewriting that same turn.
          const clash = (r1, r2) => (r1 === 'critic' && r2 === 'synthesizer') || (r1 === 'synthesizer' && r2 === 'critic')
          if (speakers.some((s) => clash(s.role, x.a.role))) continue
          speakers.push(x.a)
        }
        const list = optIns.map((x) => ({ agentId: x.a.id, reason: x.why }))
        if (!speakers.length) {
          const why = limited.length ? `Nobody opted in (the ${nameList(limited)} reached the response limit)` : 'Nobody opted in'
          d = { ...nobody('self', why, { synthesizerMay: spoke.get(byRole.synthesizer.id) < SELF_LIMIT }), optIns: list }
        } else {
          const waiting = optIns.length - speakers.length
          const reason = optIns.length === 1
            ? `Only the ${speakers[0].name} opted in: ${optIns[0].why}.`
            : `${countWord(optIns.length)} agents opted in. ${speakers.length === 2 ? `The ${nameList(speakers)} have the highest priority and speak at once` : `The ${speakers[0].name} has the highest priority`}${waiting ? `; ${waiting === 1 ? 'one waits' : `${countWord(waiting).toLowerCase()} wait`} for the next turn` : ''}.`
          d = { speakers, by: 'self', reason, optIns: list }
        }
      } else if (strategy === 'moderator') {
        const candidates = roster.filter((a) => workOf(a))
        if (!candidates.length) d = nobody('moderator', 'Nobody had anything to work on')
        else if (candidates.length === 1) d = { speakers: candidates, by: 'moderator', reason: `Only the ${candidates[0].name} has anything to work on (${workOf(candidates[0])}), so the Moderator did not need to choose.` }
        // The Moderator's call would leave none for the speaker: the bids decide.
        else if (S.budget - S.calls - S.reserved <= 2) d = byBids('Calls are nearly spent, so the Moderator stepped aside')
        else {
          const moderation = {
            pattern: 'swarm', candidates: candidates.map(info), last: last[0] ? info(last[0]) : null,
            mentioned: candidates.find(mentionOf)?.role || null, board: cur, revise: reviseRequested,
            spoke: Object.fromEntries(roster.map((a) => [a.role, spoke.get(a.id)])),
          }
          const task = `Choose who speaks next in this swarm. The candidates, with what each has to work on:\n${candidates.map((a) => `- ${a.id} (${a.name}): ${workOf(a)}`).join('\n')}\nPick the one whose turn moves the team toward a checked answer fastest.`
          const { pick, reason, raw } = await moderate(M, { candidates, task, moderation, inputs: S.outputs.slice(-3) })
          d = pick
            ? { speakers: [pick], by: 'moderator', reason: reason || `The Moderator gave the floor to the ${pick.name}.` }
            : byBids(`The Moderator's pick${raw ? ` ("${raw}")` : ''} could not be used`)
        }
      } else if (strategy === 'handoff') {
        const prev = last[0]
        const named = prev && nextPick ? namedAgent(nextPick, roster) : null
        // A Critic with no draft to review would have nothing to say.
        const usable = named && named !== prev && !(named.role === 'critic' && draftSeq <= reviewedSeq)
        if (usable) d = { speakers: [named], by: 'handoff', reason: `The ${prev.name} handed the floor to the ${named.name}.` }
        else {
          const why = !prev ? 'Nobody has the floor yet'
            : !nextPick ? `The ${prev.name} did not name anyone`
              : !named ? `The ${prev.name} named "${asString(nextPick, 30)}", who is not on the team`
                : named === prev ? `The ${prev.name} named itself`
                  : `The ${prev.name} named the Critic, but there is no new draft to review`
          d = byBids(why)
        }
      } else {
        d = byBids()
      }

      if (d.done) {
        markFinal(latestDraft(), d.done)
        return
      }
      const speakers = d.speakers
      emitTurn({ strategy, speakers, by: d.by, reason: d.reason, bids: d.bids || [], optIns: d.optIns || null })
      for (const sp of speakers) {
        for (const x of ds) if (mentionsAgent(x.content, sp)) S.consumedMentions.add(`${x.id}:${sp.id}`)
        if (d.by === 'moderator' && M) flow('moderator', sp.id)
        if (last[0]) flow(last[0].id, sp.id)
        seenAt.set(sp.id, cur)
      }

      const taskByRole = {
        researcher: 'Add the facts the team is missing, and answer any open questions you can. Flag what needs checking.',
        interrogator: 'Ask the two or three questions whose answers would most change the result.',
        analyst: 'Weigh the facts on the board and commit to decisions.',
        synthesizer: reviseRequested ? 'Revise the team answer to fix what the Critic raised. Output the complete answer.' : 'Write the team’s answer for the humans from the blackboard.',
        critic: 'Review the latest draft against the goal, the facts and the humans’ constraints.',
      }
      const recent = S.outputs.slice(-3)
      const reviewed = S.outputs.filter((o) => o.agent.role === 'synthesizer').slice(-1)
      const revising = reviseRequested
      const runOne = (sp) => {
        const others = roster.filter((x) => x !== sp)
        const handLine = strategy === 'handoff' ? ` End with one line "NEXT: <role>" naming the teammate who should speak next, one of: ${others.map((x) => x.role).join(', ')}. Never yourself.` : ''
        return runAgent(sp, {
          nodeId: sp.id,
          task: taskByRole[sp.role] + handLine,
          inputs: sp.role === 'critic' ? reviewed : recent,
          maxTokens: sp.role === 'synthesizer' ? 700 : 420,
          scriptedCtx: {
            allowRevise: !revisedOnce, reviewedBefore: revisedOnce, turn, spokeBefore: spoke.get(sp.id) > 0,
            revising: sp.role === 'synthesizer' && revising, handoff: strategy === 'handoff' ? others.map(info) : null,
          },
        })
      }
      // Self-selected speakers run at once; every other strategy has one.
      const outs = speakers.length === 1 ? [await runOne(speakers[0])] : await allBranches(speakers.map(runOne))
      turn++
      last = speakers
      const after = counts(S.board)
      let approved = false
      speakers.forEach((sp, i) => {
        const out = outs[i]
        spoke.set(sp.id, spoke.get(sp.id) + 1)
        afterAt.set(sp.id, after)
        if (sp.role === 'synthesizer') {
          draftSeq++
          draftAt = cur
          reviseRequested = false
          S.board = setText(S.board, 'draft', out.prose, now())
          emitBoard()
        } else if (sp.role === 'critic') {
          reviewedSeq = draftSeq
          if (/APPROVE/i.test(out.control?.verdict || '')) approved = true
          else { reviseRequested = true; revisedOnce = true }
        }
        if (strategy === 'handoff') nextPick = nextLineOf(out)
      })
      if (approved) {
        markFinal(latestDraft(), 'The Critic approved the Synthesizer’s draft, so the swarm converged.')
        return
      }

      if (S.loopCount >= 2 && !S.loopEscalated) {
        S.loopEscalated = true
        const esc = await escalate('loop', 'The swarm is starting to repeat itself.', 'wrap_up')
        if (esc !== 'continue') throw new WrapUp()
      }
    }
  }

  function layersOf(tasks) {
    const depth = {}
    for (const t of tasks) depth[t.id] = 1 + Math.max(0, ...t.dependsOn.map((d) => depth[d] || 0))
    return depth
  }
  function sinks(tasks) {
    const used = new Set(tasks.flatMap((t) => t.dependsOn))
    return tasks.filter((t) => !used.has(t.id)).map((t) => t.id)
  }

  async function vote({ question, options, agentVotes }) {
    const id = ids('vote')
    const people = humans()
    const windowMs = people.length ? VOTE_WINDOW_MS : 0
    const v = { id, options, votes: new Map(), close: null, people }
    S.votes.set(id, v)
    emit({ type: 'swarm_vote_open', runId, voteId: id, question, options, deadline: now() + windowMs, humans: people.map((h) => ({ id: h.id, name: h.name })) })
    for (const av of agentVotes) {
      if (!options.some((o) => o.id === av.option)) continue
      v.votes.set(`agent:${av.voter.id}`, { voter: { ...av.voter, kind: 'agent' }, option: av.option })
      emit({ type: 'swarm_vote_cast', runId, voteId: id, voter: { ...av.voter, kind: 'agent' }, option: av.option })
    }
    await new Promise((resolve) => {
      let timer = null
      const finish = () => {
        if (!S.votes.has(id)) return
        S.votes.delete(id)
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      v.close = finish
      v.check = () => {
        const humanVotes = [...v.votes.values()].filter((x) => x.voter.kind === 'human').length
        if (people.length && humanVotes >= people.length) finish()
      }
      signal.addEventListener('abort', finish, { once: true })
      timer = setTimeout(finish, windowMs)
    })
    if (signal.aborted) throw abortError()
    const tally = Object.fromEntries(options.map((o) => [o.id, 0]))
    const humanTally = Object.fromEntries(options.map((o) => [o.id, 0]))
    for (const x of v.votes.values()) {
      tally[x.option] = (tally[x.option] || 0) + 1
      if (x.voter.kind === 'human') humanTally[x.option] = (humanTally[x.option] || 0) + 1
    }
    const ranked = [...options].sort((a, b) => tally[b.id] - tally[a.id] || humanTally[b.id] - humanTally[a.id] || options.indexOf(a) - options.indexOf(b))
    const top = ranked[0]
    const tied = ranked.filter((o) => tally[o.id] === tally[top.id]).length > 1
    // The humans only break a tie they did not split themselves.
    const humansAhead = ranked.filter((o) => o !== top && tally[o.id] === tally[top.id]).every((o) => humanTally[top.id] > humanTally[o.id])
    const tieBreak = tied ? (humansAhead ? 'human majority' : 'first proposal') : null
    const total = [...v.votes.values()].length
    emit({ type: 'swarm_vote_closed', runId, voteId: id, tally, winner: top.id, tieBreak })
    note('vote', `Vote closed: ${top.by}'s proposal won with ${tally[top.id]} of ${total} vote${total === 1 ? '' : 's'} (${humanTally[top.id]} from humans)${tieBreak ? `, tie broken by ${tieBreak}` : ''}. "${top.label}"`, { voteId: id, winner: top.id, tally })
    return top.id
  }

  async function wrapUpFinal() {
    if (S.board.final) return
    const SY = register(makeAgent('synthesizer'))
    // Node ids differ from agent ids in most patterns (sequential's 'w' is the Writer).
    addToGraph([{ id: 'wrap', agentId: SY.id, label: 'Synthesizer · wrap up', layer: Math.max(0, ...S.graph.nodes.map((n) => n.layer)) + 1 }], S.outputs.slice(-2).map((o) => ({ from: o.nodeId || o.agent.id, to: 'wrap' })).filter((e) => S.graph.nodes.some((n) => n.id === e.from)))
    await runAgent(SY, { nodeId: 'wrap', task: 'The Monitor stopped the team at its budget. Write the best final answer you can from the blackboard and the work so far, and say briefly what is unfinished.', inputs: S.outputs.slice(-4), final: true, maxTokens: 700 })
  }

  const RUNNERS = { sequential, router, orchestrator, hierarchical, parallel, fanout, debate, swarm }

  async function run() {
    emit({ type: 'swarm_started', runId, pattern: requested, provider, budget: S.budget, turnTaking: S.config.turnTaking, startedAt: S.startedAt, goal: asString(goal, 200) })
    emitBoard()
    monitorEmit()
    let outcome = 'completed'
    try {
      if (requested === 'auto') await architect()
      await RUNNERS[S.pattern]()
    } catch (err) {
      if (err?.name !== 'WrapUp') throw err
      outcome = 'budget'
      await wrapUpFinal()
    }
    const stats = { calls: S.calls, estTokens: S.estTokens, elapsedMs: now() - S.startedAt, pattern: S.pattern }
    monitorEmit()
    emit({ type: 'swarm_done', runId, outcome, stats })
    return { outcome, final: S.board.final, stats, board: S.board, pattern: S.pattern }
  }

  return {
    promise: run(),
    castVote(voter, optionId) {
      const v = [...S.votes.values()].pop()
      if (!v || !v.options.some((o) => o.id === optionId) || !voter?.id) return false
      v.votes.set(`human:${voter.id}`, { voter: { id: voter.id, name: voter.name, kind: 'human' }, option: optionId })
      emit({ type: 'swarm_vote_cast', runId, voteId: v.id, voter: { id: voter.id, name: voter.name, kind: 'human' }, option: optionId })
      v.check?.()
      return true
    },
    decideEscalation(escalationId, decision, by) {
      const finish = S.escalations.get(escalationId)
      if (!finish || !['continue', 'wrap_up'].includes(decision)) return false
      finish(decision, by ? { id: by.id, name: by.name } : null)
      return true
    },
    pin(kind, text, by, { flagged = false } = {}) {
      if (!BOARD_KINDS.includes(kind)) return false
      const before = S.board
      S.board = addItem(S.board, kind, text, { id: by?.id, name: by?.name || 'A human', kind: 'human' }, now(), { flagged })
      if (S.board === before) return false
      emitBoard()
      return true
    },
    get board() { return S.board },
    get seenDirectiveIds() { return S.seenDirectiveIds },
    get pattern() { return S.pattern },
  }
}
