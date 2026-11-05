// HiveMind server — Express REST + WebSocket rooms + SQLite + agent engine, one process.
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSession, getSession, getSessionByCode, getEvents, addEvent, forkSession } from './db.js'
import { attachWebSocket, broadcast, participantsOf } from './websocket.js'
import {
  startRun, pauseAgent, resumeAgent, redirectAgent, stopAgent, agentStatus, isRunning, setSessionKey,
  getSwarmSnapshot, getBoardSnapshot, sanitizeConfig, mergeConfig, crewLabel, pinBoard, castVote, decideEscalation, setConfig, logEvent,
  recoverInterruptedViews, flushTeamSaves,
} from './agent.js'
import { DEFAULT_HUMAN_COLOR } from './palette.js'
import { PATTERNS, PATTERN_ORDER } from './swarm/patterns.js'
import { BOARD_KINDS } from './swarm/blackboard.js'
import { flagInjection } from './swarm/guard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

const app = express()
app.use(express.json({ limit: '64kb' }))
app.disable('x-powered-by')

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------
const MAX_MESSAGE_CHARS = 4000
const MAX_REDIRECT_CHARS = 500
const MAX_NAME_CHARS = 60
const MAX_PIN_CHARS = 200
const RATE_LIMIT = { windowMs: 60_000, maxMessages: 20, maxSessions: 15 }
const rateBuckets = new Map()

function rateLimited(key, max) {
  const now = Date.now()
  const bucket = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_LIMIT.windowMs)
  if (bucket.length >= max) { rateBuckets.set(key, bucket); return true }
  bucket.push(now)
  rateBuckets.set(key, bucket)
  return false
}
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of rateBuckets) {
    const alive = bucket.filter((t) => now - t < RATE_LIMIT.windowMs)
    if (alive.length === 0) rateBuckets.delete(key)
    else rateBuckets.set(key, alive)
  }
}, 5 * 60_000).unref()

// Strip control characters (keep \t \n \r), trim, cap length.
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g')
function cleanText(value, maxLen) {
  if (typeof value !== 'string') return null
  const text = value.replace(CONTROL_CHARS, '').trim().slice(0, maxLen)
  return text.length ? text : null
}

function cleanUser(body) {
  const name = cleanText(body?.user?.name, MAX_NAME_CHARS) || 'Guest'
  const id = typeof body?.user?.id === 'string' && body.user.id.length <= 40 ? body.user.id : 'u_anon'
  const color = typeof body?.user?.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(body.user.color) ? body.user.color : DEFAULT_HUMAN_COLOR
  return { id, name, color }
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// The client uses this to detect "full server" mode (vs the static Vercel build)
// and that this server runs agent teams (protocol version 2).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, realtime: 'ws', swarm: true, version: 2, uptime: process.uptime() })
})

app.get('/api/providers', async (_req, res) => {
  const providers = {
    simulated: { available: true },
    free: { available: true },
    ollama: { available: false, models: [] },
    groq: { available: Boolean(process.env.GROQ_API_KEY), byok: true },
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal })
    clearTimeout(timer)
    if (r.ok) {
      const data = await r.json()
      providers.ollama.models = (data.models || []).map((m) => m.name).slice(0, 10)
      // A running Ollama with nothing pulled can't serve a session — don't offer it.
      providers.ollama.available = providers.ollama.models.length > 0
    }
  } catch { /* ollama not running — fine */ }
  res.json(providers)
})

app.post('/api/sessions', (req, res) => {
  const ip = req.ip || 'unknown'
  if (rateLimited(`sess:${ip}`, RATE_LIMIT.maxSessions)) {
    return res.status(429).json({ error: 'Too many sessions created. Wait a minute and try again.' })
  }
  const name = cleanText(req.body?.name, 80) || 'Untitled Session'
  const mode = ['demo', 'sample', 'live'].includes(req.body?.mode) ? req.body.mode : 'live'
  const provider = ['simulated', 'free', 'ollama', 'groq'].includes(req.body?.provider) ? req.body.provider : 'simulated'
  const model = cleanText(req.body?.model, 60)
  const config = sanitizeConfig(req.body?.config, provider)
  const session = createSession({ name, mode, provider, model, config })
  if (provider === 'groq' && typeof req.body?.apiKey === 'string') setSessionKey(session.id, req.body.apiKey)
  addEvent(session.id, { type: 'system', content: config.crew === 'team' ? `Session "${name}" created with ${crewLabel(config)}.` : `Session "${name}" created.` })
  res.status(201).json({ session })
})

