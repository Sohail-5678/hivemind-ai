// Agent execution engine — streaming runs with pause / redirect / resume / stop.
// Providers: simulated (zero-setup), ollama (local), groq (BYOK free tier).
// A provider failure before completion falls back to simulated so a session never hard-fails.
import { randomUUID } from 'node:crypto'
import { addEvent, getEvents, updateSessionStatus, getSession } from './db.js'
import { broadcast, participantsOf } from './websocket.js'
import { simulatedPlan, topicOf, lastUserText } from './simulated.js'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2'
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
const RUN_TIMEOUT_MS = 120_000
const FIRST_TOKEN_TIMEOUT_MS = 12_000
const MAX_CONTEXT_EVENTS = 30
const MAX_CONCURRENT_RUNS = 4
const FLUSH_MS = 90
const FLUSH_CHARS = 24

// AbortSignal.any is missing on older Safari (< 17.4) — combine signals by hand there.
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); break }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}


const runs = new Map()        // sessionId -> active run
const sessionKeys = new Map() // sessionId -> Groq key (BYOK — memory only, never persisted or logged)

export function setSessionKey(sessionId, apiKey) {
  if (typeof apiKey === 'string' && apiKey.trim()) sessionKeys.set(sessionId, apiKey.trim())
}

export function isRunning(sessionId) {
  return runs.has(sessionId)
}

export function agentStatus(sessionId) {
  const session = getSession(sessionId)
  if (!session) return 'unknown'
  if (runs.has(sessionId)) return 'running'
  return session.status === 'paused' ? 'paused' : 'idle'
}

// Snapshot of the in-flight run so late joiners see the text streamed so far.
export function getRunSnapshot(sessionId) {
  const run = runs.get(sessionId)
  if (!run) return null
  // Exclude bytes still sitting in run.pending: they arrive via the next agent_token flush.
  return { runId: run.id, text: run.text.slice(0, run.text.length - run.pending.length) }
}

const AGENT_AUTHOR = { id: 'agent', name: 'HiveMind', color: '#255DCE' }

function systemPrompt(session) {
  const people = participantsOf(session.id).map((p) => p.name).join(', ') || 'the team'
  return [
    'You are HiveMind, a collaborative AI agent working inside a live shared session that multiple teammates can watch and steer in real time.',
    `Session: "${session.name}". Participants currently present: ${people}.`,
    'Messages are prefixed with the name of the teammate who wrote them. Address people by name when it helps.',
    'When a teammate redirects you, immediately follow the new direction — acknowledge the change of course in one short sentence, then continue.',
    'Be concise, structured, and useful. Use short paragraphs and markdown lists where they help. You are doing real work the whole team can see.',
  ].join(' ')
}

function buildMessages(session, steering = null) {
  const events = getEvents(session.id, { limit: 1000 })
  const relevant = events.filter((e) => ['user_message', 'agent_message', 'redirect'].includes(e.type)).slice(-MAX_CONTEXT_EVENTS)
  const messages = [{ role: 'system', content: systemPrompt(session) }]
  for (const e of relevant) {
    if (e.type === 'agent_message') {
      if (e.content) messages.push({ role: 'assistant', content: e.content })
    } else if (e.type === 'redirect') {
      messages.push({ role: 'user', content: `[${e.author?.name || 'A teammate'} redirected the agent]: ${e.content}` })
    } else {
      messages.push({ role: 'user', content: `${e.author?.name || 'Teammate'}: ${e.content}` })
    }
  }
  if (steering) messages.push({ role: 'user', content: steering })
  return messages
}

// ---------------------------------------------------------------------------
// Provider adapters — each yields text deltas and honors the abort signal.
// ---------------------------------------------------------------------------

async function* streamOllama({ messages, model, signal }) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || OLLAMA_MODEL, messages, stream: true }),
    signal,
  })
  if (!res.ok) throw new Error(`ollama_http_${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    const lines = carry.split('\n')
    carry = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let json
      try { json = JSON.parse(line) } catch { continue }
      if (json.error) throw new Error(`ollama_${json.error}`)
      const delta = json.message?.content
      if (delta) yield delta
      if (json.done) return
    }
  }
}

async function* streamGroq({ messages, model, signal, apiKey }) {
  if (!apiKey) throw new Error('groq_missing_key')
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || GROQ_MODEL, messages, stream: true, max_tokens: 1024 }),
    signal,
  })
  if (!res.ok) throw new Error(`groq_http_${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    const lines = carry.split('\n')
    carry = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      let json
      try { json = JSON.parse(data) } catch { continue }
      const delta = json.choices?.[0]?.delta?.content
      if (delta) yield delta
    }
  }
}

