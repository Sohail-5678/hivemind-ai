// Hive demo: the real multi-agent engine, running in this tab with the scripted
// brain, plus two scripted teammates who do what people do in a Hive room: pin a
// constraint, call on an agent mid-run, vote, and answer the Monitor. Every
// message goes through the same sessionReducer a live room uses, so the demo
// cannot drift from the product. Zero network calls, zero keys.
import { createSwarmRun } from '@shared/swarm/engine.js'
import { reduceSwarmView, interruptedDone } from '@shared/swarm/view.js'
import { PATTERNS, clampConfig } from '@shared/swarm/patterns.js'
import { BOARD_KINDS, addItem, emptyBoard, setText } from '@shared/swarm/blackboard.js'
import { CAST } from './demoScript'

// The architectures the demo showcases, in picker order.
export const DEMO_PATTERNS = ['auto', 'sequential', 'orchestrator', 'parallel', 'debate', 'swarm']

// The viewer watches; if the panels let them act, they act as "You".
export const DEMO_VIEWER = { id: 'demo_viewer', name: 'You' }

const HUMANS = { maya: CAST.maya, jordan: CAST.jordan }

// One goal per architecture, each the shape of work that architecture suits.
// Goals start with the subject so the scripted brain's topic reads cleanly.
// Fork and "Switch architecture" re-run a scenario's goal under another pattern.
export const SCENARIOS = {
  auto: {
    room: 'Offline mode: Q3 or Q4',
    goal: 'Offline mode: Q3 vs. Q4?',
    pin: { by: 'jordan', text: 'Support can only absorb one launch this quarter' },
    mention: { by: 'maya', role: 'skeptic', text: '@skeptic what happens to support if sync conflicts double?' },
    votes: { maya: 'pragmatist', jordan: 'skeptic' },
  },
  sequential: {
    room: 'Offline mode pilot brief',
    goal: 'Offline mode pilot: can you write it up for us?',
    pin: { by: 'jordan', text: 'Keep it to one page' },
    mention: { by: 'maya', role: 'critic', text: '@critic make sure it does not promise a ship date' },
  },
  orchestrator: {
    room: 'Support handbook',
    goal: 'Support handbook: can you help us put it together?',
    pin: { by: 'jordan', text: 'No new hires: the current team only' },
    mention: { by: 'maya', role: 'analyst', text: '@analyst count support time, not just engineering time' },
    // A deliberately tight budget, so the Monitor has to stop and ask the humans.
    config: { maxCalls: 5 },
    tightBudget: true,
  },
  parallel: {
    room: 'Billing migration',
    goal: 'Billing migration: can you help us with it?',
    pin: { by: 'jordan', text: 'No downtime for paying customers' },
    mention: { by: 'maya', role: 'writer', text: '@writer keep the cutover steps in the order we run them' },
  },
  debate: {
    room: 'Referral program decision',
    goal: 'Referral program: go or no go?',
    pin: { by: 'jordan', text: 'Budget stays at what we spent last quarter' },
    mention: { by: 'maya', role: 'builder', text: '@builder what is the smallest version you would still back?' },
    votes: { maya: 'pragmatist', jordan: 'skeptic' },
  },
  swarm: {
    room: 'Onboarding redesign',
    goal: 'Onboarding redesign: we need help with it',
    pin: { by: 'jordan', text: 'Leave the signup form alone this sprint' },
    mention: { by: 'maya', role: 'analyst', text: '@analyst commit to a first step early, we can adjust' },
  },
}

// Pre-run choreography and human reaction times, in ms (scaled by `beat`).
const BEATS = {
  firstJoin: 250, secondJoin: 600, typeGoal: 500, sendGoal: 1100, typePin: 600, sendPin: 1000, startRun: 650,
  mentionAfterStart: 500, typeMention: 900,
  vote: [1600, 3100],
  escalation: 2800,
}

let demoCounter = 0

function directiveOf(event) {
  return { id: event.id, content: event.content, author: event.author, flagged: false }
}

