// Static-mode agent runner — executes in the host browser tab.
// Providers: simulated (zero-setup) and Groq via the /api/chat edge function
// (BYOK). Mirrors the server engine's contract: first-token deadline, empty-stream
// detection, and fallback to simulated so a session never hard-fails.
import { simulatedPlan, topicOf, lastUserText } from '@shared/simulated.js'

const FIRST_TOKEN_TIMEOUT_MS = 15_000

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

async function runSimulated({ messages, redirected, signal, onDelta, onTool }) {
  const topic = topicOf(lastUserText(messages))
  const plan = simulatedPlan(topic, redirected)
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

async function* streamGroqViaEdge({ messages, model, apiKey, signal }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model, apiKey }),
    signal,
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error || '' } catch { /* non-JSON */ }
    throw new Error(detail || `groq_http_${res.status}`)
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
    }
  }
}

// Resolves when the run completes; rejects with AbortError on abort.
export async function runClientAgent({ provider, model, apiKey, messages, redirected = false, signal, onDelta, onTool, onNotice }) {
  if (provider !== 'groq') return runSimulated({ messages, redirected, signal, onDelta, onTool })

  let text = ''
  const firstToken = new AbortController()
  const deadline = setTimeout(() => firstToken.abort(new Error('groq_first_token_timeout')), FIRST_TOKEN_TIMEOUT_MS)
  const providerSignal = AbortSignal.any([signal, firstToken.signal])
  try {
    for await (const delta of streamGroqViaEdge({ messages, model, apiKey, signal: providerSignal })) {
      clearTimeout(deadline)
      if (signal.aborted) throw abortError()
      text += delta
      onDelta(delta)
    }
    if (signal.aborted) throw abortError()
    if (!text) throw new Error('groq_empty_stream')
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) throw err
    if (!text) {
      onNotice?.(`Groq is unavailable (${String(err.message || err).slice(0, 90)}) — continuing with the built-in simulated agent.`)
      return runSimulated({ messages, redirected, signal, onDelta, onTool })
    }
    throw err
  } finally {
    clearTimeout(deadline)
  }
}