app.post('/api/join', (req, res) => {
  const ip = req.ip || 'unknown'
  if (rateLimited(`join:${ip}`, 30)) return res.status(429).json({ error: 'Too many join attempts. Slow down a little.' })
  const code = cleanText(req.body?.code, 12)
  if (!code) return res.status(400).json({ error: 'Room code required.' })
  const session = getSessionByCode(code)
  if (!session) return res.status(404).json({ error: 'No session found for that code. Check it and try again.' })
  res.json({ session })
})

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found.' })
  res.json({ session, events: getEvents(session.id), participants: participantsOf(session.id), agentStatus: agentStatus(session.id), ...getSwarmSnapshot(session.id) })
})

app.post('/api/sessions/:id/messages', (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found.' })
  const user = cleanUser(req.body)
  const ip = req.ip || 'unknown'
  if (rateLimited(`msg:${ip}:${session.id}`, RATE_LIMIT.maxMessages)) {
    return res.status(429).json({ error: 'Rate limit hit: at most 20 messages a minute.' })
  }
  const content = cleanText(req.body?.content, MAX_MESSAGE_CHARS)
  if (!content) return res.status(400).json({ error: 'Message is empty or too long (max 4000 chars).' })

  const meta = flagInjection(content) ? { flagged: 'possible_prompt_injection' } : null
  if (typeof req.body?.apiKey === 'string') setSessionKey(session.id, req.body.apiKey)

  const event = addEvent(session.id, { type: 'user_message', author: user, content, meta })
  broadcast(session.id, { type: 'user_message', sessionId: session.id, event })

  let run = { ok: false, error: 'not_started' }
  if (!isRunning(session.id) && getSession(session.id).status !== 'paused') run = startRun(session.id)
  res.status(202).json({ event, run })
})

app.post('/api/sessions/:id/actions', (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found.' })
  const user = cleanUser(req.body)
  const ip = req.ip || 'unknown'
  if (rateLimited(`act:${ip}:${session.id}`, 30)) return res.status(429).json({ error: 'Too many actions. Slow down a little.' })
  const action = String(req.body?.action || '')

  if (action === 'pause') return res.json(pauseAgent(session.id, user))
  if (action === 'resume') return res.json(resumeAgent(session.id, user))
  if (action === 'stop') return res.json(stopAgent(session.id, user))
  if (action === 'redirect') {
    const instruction = cleanText(req.body?.content, MAX_REDIRECT_CHARS)
    if (!instruction) return res.status(400).json({ error: 'Redirect needs an instruction (max 500 chars).' })
    // A redirect becomes the team's next goal: flag it like any message.
    return res.json(redirectAgent(session.id, instruction, user, { flagged: flagInjection(instruction) }))
  }
  if (action === 'fork') {
    const upToEventId = Number.isInteger(req.body?.upToEventId) ? req.body.upToEventId : null
    // Fork with another architecture: same goal and board, a different team.
    const pattern = req.body?.pattern == null || req.body.pattern === '' ? null : String(req.body.pattern)
    if (pattern && !PATTERN_ORDER.includes(pattern)) return res.status(400).json({ error: `Unknown architecture "${pattern.slice(0, 40)}".` })
    // A fork is a new session: it counts against the same limit as creating one.
    if (rateLimited(`sess:${ip}`, RATE_LIMIT.maxSessions)) return res.status(429).json({ error: 'Too many sessions created. Wait a minute and try again.' })
    // The fork can bring its own turn-taking; clampConfig drops one the pattern does not offer.
    const turnTaking = typeof req.body?.turnTaking === 'string' ? req.body.turnTaking.slice(0, 40) : null
    const config = pattern ? mergeConfig(session.config, { crew: 'team', pattern, ...(turnTaking ? { turnTaking } : {}) }, session.provider) : null
    const name = cleanText(req.body?.name, 80) || (pattern ? `${session.name} (${PATTERNS[pattern].name})` : null)
    const fork = forkSession(session.id, { name, upToEventId, config, blackboard: getBoardSnapshot(session.id) })
    addEvent(fork.id, { type: 'system', content: `Forked from "${session.name}" by ${user.name}${pattern ? ` to try ${crewLabel(config)}` : ''}.` })
    logEvent(session.id, { type: 'fork', author: user, content: fork.name, meta: { forkedSessionId: fork.id, upToEventId, ...(pattern ? { pattern } : {}) } })
    broadcast(session.id, { type: 'session_forked', sessionId: session.id, newSession: fork, by: user })
    return res.json({ ok: true, session: fork })
  }

  // --- Agent team actions --------------------------------------------------
  if (action === 'pin') {
    const kind = String(req.body?.kind || '')
    if (!BOARD_KINDS.includes(kind)) return res.status(400).json({ error: `Pick a board section: ${BOARD_KINDS.join(', ')}.` })
    const content = cleanText(req.body?.content, MAX_PIN_CHARS + 1)
    if (!content || content.length > MAX_PIN_CHARS) return res.status(400).json({ error: `A pin needs 1 to ${MAX_PIN_CHARS} characters.` })
    // Flagged text is still pinned; the board shows agents it as data only.
    return res.json(pinBoard(session.id, { kind, content, flagged: flagInjection(content) }, user))
  }
  if (action === 'vote') {
    const option = cleanText(req.body?.option, 80)
    if (!option) return res.status(400).json({ error: 'A vote needs an option.' })
    return res.json(castVote(session.id, user, option))
  }
  if (action === 'escalation') {
    const escalationId = cleanText(req.body?.escalationId, 120)
    const decision = String(req.body?.decision || '')
    if (!escalationId || !['continue', 'wrap_up'].includes(decision)) return res.status(400).json({ error: 'An escalation needs an id and a decision: continue or wrap_up.' })
    return res.json(decideEscalation(session.id, escalationId, decision, user))
  }
  if (action === 'set_config') {
    const raw = req.body?.config
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ error: 'set_config needs a config object.' })
    const result = setConfig(session.id, raw, user)
    return res.status(result.ok ? 200 : 409).json(result)
  }
  res.status(400).json({ error: `Unknown action "${action}".` })
})