const FREE_MODEL_URL = process.env.FREE_MODEL_URL || 'https://text.pollinations.ai/openai'

async function* streamFree({ messages, signal }) {
  const res = await fetch(FREE_MODEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages, stream: true }),
    signal,
  })
  if (!res.ok) {
    let data = null
    try { data = await res.json() } catch { /* non-JSON */ }
    const msg = data?.error?.message || data?.error || ''
    const err = new Error(`free_http_${res.status}`)
    err.status = res.status
    err.retryAfter = Number(res.headers.get('retry-after')) || Number(String(msg).match(/Retry after (\d+)s/)?.[1]) || null
    throw err
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    const lines = carry.split('\n')
    carry = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      let json
      try { json = JSON.parse(data) } catch { continue }
      const delta = json.choices?.[0]?.delta?.content
      // Reasoning chunks carry no text but prove the stream is alive.
      yield delta || ''
    }
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError())
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()) }, { once: true })
})

function abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export function startRun(sessionId, { steering = null, redirected = false } = {}) {
  const session = getSession(sessionId)
  if (!session) return { ok: false, error: 'session_not_found' }
  if (runs.has(sessionId)) return { ok: false, error: 'already_running' }
  if (runs.size >= MAX_CONCURRENT_RUNS) {
    broadcast(sessionId, { type: 'agent_error', sessionId, error: 'Too many agents running right now — try again in a moment.' })
    return { ok: false, error: 'capacity' }
  }

  const runId = `run_${randomUUID().slice(0, 8)}`
  const startEventId = getEvents(sessionId, { limit: 1 }).at(-1)?.id || 0
  const controller = new AbortController()
  const run = { id: runId, sessionId, controller, text: '', pending: '', flushTimer: null, abortReason: null, abortActor: null, followUpSteering: null, done: false }
  runs.set(sessionId, run)
  updateSessionStatus(sessionId, 'running')
  broadcast(sessionId, { type: 'session_status', sessionId, status: 'running' })
  broadcast(sessionId, { type: 'agent_started', sessionId, runId })

  const watchdog = setTimeout(() => abortRun(sessionId, 'timeout'), RUN_TIMEOUT_MS)

  const flush = () => {
    if (!run.pending) return
    broadcast(sessionId, { type: 'agent_token', sessionId, runId, delta: run.pending })
    run.pending = ''
  }
  const onDelta = (delta) => {
    run.text += delta
    run.pending += delta
    if (run.pending.length >= FLUSH_CHARS) flush()
    else if (!run.flushTimer) run.flushTimer = setTimeout(() => { run.flushTimer = null; flush() }, FLUSH_MS)
  }

  const finishRun = (status, extraMeta = null) => {
    if (run.done) return
    run.done = true
    clearTimeout(watchdog)
    if (run.flushTimer) clearTimeout(run.flushTimer)
    flush()
    runs.delete(sessionId)
    if (run.text.trim()) {
      const meta = { runId, provider: session.provider, ...(extraMeta || {}) }
      const event = addEvent(sessionId, { type: 'agent_message', author: AGENT_AUTHOR, content: run.text, meta })
      broadcast(sessionId, { type: 'agent_done', sessionId, runId, event, partial: Boolean(extraMeta?.partial) })
    } else {
      broadcast(sessionId, { type: 'agent_done', sessionId, runId, event: null, partial: Boolean(extraMeta?.partial) })
    }
    updateSessionStatus(sessionId, status)
    broadcast(sessionId, { type: 'session_status', sessionId, status })
  }

  ;(async () => {
    try {
      const messages = buildMessages(session, steering)
      await executeProvider(session, run, messages, { onDelta, redirected })
      finishRun('idle')
      // Answer teammates who messaged while the agent was busy.
      const queued = getEvents(sessionId, { sinceId: startEventId }).some((e) => e.type === 'user_message')
      if (queued) setImmediate(() => { if (!runs.has(sessionId) && getSession(sessionId)?.status !== 'paused') startRun(sessionId) })
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        const reason = run.abortReason || 'stop'
        if (reason === 'pause') {
          finishRun('paused', run.text.trim() ? { partial: true, reason: 'paused' } : null)
          broadcast(sessionId, { type: 'agent_paused', sessionId, by: run.abortActor || null })
        } else if (reason === 'redirect') {
          finishRun('idle', run.text.trim() ? { partial: true, reason: 'redirected' } : null)
          // Start the follow-up synchronously: the run slot is free (finishRun
          // just cleared it) and nothing can interleave on the event loop, so
          // the steering can neither be dropped nor preempted by a message.
          if (run.followUpSteering) startRun(sessionId, { steering: run.followUpSteering, redirected: true })
        } else if (reason === 'timeout') {
          finishRun('idle', run.text.trim() ? { partial: true, reason: 'timeout' } : null)
          broadcast(sessionId, { type: 'agent_error', sessionId, error: 'The run timed out and was stopped.' })
        } else {
          finishRun('idle', run.text.trim() ? { partial: true, reason: 'stopped' } : null)
        }
      } else {
        // Clean up first — reporting must never block the run slot from being released.
        finishRun('idle', run.text.trim() ? { partial: true, reason: 'error' } : null)
        addEvent(sessionId, { type: 'system', content: `Agent error: ${String(err.message || err).slice(0, 200)}` })
        broadcast(sessionId, { type: 'agent_error', sessionId, error: 'The agent hit an error and stopped. Send another message to retry.' })
      }
    }
  })().catch((err) => {
    // Last resort: a throw in the error path itself must never leak the run entry.
    console.error('run finalization error:', err?.message || err)
    clearTimeout(watchdog)
    runs.delete(sessionId)
    try { updateSessionStatus(sessionId, 'idle') } catch { /* db unavailable */ }
    broadcast(sessionId, { type: 'agent_error', sessionId, error: 'The agent hit an internal error and stopped.' })
    broadcast(sessionId, { type: 'session_status', sessionId, status: 'idle' })
  })

  return { ok: true, runId }
}

