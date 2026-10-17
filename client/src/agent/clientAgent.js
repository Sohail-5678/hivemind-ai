// Static-mode agent runner — executes in the host browser tab.
// Providers: simulated (zero-setup) and Groq via the /api/chat edge function
// (BYOK). Mirrors the server engine's contract: first-token deadline, empty-stream
// detection, and fallback to simulated so a session never hard-fails.
import { simulatedPlan, topicOf, lastUserText } from '@shared/simulated.js'

const FIRST_TOKEN_TIMEOUT_MS = 15_000
const FREE_FIRST_TOKEN_TIMEOUT_MS = 45_000 // the free tier queues up to ~30 s before streaming
const QUEUED_NOTICE_MS = 4_000

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


function abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError())
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()) }, { once: true })
})

export function systemPrompt(sessionName, participantNames) {
  const people = participantNames.length ? participantNames.join(', ') : 'the team'
  return [
    'You are HiveMind, a collaborative AI agent working inside a live shared session that multiple teammates can watch and steer in real time.',
    `Session: "${sessionName}". Participants currently present: ${people}.`,
    'Messages are prefixed with the name of the teammate who wrote them. Address people by name when it helps.',
    'When a teammate redirects you, immediately follow the new direction — acknowledge the change of course in one short sentence, then continue.',
    'Be concise, structured, and useful. Use short paragraphs and markdown lists where they help. You are doing real work the whole team can see.',
  ].join(' ')
}

export function buildMessages({ sessionName, participantNames, events, steering = null, maxEvents = 30 }) {
  const relevant = events.filter((e) => ['user_message', 'agent_message', 'redirect'].includes(e.type)).slice(-maxEvents)
  const messages = [{ role: 'system', content: systemPrompt(sessionName, participantNames) }]
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

async function runSimulated({ messages, redirected, signal, onDelta, onTool, fallback = false }) {
  const topic = topicOf(lastUserText(messages))
  const plan = simulatedPlan(topic, redirected, lastUserText(messages), { fallback })
  await sleep(500, signal)
  onTool('call', { tool: plan.tool.name, content: plan.tool.args.query })
  await sleep(1100, signal)
  onTool('result', { tool: plan.tool.name, content: plan.tool.result })
  await sleep(400, signal)
  // Pace by wall-clock, not one timer per word: browsers clamp timers in
  // background tabs to ~1/s, and the host tab is usually hidden while the user
  // watches the joiner tab. Each wake-up emits every word whose time has come.
  const words = plan.text.split(/(?<=\s)/)
  const schedule = []
  let t = 0
  for (let i = 0; i < words.length; i++) { t += 18 + Math.random() * 30; schedule.push(t) }
  const start = performance.now()
  let i = 0
  while (i < words.length) {
    if (signal.aborted) throw abortError()
    const elapsed = performance.now() - start
    while (i < words.length && schedule[i] <= elapsed) onDelta(words[i++])
    if (i < words.length) await sleep(Math.max(1, schedule[i] - (performance.now() - start)), signal)
  }
}

// One streamer for every OpenAI-compatible SSE endpoint. Yields text deltas,
// plus { alive: true } for chunks that carry no visible text (e.g. a reasoning
// model "thinking"), so the first-token deadline doesn't fire on a live stream.
async function* streamOpenAICompatible({ url, body, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let data = null
    try { data = await res.json() } catch { /* non-JSON */ }
    const err = new Error(data?.error?.message || data?.error || `http_${res.status}`)
    err.status = res.status
    err.retryAfter = Number(res.headers.get('retry-after')) || Number(String(data?.error?.message || '').match(/Retry after (\d+)s/)?.[1]) || null
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
      if (delta) yield delta
      else yield { alive: true }
    }
  }
}

const FREE_MODEL_URL = 'https://text.pollinations.ai/openai'
const MAX_COOLDOWN_WAITS = 2

function providerRequest(provider, { messages, model, apiKey }) {
  if (provider === 'free') {
    // Called straight from the host's browser (CORS-open), so the free tier's
    // per-IP limit applies to each host, not to one shared server address.
    return { url: FREE_MODEL_URL, body: { model: 'openai', messages, stream: true } }
  }
  return { url: '/api/chat', body: { messages, model, apiKey } }
}

const PROVIDER_LABEL = { free: 'The free model', groq: 'Groq' }

// Resolves when the run completes; rejects with AbortError on abort.
export async function runClientAgent({ provider, model, apiKey, messages, redirected = false, signal, onDelta, onTool, onNotice }) {
  if (provider !== 'groq' && provider !== 'free') return runSimulated({ messages, redirected, signal, onDelta, onTool })

  let text = ''
  // The free tier queues a request that exceeds "one reply every 30 s" rather
  // than rejecting it, so give it longer than the queue and say what's happening.
  const firstTokenMs = provider === 'free' ? FREE_FIRST_TOKEN_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS
  for (let attempt = 0; ; attempt++) {
    const firstToken = new AbortController()
    const deadline = setTimeout(() => firstToken.abort(new Error('first_token_timeout')), firstTokenMs)
    let started = false
    const queuedNotice = provider === 'free' ? setTimeout(() => {
      if (!started && !signal.aborted) onNotice?.('Queued — the free model allows one reply every 30 s. This answer will start shortly.')
    }, QUEUED_NOTICE_MS) : null
    const providerSignal = anySignal([signal, firstToken.signal])
    try {
      const { url, body } = providerRequest(provider, { messages, model, apiKey })
      for await (const chunk of streamOpenAICompatible({ url, body, signal: providerSignal })) {
        clearTimeout(deadline)
        started = true
        if (signal.aborted) throw abortError()
        if (typeof chunk !== 'string') continue
        text += chunk
        onDelta(chunk)
      }
      if (signal.aborted) throw abortError()
      if (!text) throw new Error('empty_stream')
      return
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) throw err
      // Free tier cooldown: wait it out visibly, then try again.
      const cooling = (err.status === 402 || err.status === 429) && err.retryAfter && err.retryAfter <= 45
      if (!text && cooling && attempt < MAX_COOLDOWN_WAITS) {
        onNotice?.(`${PROVIDER_LABEL[provider]} is cooling down (free tier: one reply every 30 s) — answering in ${err.retryAfter} s.`)
        await sleep(err.retryAfter * 1000 + 500, signal)
        continue
      }
      if (!text) {
        onNotice?.(`${PROVIDER_LABEL[provider]} is unavailable (${String(err.message || err).slice(0, 90)}) — continuing with the scripted demo agent.`)
        return runSimulated({ messages, redirected, signal, onDelta, onTool, fallback: true })
      }
      throw err
    } finally {
      clearTimeout(deadline)
      if (queuedNotice) clearTimeout(queuedNotice)
    }
  }
}