// ---------------------------------------------------------------------------
// Static client (production build) + SPA fallback
// ---------------------------------------------------------------------------
const distDir = path.join(__dirname, '..', 'client', 'dist')
if (fs.existsSync(distDir)) {
  // Hashed assets are immutable; index.html must always revalidate so a new
  // build is picked up on the next load instead of a stale cached shell.
  app.use(express.static(distDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      else res.setHeader('Cache-Control', 'no-cache')
      // A2A agent cards are discovery documents: other origins may read them.
      if (filePath.includes(`${path.sep}.well-known${path.sep}`) || filePath.includes(`${path.sep}agents${path.sep}`)) res.setHeader('Access-Control-Allow-Origin', '*')
    },
  }))
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(distDir, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => res.send('HiveMind server is running. Build the client with "npm run build", or use "npm run dev" for the dev server on :5173.'))
}

app.use((err, _req, res, _next) => {
  res.status(err?.status || 500).json({ error: err?.type === 'entity.parse.failed' ? 'Invalid JSON body.' : 'Server error.' })
})

// ---------------------------------------------------------------------------
// Boot with port fallback
// ---------------------------------------------------------------------------
const server = http.createServer(app)
attachWebSocket(server)

function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return null
}

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`Port ${port} is busy, trying ${port + 1}.`)
      console.warn(`  NOTE: with "npm run dev" the Vite proxy targets port ${Number(process.env.PORT) || 3000} and will NOT follow this fallback. Free that port or set PORT for both processes.`)
      listen(port + 1, attemptsLeft - 1)
    } else {
      console.error('Failed to start server:', err.message)
      process.exit(1)
    }
  })
  server.listen(port, () => {
    const lan = lanAddress()
    console.log('')
    console.log('  ┌──────────────────────────────────────────────┐')
    console.log('  │   HiveMind: Multiplayer AI Agents            │')
    console.log('  └──────────────────────────────────────────────┘')
    console.log(`   Local:    http://localhost:${port}`)
    if (lan) console.log(`   Network:  http://${lan}:${port}  (share on your WiFi)`)
    console.log('')
  })
}

process.on('uncaughtException', (err) => console.error('Uncaught exception (server kept alive):', err.message))
process.on('unhandledRejection', (err) => console.error('Unhandled rejection (server kept alive):', err?.message || err))

// Graceful shutdown (Ctrl+C, a host's stop signal): write the boards and team
// views still waiting on their coalesced save, then exit. A team that was
// working is closed as lost on the next boot, like after a crash.
function shutdown() {
  try { flushTeamSaves() } catch (err) { console.error('Shutdown save failed:', err?.message || err) }
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

// Before the first joiner can ask for a snapshot.
const recovered = recoverInterruptedViews()
if (recovered) console.log(`Closed ${recovered} team run${recovered === 1 ? '' : 's'} cut off by the last shutdown.`)

listen(Number(process.env.PORT) || 3000, 10)