async function executeProvider(session, run, messages, { onDelta, redirected }) {
  const { signal } = run.controller
  const provider = session.provider || 'simulated'
  if (provider === 'simulated') return runSimulated(session, run, messages, { onDelta, redirected })

  // First-token deadline: a provider that hangs (rather than refuses) must
  // still trigger the fallback. Abort with a plain Error so the catch below
  // treats it as a provider failure, not a user abort.
  for (let attempt = 0; ; attempt++) {
  const firstToken = new AbortController()
  const deadline = setTimeout(() => firstToken.abort(new Error('provider_first_token_timeout')), FIRST_TOKEN_TIMEOUT_MS)
  const providerSignal = anySignal([signal, firstToken.signal])
  try {
    const stream = provider === 'ollama'
      ? streamOllama({ messages, model: session.model, signal: providerSignal })
      : provider === 'free'
        ? streamFree({ messages, signal: providerSignal })
        : streamGroq({ messages, model: session.model, signal: providerSignal, apiKey: sessionKeys.get(session.id) || process.env.GROQ_API_KEY })
    for await (const delta of stream) {
      clearTimeout(deadline)
      if (signal.aborted) throw abortError()
      if (delta) onDelta(delta)
    }
    if (signal.aborted) throw abortError()
    // A 200 response with no usable text is a provider failure, not a completed run.
    if (!run.text) throw new Error(`${provider}_empty_stream`)
    return
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) throw err
    const cooling = (err.status === 402 || err.status === 429) && err.retryAfter && err.retryAfter <= 45
    if (!run.text && cooling && attempt < 2) {
      broadcast(session.id, { type: 'agent_notice', sessionId: session.id, notice: `The free model is cooling down (one reply every 30 s) — answering in ${err.retryAfter} s.` })
      await sleep(err.retryAfter * 1000 + 500, signal)
      continue
    }
    if (!run.text) {
      broadcast(session.id, {
        type: 'agent_notice',
        sessionId: session.id,
        notice: `${provider === 'ollama' ? 'Ollama' : provider === 'free' ? 'The free model' : 'Groq'} is unavailable (${String(err.message || err).slice(0, 80)}) — continuing with the scripted demo agent.`,
      })
      return runSimulated(session, run, messages, { onDelta, redirected })
    }
    throw err
  } finally {
    clearTimeout(deadline)
  }
  }
}

