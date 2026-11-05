// Vercel Edge Function — streams a Groq chat completion for the static build.
// BYOK: the key arrives per request from the user's own browser, is forwarded
// once, and is never stored or logged.
//
// Only this site's own pages are served: a request must come from the same
// origin (browsers always send Origin, and Sec-Fetch-Site, on a POST), and no
// CORS headers are sent, so other sites can't read a reply either. That stops
// other pages and casual scripts, not a determined client, which can set those
// headers itself; capping heavy use per IP needs a platform rate limit.
export const config = { runtime: 'edge' }

const ALLOWED_MODELS = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3-32b',
])
const MAX_MESSAGES = 40
// Agent-team prompts run to about 9,000 characters with the task at the END, so
// the cap must sit above that: truncating the tail would drop the agent's task.
const MAX_CONTENT_CHARS = 10_000
const MAX_TOKENS = { min: 64, max: 1200, fallback: 1024 }

// Agents ask for short replies (a 160-token route, a 750-token final answer).
function clampMaxTokens(value) {
  const n = Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return MAX_TOKENS.fallback
  return Math.max(MAX_TOKENS.min, Math.min(MAX_TOKENS.max, Math.round(n)))
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function sameOrigin(req) {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return false
  let origin
  try { origin = new URL(req.headers.get('origin') || '').host } catch { return false }
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host
  return Boolean(origin) && origin === host
}

// Groq says when a rate-limited key may retry in headers, and at the end of a
// long message ("Please try again in 7.22s"). Both reach the browser, so the
// host tab waits the limit out instead of falling back at once.
const RATE_HEADERS = ['retry-after', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']
const RETRY_IN = /try again in ((?:\d+m(?!s))?[\d.]+(?:ms|s))\b/i

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!sameOrigin(req)) return json({ error: 'This endpoint only serves the HiveMind app on this site.' }, 403)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body.' }, 400) }

  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey.startsWith('gsk_') || apiKey.length > 200) {
    return json({ error: 'A Groq API key (gsk_…) is required. Get a free one at console.groq.com.' }, 400)
  }

  const messages = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : null
  if (!messages || !messages.length) return json({ error: 'messages[] required.' }, 400)
  for (const m of messages) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      return json({ error: 'Malformed message.' }, 400)
    }
    m.content = m.content.slice(0, MAX_CONTENT_CHARS)
  }
  const model = ALLOWED_MODELS.has(body?.model) ? body.model : 'llama-3.1-8b-instant'
  const maxTokens = clampMaxTokens(body?.maxTokens)

  let upstream
  try {
    upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, temperature: 0.7 }),
    })
  } catch (err) {
    return json({ error: `Could not reach Groq: ${String(err?.message || err).slice(0, 120)}` }, 502)
  }

  if (!upstream.ok) {
    let detail = ''
    try { detail = String((await upstream.json())?.error?.message || '') } catch { /* non-JSON */ }
    const retryIn = detail.match(RETRY_IN)?.[1]
    const hint = upstream.status === 401 ? 'Invalid Groq API key.'
      : upstream.status === 429 ? (retryIn ? `Groq rate limit hit. Try again in ${retryIn}.` : 'Groq rate limit hit. Wait a moment and try again.')
        : 'Groq request failed.'
    const headers = {}
    for (const name of RATE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) headers[name] = value.slice(0, 40)
    }
    return json({ error: `${hint} ${detail}`.trim().slice(0, 200) }, upstream.status, headers)
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
