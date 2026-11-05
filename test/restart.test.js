// Restart test: the live team view survives a server restart. Boots the real
// server on a temp-file database, runs teams, kills the process (SIGKILL, and
// SIGTERM for the graceful flush) and boots it again on the same file.
// Run with: npm run test:restart
import { spawn } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(__dirname, '..', 'server', 'server.js')
const PORT = Number(process.env.HIVEMIND_RESTART_PORT) || 4131
const RESTART_NOTE = 'The server restarted while the team was working, so that run stopped. Send a message to start again.'

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}

// One server process on the shared file. The port is read from its startup
// line: the server moves on to the next port when one is busy.
async function boot(file, { pace = false } = {}) {
  const proc = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), HIVEMIND_DB: file, HIVEMIND_SCRIPTED_PACE: pace ? '1' : '0', HIVEMIND_LEAVE_GRACE_MS: '300' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  proc.stdout.on('data', (d) => { out += d })
  proc.stderr.on('data', (d) => {
    const line = d.toString()
    if (!line.includes('ExperimentalWarning') && !line.includes('trace-warnings')) process.stderr.write(line)
  })
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
  let port = null
  for (let i = 0; i < 200 && !port && proc.exitCode === null; i++) {
    port = Number(out.match(/Local:\s+http:\/\/localhost:(\d+)/)?.[1]) || null
    if (!port) await wait(50)
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error(`server did not start:\n${out}`) }
  const base = `http://localhost:${port}`
  let health = null
  for (let i = 0; i < 40 && !health; i++) {
    try { health = await (await fetch(`${base}/api/health`)).json() } catch { await wait(100) }
  }
  if (!health?.ok) { proc.kill('SIGKILL'); throw new Error('server did not answer /api/health') }
  return {
    proc, port, base, exited,
    output: () => out,
    kill: (signal) => { proc.kill(signal); return exited },
  }
}