async function runSimulated(session, run, messages, { onDelta, redirected }) {
  const { signal } = run.controller
  const topic = topicOf(lastUserText(messages))
  const plan = simulatedPlan(topic, redirected, lastUserText(messages))

  await sleep(500, signal)
  const callEvent = addEvent(session.id, { type: 'tool_call', author: AGENT_AUTHOR, content: plan.tool.args.query, meta: { tool: plan.tool.name, phase: 'call', runId: run.id } })
  broadcast(session.id, { type: 'agent_tool', sessionId: session.id, runId: run.id, tool: plan.tool.name, phase: 'call', event: callEvent })
  await sleep(1100, signal)
  const resultEvent = addEvent(session.id, { type: 'tool_result', author: AGENT_AUTHOR, content: plan.tool.result, meta: { tool: plan.tool.name, phase: 'result', runId: run.id } })
  broadcast(session.id, { type: 'agent_tool', sessionId: session.id, runId: run.id, tool: plan.tool.name, phase: 'result', event: resultEvent })
  await sleep(400, signal)

  const words = plan.text.split(/(?<=\s)/)
  for (const word of words) {
    if (signal.aborted) throw abortError()
    onDelta(word)
    await sleep(18 + Math.random() * 30, signal)
  }
}

export function abortRun(sessionId, reason, actor = null) {
  const run = runs.get(sessionId)
  if (!run) return false
  run.abortReason = reason
  run.abortActor = actor
  run.controller.abort()
  return true
}

// ---------------------------------------------------------------------------
// Actions — pause / resume / redirect / stop
// ---------------------------------------------------------------------------

export function pauseAgent(sessionId, actor) {
  const wasRunning = abortRun(sessionId, 'pause', actor)
  if (!wasRunning) {
    updateSessionStatus(sessionId, 'paused')
    broadcast(sessionId, { type: 'session_status', sessionId, status: 'paused' })
    broadcast(sessionId, { type: 'agent_paused', sessionId, by: actor })
  }
  addEvent(sessionId, { type: 'pause', author: actor })
  return { ok: true }
}

export function resumeAgent(sessionId, actor) {
  const session = getSession(sessionId)
  if (!session) return { ok: false, error: 'session_not_found' }
  addEvent(sessionId, { type: 'resume', author: actor })
  broadcast(sessionId, { type: 'agent_resumed', sessionId, by: actor })
  updateSessionStatus(sessionId, 'idle')
  return startRun(sessionId, {
    steering: `[${actor?.name || 'A teammate'} resumed the session]: Continue exactly where you left off. If your last message was cut off mid-thought, finish it, then keep going.`,
  })
}

export function redirectAgent(sessionId, instruction, actor) {
  const event = addEvent(sessionId, { type: 'redirect', author: actor, content: instruction })
  broadcast(sessionId, { type: 'user_redirected', sessionId, event, by: actor, instruction })
  const run = runs.get(sessionId)
  if (run) {
    // Hand the steering to the aborted run — its finalizer starts the follow-up
    // itself, so a pause/stop clicked after this redirect always wins (it
    // overwrites abortReason before the finalizer sees it).
    run.followUpSteering = `[${actor?.name || 'A teammate'} redirected you mid-run]: ${instruction}. Drop your previous direction and follow this immediately.`
    abortRun(sessionId, 'redirect', actor)
  } else {
    startRun(sessionId, {
      steering: `[${actor?.name || 'A teammate'} redirected you]: ${instruction}. Follow this new direction.`,
      redirected: true,
    })
  }
  return { ok: true, event }
}

export function stopAgent(sessionId, actor) {
  abortRun(sessionId, 'stop', actor)
  addEvent(sessionId, { type: 'system', content: `${actor?.name || 'A teammate'} stopped the agent.` })
  return { ok: true }
}