// Starts one demo run. Returns a controller; call stop() on unmount or replay.
// `dispatch` receives server-shaped messages for sessionReducer; `notice` is
// shown once the slate is clean; `onEnd` gets { outcome, stats, pattern,
// escalations } once the run settles (never after stop()). `turnTaking` picks
// a debate's or a swarm's strategy (clampConfig drops one it does not offer).
export function startHiveDemo({ scenario: scenarioId = 'auto', pattern, turnTaking = null, notice = null, dispatch, onEnd, pace = true, beat = 1 }) {
  const id = SCENARIOS[scenarioId] ? scenarioId : 'auto'
  const sc = SCENARIOS[id]
  const requested = PATTERNS[pattern] ? pattern : id
  // A fork keeps the scenario but not its tuning: the tight budget belongs to that showcase.
  const raw = { ...(requested === id ? sc.config || {} : {}), ...(turnTaking ? { turnTaking } : {}) }
  const config = { crew: 'team', pattern: requested, ...clampConfig(requested, 'simulated', raw) }
  const tag = `${++demoCounter}`
  const session = { id: `demo_hive_${id}`, name: sc.room, mode: 'live', status: 'idle', provider: 'simulated', config, createdAt: new Date().toISOString() }

  const controller = new AbortController()
  const timers = new Set()
  let stopped = false
  let run = null
  let present = []
  let board = setText(emptyBoard(), 'goal', sc.goal, Date.now())
  let view = { swarm: null, blackboard: null }
  let seq = 0
  let mentionPlanned = false
  let escalations = 0
  const directives = []
  const history = []

  const send = (msg) => { if (!stopped) dispatch(msg) }
  const later = (ms, fn) => {
    if (stopped) return
    const t = setTimeout(() => { timers.delete(t); if (!stopped) fn() }, Math.max(0, Math.round(ms * beat)))
    timers.add(t)
  }
  const mkEvent = (type, author, content = null, meta = null) => ({
    id: `${session.id}_${tag}_${++seq}`, sessionId: session.id, type, author, content, meta, createdAt: new Date().toISOString(),
  })
  const timeline = (event) => { send({ type: 'timeline_event', event }); return event }

  // ---------------------------------------------------------------- people
  const presence = () => send({ type: 'presence', participants: present.map((p) => ({ ...p })) })
  const join = (who) => {
    present = [...present.filter((p) => p.id !== who.id), { ...who, typing: false }]
    presence()
    timeline(mkEvent('join', who))
  }
  const typing = (who, on) => {
    present = present.map((p) => (p.id === who.id ? { ...p, typing: on } : p))
    presence()
  }
  const say = (who, content) => {
    typing(who, false)
    const event = mkEvent('user_message', who, content)
    send({ type: 'user_message', event })
    if (run) directives.push(directiveOf(event))
    else history.push({ author: who, content })
    return event
  }
  const pin = (who, kind, content) => {
    const text = String(content || '').trim()
    if (!BOARD_KINDS.includes(kind) || !text || text.length > 200) return false
    const by = { id: who.id, name: who.name, kind: 'human' }
    if (run) {
      if (!run.pin(kind, text, by)) return false
    } else {
      const next = addItem(board, kind, text, by, Date.now())
      if (next === board) return false
      board = next
      onEngine({ type: 'blackboard', board })
    }
    timeline(mkEvent('pin', who, text, { kind }))
    return true
  }

  // ---------------------------------------------------------------- engine
  function onEngine(msg) {
    view = reduceSwarmView(view, msg) || view
    if (msg.type === 'blackboard' && msg.board) board = msg.board
    send(msg)
    // Mid-run means while the first agent is still talking, so the mention can
    // still change what happens next (in a swarm it raises that agent's bid).
    if (msg.type === 'swarm_agent_start' && (msg.kind === 'text' || msg.kind === 'debate_turn') && !mentionPlanned) planMention()
    if (msg.type === 'swarm_vote_open') planVotes(msg)
    if (msg.type === 'swarm_escalation') planEscalation(msg)
  }

  const persist = (e) => timeline(mkEvent(e.type, e.author, e.content, e.meta))

  // The mention goes to the scenario's agent when it is on this team and still
  // has work ahead; otherwise (a fork into another architecture) to the first
  // teammate that has not spoken yet. Debate peers and swarm agents speak more
  // than once, so having spoken already doesn't rule them out.
  function mentionTarget() {
    const swarm = view.swarm
    if (!swarm) return null
    const team = swarm.order.map((aid) => swarm.team[aid]).filter((a) => a && a.role !== 'architect' && a.role !== 'moderator')
    const repeats = swarm.pattern === 'debate' || swarm.pattern === 'swarm'
    const preferred = team.find((a) => a.role === sc.mention.role)
    if (preferred && (repeats || preferred.status !== 'done')) return { role: preferred.role, text: sc.mention.text }
    const next = team.find((a) => a.status === 'idle')
    return next ? { role: next.role, text: `@${next.role} what is the biggest risk you see so far?` } : null
  }

  function planMention() {
    mentionPlanned = true
    const who = HUMANS[sc.mention.by]
    later(BEATS.mentionAfterStart, () => {
      if (!run || view.swarm?.status !== 'running') return
      typing(who, true)
      later(BEATS.typeMention, () => {
        const target = mentionTarget()
        if (target && view.swarm?.status === 'running') say(who, target.text)
        else typing(who, false)
      })
    })
  }

  function planVotes(msg) {
    const ids = (msg.options || []).map((o) => o.id)
    if (!ids.length) return
    const wanted = sc.votes || { maya: ids[ids.length - 1], jordan: ids[Math.min(1, ids.length - 1)] }
    ;['maya', 'jordan'].forEach((key, i) => {
      later(BEATS.vote[i], () => {
        const option = ids.includes(wanted[key]) ? wanted[key] : ids[0]
        run?.castVote(HUMANS[key], option)
      })
    })
  }

  // First escalation: Maya lets the team continue. Any later one: Jordan wraps up.
  function planEscalation(msg) {
    escalations++
    const [who, decision] = escalations === 1 ? [HUMANS.maya, 'continue'] : [HUMANS.jordan, 'wrap_up']
    later(BEATS.escalation, () => run?.decideEscalation(msg.escalationId, decision, { id: who.id, name: who.name }))
  }

  function startRun() {
    run = createSwarmRun({
      runId: `run_demo_${tag}`,
      contextId: session.id,
      pattern: requested,
      config,
      goal: sc.goal,
      history: history.slice(-6),
      humans: () => present.map(({ id: hid, name }) => ({ id: hid, name })),
      board,
      llm: { provider: 'simulated' },
      emit: onEngine,
      persist,
      directives: () => directives,
      signal: controller.signal,
      pace,
      flushMs: 90,
    })
    send({ type: 'session_status', status: 'running' })
    run.promise.then((res) => {
      if (stopped) return
      send({ type: 'session_status', status: 'idle' })
      onEnd?.({ outcome: res.outcome, stats: res.stats, pattern: res.pattern, escalations })
    }, (err) => {
      if (stopped || err?.name === 'AbortError') return
      const done = interruptedDone(view.swarm, 'error')
      if (done) onEngine(done)
      send({ type: 'session_status', status: 'idle' })
      send({ type: 'agent_error', error: 'The demo hit an error and stopped. Press Replay to run it again.' })
      onEnd?.({ outcome: 'error', stats: null, pattern: view.swarm?.pattern || requested, escalations })
    })
  }

  // ---------------------------------------------------------------- script
  // A clean slate: the same snapshot shape a live room sends a joiner.
  dispatch({ type: 'joined', session, you: DEMO_VIEWER, events: [], participants: [], agentStatus: 'idle', swarm: null, blackboard: board })
  dispatch(notice ? { type: 'local_notice', notice } : { type: 'clear_notice' })

  const p = sc.pin
  later(BEATS.firstJoin, () => {
    join(HUMANS.maya)
    later(BEATS.secondJoin, () => {
      join(HUMANS.jordan)
      later(BEATS.typeGoal, () => {
        typing(HUMANS.maya, true)
        later(BEATS.sendGoal, () => {
          say(HUMANS.maya, sc.goal)
          later(BEATS.typePin, () => {
            typing(HUMANS[p.by], true)
            later(BEATS.sendPin, () => {
              typing(HUMANS[p.by], false)
              pin(HUMANS[p.by], 'constraints', p.text)
              later(BEATS.startRun, startRun)
            })
          })
        })
      })
    })
  })

  return {
    session,
    scenario: id,
    pattern: requested,
    // Viewer actions from the Hive panels. Returns true when the demo handled it.
    act(action, extra = {}) {
      if (stopped) return false
      if (action === 'vote') return Boolean(run?.castVote(DEMO_VIEWER, extra.option))
      if (action === 'escalation') return Boolean(run?.decideEscalation(extra.escalationId, extra.decision, DEMO_VIEWER))
      if (action === 'pin') return pin(DEMO_VIEWER, extra.kind, extra.content)
      return false
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.clear()
      controller.abort()
    },
  }
}