function connect(srv, sessionId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`)
    const client = { ws, name, inbox: [], joined: null }
    const timer = setTimeout(() => reject(new Error(`${name}: join timeout`)), 5000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', sessionId, user: { name } })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      client.inbox.push(msg)
      if (msg.type === 'joined') { client.joined = msg; clearTimeout(timer); resolve(client) }
    })
    ws.on('error', reject)
  })
}

// Messages that arrived after inbox position `from` (runs repeat the same types).
async function waitAfter(client, from, predicate, label, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = client.inbox.slice(from).find(predicate)
    if (hit) return hit
    await wait(30)
  }
  throw new Error(`timeout waiting for: ${label} (${client.name})`)
}
const waitFor = (client, predicate, label, timeoutMs) => waitAfter(client, 0, predicate, label, timeoutMs)

// Calls `fn` in the same tick the first matching frame arrives (a kill timed
// to a step, before the coalesced save could fire on its own).
function onFirst(client, predicate, fn) {
  return new Promise((resolve) => {
    const listener = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (!predicate(msg)) return
      client.ws.off('message', listener)
      fn(msg)
      resolve(msg)
    }
    client.ws.on('message', listener)
  })
}

async function post(srv, url, body) {
  const res = await fetch(`${srv.base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const getSession = async (srv, id) => (await fetch(`${srv.base}/api/sessions/${id}`)).json()
const userOf = (client) => ({ id: client.joined.you.id, name: client.name, color: client.joined.you.color })
const notesIn = (events) => events.filter((e) => e.type === 'system' && e.content === RESTART_NOTE).length
const createTeam = async (srv, name, pattern = 'sequential') =>
  (await post(srv, '/api/sessions', { name, mode: 'sample', provider: 'simulated', config: { crew: 'team', pattern } })).data.session

// What the dead process left on disk (read with the server down).
function stored(file, id) {
  const db = new DatabaseSync(file)
  try {
    const row = db.prepare('SELECT status, swarm_view, blackboard FROM sessions WHERE id = ?').get(id)
    return { status: row?.status, swarm: row?.swarm_view ? JSON.parse(row.swarm_view) : null, board: row?.blackboard ? JSON.parse(row.blackboard) : null }
  } finally {
    db.close()
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-restart-'))
  const file = path.join(dir, 'rooms.db')
  let srv = null
  try {
    // --- A finished run survives a hard kill ------------------------------
    console.log('A finished team, then SIGKILL')
    srv = await boot(file)
    // A Swarm converges when the Critic approves a draft: that sets the view's
    // final-answer pointer (swarm_final), which must survive too.
    const room = await createTeam(srv, 'Restart Test', 'swarm')
    const fay = await connect(srv, room.id, 'Fay')
    await post(srv, `/api/sessions/${room.id}/messages`, { content: 'Write a launch memo for our notes app', user: userOf(fay) })
    const final = await waitFor(fay, (m) => m.type === 'swarm_final', 'final answer')
    await waitFor(fay, (m) => m.type === 'swarm_done', 'team run finishes')
    await waitFor(fay, (m) => m.type === 'session_status' && m.status === 'idle', 'room idle')
    await post(srv, `/api/sessions/${room.id}/actions`, { action: 'pin', kind: 'constraints', content: 'Keep it under one page', user: userOf(fay) })
    await waitFor(fay, (m) => m.type === 'blackboard' && m.board?.constraints?.length === 1, 'pin lands')
    const before = await getSession(srv, room.id)
    check('before the restart: a finished view with a final answer', before.swarm?.status === 'done' && before.swarm.outcome === 'completed' && before.swarm.finalEventId === final.eventId)
    fay.ws.close()
    // No graceful flush: the run end and the idle pin wrote everything already.
    await srv.kill('SIGKILL')
    check('the finished view is on disk', stored(file, room.id).swarm?.runId === before.swarm.runId)

    srv = await boot(file)
    check('a boot after a finished run closes nothing', !/Closed \d+ team run/.test(srv.output()))
    const gus = await connect(srv, room.id, 'Gus')
    const view = gus.joined.swarm
    check('a joiner after the restart gets the finished team view', view?.status === 'done' && view.outcome === 'completed' && view.runId === before.swarm.runId)
    check('... with the same roster order and final-answer pointer', view?.order.length >= 3 && JSON.stringify(view.order) === JSON.stringify(before.swarm.order) && Number.isInteger(view.finalEventId) && view.finalEventId === final.eventId)
    check('... the same graph and monitor', view?.graph.nodes.length === before.swarm.graph.nodes.length && view.graph.nodes.every((n, i) => n.status === before.swarm.graph.nodes[i].status) && view.monitor.calls === before.swarm.monitor.calls)
    check('... and the final answer it points at', gus.joined.events.some((e) => e.id === view?.finalEventId && e.type === 'agent_message' && e.meta?.final))
    check('a joiner after the restart gets the board, pin included', gus.joined.blackboard?.final.length > 0 && gus.joined.blackboard.constraints.some((c) => c.text === 'Keep it under one page'))
    check('the room reads as idle with no restart note', gus.joined.agentStatus === 'idle' && gus.joined.session.status === 'idle' && notesIn(gus.joined.events) === 0)
    const state = await getSession(srv, room.id)
    check('GET /api/sessions/:id returns the stored view and board', state.swarm?.runId === view?.runId && state.swarm.outcome === 'completed' && state.swarm.finalEventId === final.eventId && state.blackboard?.constraints.length === 1)

    const forked = await post(srv, `/api/sessions/${room.id}/actions`, { action: 'fork', pattern: 'router', user: userOf(gus) })
    const fork = forked.data?.session
    check('fork with another architecture works after the restart', forked.status === 200 && fork?.config.crew === 'team' && fork.config.pattern === 'router' && fork.forkedFrom === room.id)
    const forkState = fork ? await getSession(srv, fork.id) : null
    check('the fork keeps the board and the timeline but starts with no team view', forkState?.swarm === null &&
      forkState.blackboard?.constraints.some((c) => c.text === 'Keep it under one page') && forkState.events.some((e) => e.meta?.final))

    let from = gus.inbox.length
    const switched = await post(srv, `/api/sessions/${room.id}/actions`, { action: 'set_config', config: { crew: 'team', pattern: 'parallel' }, user: userOf(gus) })
    const configMsg = await waitAfter(gus, from, (m) => m.type === 'session_config', 'config broadcast')
    check('set_config works after the restart', switched.status === 200 && switched.data.session.config.pattern === 'parallel' && configMsg.config.pattern === 'parallel')
    from = gus.inbox.length
    await post(srv, `/api/sessions/${room.id}/messages`, { content: 'Plan a migration from MySQL to Postgres', user: userOf(gus) })
    const next = await waitAfter(gus, from, (m) => m.type === 'swarm_started', 'next run starts')
    const nextDone = await waitAfter(gus, from, (m) => m.type === 'swarm_done', 'next run finishes')
    await waitAfter(gus, from, (m) => m.type === 'session_status' && m.status === 'idle', 'idle again')
    const after = await getSession(srv, room.id)
    check('the next run uses the new architecture and replaces the stored view', next.pattern === 'parallel' && next.runId !== view?.runId && nextDone.outcome === 'completed' && after.swarm?.runId === next.runId)
    gus.ws.close()
    await srv.kill('SIGKILL')

    // --- SIGTERM mid-run: the pending save is flushed ---------------------
    console.log('SIGTERM while a paced team works')
    srv = await boot(file, { pace: true })
    const calm = await createTeam(srv, 'Graceful Stop')
    const ivy = await connect(srv, calm.id, 'Ivy')
    const startedCalm = onFirst(ivy, (m) => m.type === 'swarm_started', () => {})
    const firstDone = onFirst(ivy, (m) => m.type === 'swarm_agent_done', () => srv.proc.kill('SIGTERM'))
    await post(srv, `/api/sessions/${calm.id}/messages`, { content: 'Draft a hiring plan for the support team', user: userOf(ivy) })
    const calmRun = await startedCalm
    const doneStep = await firstDone
    const termExit = await srv.exited
    check('SIGTERM shuts the server down cleanly', termExit.code === 0 && termExit.signal === null)
    const onDisk = stored(file, calm.id)
    check('the shutdown flushed the pending view: the finished step is on disk', onDisk.swarm?.status === 'running' && onDisk.swarm.team[doneStep.agentId]?.status === 'done')
    ivy.ws.close()

    srv = await boot(file)
    check('the next boot reports the run it closed', /Closed 1 team run cut off by the last shutdown\./.test(srv.output()))
    const jo = await connect(srv, calm.id, 'Jo')
    const lostCalm = jo.joined.swarm
    check('the view is closed as lost, the finished step kept', lostCalm?.runId === calmRun.runId && lostCalm.status === 'done' && lostCalm.outcome === 'lost' && lostCalm.team[doneStep.agentId]?.status === 'done')
    check('one restart note, and the room is idle', notesIn(jo.joined.events) === 1 && jo.joined.agentStatus === 'idle' && jo.joined.session.status === 'idle')
    jo.ws.close()
    await srv.kill('SIGKILL')

    // --- SIGKILL mid-stream ----------------------------------------------
    console.log('SIGKILL while a paced team streams')
    srv = await boot(file, { pace: true })
    const goal = 'Plan the onboarding emails for new users'
    const cut = await createTeam(srv, 'Hard Kill')
    const kim = await connect(srv, cut.id, 'Kim')
    const startedCut = onFirst(kim, (m) => m.type === 'swarm_started', () => {})
    await post(srv, `/api/sessions/${cut.id}/messages`, { content: goal, user: userOf(kim) })
    const cutRun = await startedCut
    await waitFor(kim, (m) => m.type === 'swarm_token' && m.delta, 'an agent streams', 20000)
    await wait(700) // more tokens, and time for a coalesced save to fire
    const killExit = await srv.kill('SIGKILL')
    kim.ws.close()
    check('the run was killed mid-flight', killExit.signal === 'SIGKILL')
    const dead = stored(file, cut.id)
    const speaking = Object.values(dead.swarm?.team || {}).filter((a) => a.status === 'speaking' || a.status === 'thinking')
    check('on disk: the view still says running, the status too', dead.status === 'running' && dead.swarm?.status === 'running' && dead.swarm.runId === cutRun.runId)
    check('... and tokens were never written (the live stream is not on disk)', speaking.length > 0 && speaking.every((a) => a.stream === ''))

    srv = await boot(file)
    const lee = await connect(srv, cut.id, 'Lee')
    const lost = lee.joined.swarm
    check('after the restart the view is closed as lost', lost?.runId === cutRun.runId && lost.status === 'done' && lost.outcome === 'lost')
    check('... with nothing left live in it', Object.values(lost?.team || {}).every((a) => a.status !== 'speaking' && a.status !== 'thinking' && !a.stream) &&
      (lost?.graph.nodes || []).every((n) => n.status !== 'running' && n.status !== 'queued') && !lost?.vote?.open && lost?.escalation === null)
    check('exactly one restart note, and the room reads as idle', notesIn(lee.joined.events) === 1 && lee.joined.agentStatus === 'idle' && lee.joined.session.status === 'idle')
    const lostState = await getSession(srv, cut.id)
    check('GET /api/sessions/:id returns the closed view', lostState.swarm?.outcome === 'lost' && lostState.agentStatus === 'idle' && lostState.session.status === 'idle')
    lee.ws.close()
    await srv.kill('SIGKILL')

    srv = await boot(file)
    check('a second boot closes nothing again', !/Closed \d+ team run/.test(srv.output()))
    const max = await connect(srv, cut.id, 'Max')
    check('... and adds no second note', notesIn(max.joined.events) === 1 && max.joined.swarm?.outcome === 'lost' && max.joined.swarm.runId === cutRun.runId)
    check('the other closed room still has exactly one note', notesIn((await getSession(srv, calm.id)).events) === 1)

    from = max.inbox.length
    const resumed = await post(srv, `/api/sessions/${cut.id}/actions`, { action: 'resume', user: userOf(max) })
    const resumedRun = await waitAfter(max, from, (m) => m.type === 'swarm_started', 'resumed run starts')
    await waitAfter(max, from, (m) => m.type === 'swarm_done' && m.runId === resumedRun.runId, 'resumed run finishes')
    check('resume after the restart continues the previous goal', resumed.data?.ok === true && resumedRun.goal === `Continue the previous goal: ${goal}` && resumedRun.runId !== cutRun.runId)
    await waitAfter(max, from, (m) => m.type === 'session_status' && m.status === 'idle', 'idle after the resumed run')
    from = max.inbox.length
    const sent = await post(srv, `/api/sessions/${cut.id}/messages`, { content: 'Now write the welcome email', user: userOf(max) })
    const fresh = await waitAfter(max, from, (m) => m.type === 'swarm_started', 'new run starts')
    const freshDone = await waitAfter(max, from, (m) => m.type === 'swarm_done' && m.runId === fresh.runId, 'new run finishes')
    check('a new message after the restart starts a new run that completes', sent.data?.run?.ok === true && fresh.goal === 'Now write the welcome email' && freshDone.outcome === 'completed')
    await waitAfter(max, from, (m) => m.type === 'session_status' && m.status === 'idle', 'idle after the new run')
    check('the restart note is still the only one', notesIn((await getSession(srv, cut.id)).events) === 1)
    max.ws.close()
    await srv.kill('SIGKILL')

    // --- SIGKILL the moment a new run starts -------------------------------
    // The first room's last run finished with another goal and answer on its
    // board. The new run's opening board must be on disk with its view, or a
    // resume would continue the old goal next to the new run's lost view.
    console.log('SIGKILL the moment a new run starts')
    srv = await boot(file, { pace: true })
    const newGoal = 'Write the changelog for version two'
    const nia = await connect(srv, room.id, 'Nia')
    const startedNew = onFirst(nia, (m) => m.type === 'swarm_started', () => {})
    // The opening board follows the start frame: kill on it, before any save timer.
    onFirst(nia, (m) => m.type === 'blackboard', () => srv.proc.kill('SIGKILL'))
    post(srv, `/api/sessions/${room.id}/messages`, { content: newGoal, user: userOf(nia) }).catch(() => null)
    const newRun = await startedNew
    await srv.exited
    nia.ws.close()
    const early = stored(file, room.id)
    check('on disk: the started view and its fresh board, no answer from the run before', early.swarm?.runId === newRun.runId && early.swarm.status === 'running' && early.board?.goal === newGoal && !early.board.final)
    srv = await boot(file)
    const oz = await connect(srv, room.id, 'Oz')
    check('after the restart: closed as lost with one note, board kept', oz.joined.swarm?.runId === newRun.runId && oz.joined.swarm.outcome === 'lost' && notesIn(oz.joined.events) === 1 &&
      !oz.joined.blackboard?.final && oz.joined.blackboard?.constraints.some((c) => c.text === 'Keep it under one page'))
    from = oz.inbox.length
    await post(srv, `/api/sessions/${room.id}/actions`, { action: 'resume', user: userOf(oz) })
    const again = await waitAfter(oz, from, (m) => m.type === 'swarm_started', 'resume after an early kill')
    check('resume continues the goal of the run that was cut off, not the one before', again.goal === `Continue the previous goal: ${newGoal}`)
    await waitAfter(oz, from, (m) => m.type === 'session_status' && m.status === 'idle', 'idle after the resume')
    oz.ws.close()
  } finally {
    if (srv && srv.proc.exitCode === null && srv.proc.signalCode === null) await srv.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\nRESTART TEST CRASHED:', err.message)
  process.exit(1)
})
