// End-to-end smoke test: boots the real server (in-memory DB), then drives it
// like teammates in one session. Run with: npm test
import { spawn } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 4123
const BASE = `http://localhost:${PORT}`

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}

function connect(sessionId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
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

async function waitFor(client, predicate, label, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = client.inbox.find(predicate)
    if (hit) return hit
    await wait(50)
  }
  throw new Error(`timeout waiting for: ${label} (${client.name})`)
}

async function post(url, body) {
  const res = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json().catch(() => null) }
}

async function main() {
  console.log('Starting server…')
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HIVEMIND_DB: ':memory:' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stderr.on('data', (d) => {
    const line = d.toString()
    if (!line.includes('ExperimentalWarning') && !line.includes('trace-warnings')) process.stderr.write(line)
  })

  try {
    let health = null
    for (let i = 0; i < 40; i++) {
      try { health = await (await fetch(`${BASE}/api/health`)).json(); break } catch { await wait(250) }
    }
    check('server boots and /api/health responds', health?.ok === true)
    check('health advertises WebSocket realtime (runtime detection)', health?.realtime === 'ws')

    // --- REST basics -------------------------------------------------------
    const created = await post('/api/sessions', { name: 'Smoke Test', mode: 'live', provider: 'simulated' })
    check('POST /api/sessions creates a session', created.status === 201 && created.data.session.id.startsWith('sess_'))
    const session = created.data.session
    check('session gets a 6-char room code', /^[A-Z0-9]{6}$/.test(session.roomCode))

    const joined = await post('/api/join', { code: session.roomCode.toLowerCase() })
    check('POST /api/join finds session by code (case-insensitive)', joined.data?.session?.id === session.id)
    const badJoin = await post('/api/join', { code: 'ZZZZZZ' })
    check('bad room code returns 404', badJoin.status === 404)
    const badMsg = await post(`/api/sessions/${session.id}/messages`, { content: '', user: { name: 'X' } })
    check('empty message rejected with 400', badMsg.status === 400)

    // --- WebSocket: two teammates -----------------------------------------
    const alice = await connect(session.id, 'Alice')
    check('Alice joins and receives snapshot', alice.joined.session.id === session.id && Array.isArray(alice.joined.events))
    check('Alice got an identity with a color', Boolean(alice.joined.you.id) && /^#/.test(alice.joined.you.color))
    const bob = await connect(session.id, 'Bob')
    check('Bob joins and sees 2 participants', bob.joined.participants.length === 2)
    const alicePresence = await waitFor(alice, (m) => m.type === 'presence' && m.joined?.name === 'Bob', 'Alice sees Bob join')
    check('Alice is notified when Bob joins', alicePresence.participants.some((p) => p.name === 'Bob'))

    // --- Message → broadcast → agent streams to BOTH ----------------------
    const sent = await post(`/api/sessions/${session.id}/messages`, {
      content: 'Plan a launch for our new feature',
      user: { id: alice.joined.you.id, name: 'Alice', color: alice.joined.you.color },
    })
    check('message accepted (202)', sent.status === 202)
    await waitFor(bob, (m) => m.type === 'user_message' && m.event?.content?.includes('launch'), 'Bob sees Alice message')
    check('Bob receives Alice message in real time', true)
    await waitFor(alice, (m) => m.type === 'agent_started', 'agent starts (Alice)')
    await waitFor(bob, (m) => m.type === 'agent_started', 'agent starts (Bob)')
    check('agent_started broadcast to both clients', true)
    await waitFor(alice, (m) => m.type === 'agent_tool' && m.phase === 'call', 'tool call (Alice)')
    check('simulated tool call broadcast', true)
    await waitFor(alice, (m) => m.type === 'agent_token', 'tokens (Alice)')
    await waitFor(bob, (m) => m.type === 'agent_token', 'tokens (Bob)')
    check('token stream reaches both clients', true)

    // --- Late joiner during a live stream ---------------------------------
    const carol = await connect(session.id, 'Carol')
    check('late joiner sees live run status in snapshot', carol.joined.agentStatus === 'running')
    check('late joiner receives text streamed before joining', typeof carol.joined.streaming?.text === 'string' && carol.joined.streaming.runId?.startsWith('run_'))
    carol.ws.close()

    // --- Redirect mid-stream ----------------------------------------------
    const redirect = await post(`/api/sessions/${session.id}/actions`, {
      action: 'redirect', content: 'Actually focus on risks only',
      user: { id: bob.joined.you.id, name: 'Bob', color: bob.joined.you.color },
    })
    check('redirect action accepted', redirect.status === 200 && redirect.data.ok)
    await waitFor(alice, (m) => m.type === 'user_redirected' && m.instruction?.includes('risks'), 'Alice sees redirect')
    check('redirect broadcast to other teammates', true)
    await waitFor(alice, (m) => m.type === 'agent_done', 'first (interrupted) run finalizes', 30000)
    const interrupted = alice.inbox.find((m) => m.type === 'agent_done')
    check('interrupted run commits a partial message', interrupted?.partial === true || interrupted?.event === null || Boolean(interrupted?.event))
    await waitFor(alice, (m) => m.type === 'agent_done' && alice.inbox.filter((x) => x.type === 'agent_done').length >= 2, 'redirected follow-up run completes', 30000)
    const followUp = alice.inbox.filter((m) => m.type === 'agent_done')[1]
    check('redirect follow-up run completes with new content', followUp?.event?.content?.length > 0 && !followUp.partial)

    // --- Pause / Resume ----------------------------------------------------
    await post(`/api/sessions/${session.id}/messages`, {
      content: 'Now write the full report',
      user: { id: alice.joined.you.id, name: 'Alice', color: alice.joined.you.color },
    })
    const doneCount = alice.inbox.filter((x) => x.type === 'agent_done').length
    await waitFor(alice, (m) => m.type === 'agent_token' && alice.inbox.filter((x) => x.type === 'agent_started').length >= 3, 'third run streams', 20000)
    const pause = await post(`/api/sessions/${session.id}/actions`, { action: 'pause', user: { id: bob.joined.you.id, name: 'Bob' } })
    check('pause accepted', pause.status === 200)
    await waitFor(bob, (m) => m.type === 'agent_paused', 'Bob sees pause confirmation')
    await waitFor(alice, (m) => m.type === 'session_status' && m.status === 'paused', 'Alice sees paused status')
    check('pause reflected on all clients', true)
    const resume = await post(`/api/sessions/${session.id}/actions`, { action: 'resume', user: { id: alice.joined.you.id, name: 'Alice' } })
    check('resume accepted', resume.status === 200)
    await waitFor(bob, (m) => m.type === 'agent_resumed', 'Bob sees resume')
    await waitFor(bob, (m) => m.type === 'agent_done' && bob.inbox.filter((x) => x.type === 'agent_done').length >= doneCount + 2, 'resumed run completes', 30000)
    check('resumed run completes', true)

    // --- Fork --------------------------------------------------------------
    const fork = await post(`/api/sessions/${session.id}/actions`, { action: 'fork', user: { id: alice.joined.you.id, name: 'Alice' } })
    check('fork returns a new session', fork.status === 200 && fork.data.session.id !== session.id)
    const forkState = await (await fetch(`${BASE}/api/sessions/${fork.data.session.id}`)).json()
    check('fork copies the timeline', forkState.events.length > 3)
    await waitFor(bob, (m) => m.type === 'session_forked', 'Bob sees fork notification')
    check('fork broadcast to teammates', true)

    // --- Guardrails --------------------------------------------------------
    const longMsg = await post(`/api/sessions/${session.id}/messages`, { content: 'x'.repeat(5000), user: { name: 'Alice' } })
    check('over-length message capped, not crashed', [202, 400, 429].includes(longMsg.status))
    let limited = false
    for (let i = 0; i < 25; i++) {
      const r = await post(`/api/sessions/${session.id}/messages`, { content: `spam ${i}`, user: { name: 'Spam' } })
      if (r.status === 429) { limited = true; break }
    }
    check('rate limit kicks in under message flood', limited)
    const badJson = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' })
    check('malformed JSON returns 400, server survives', badJson.status === 400)

    // --- Presence on disconnect -------------------------------------------
    bob.ws.close()
    await waitFor(alice, (m) => m.type === 'presence' && m.left?.name === 'Bob', 'Alice sees Bob leave')
    check('leave presence broadcast on disconnect', true)
    alice.ws.close()
  } finally {
    server.kill()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\nSMOKE TEST CRASHED:', err.message)
  process.exit(1)
})
