// Vercel Edge Function — streams a Groq chat completion for the static build.
// BYOK: the key arrives per request from the user's own browser, is forwarded
// once, and is never stored or logged. Same-origin only (no CORS headers).
export const config = { runtime: 'edge' }

const ALLOWED_MODELS = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3-32b',
])
const MAX_MESSAGES = 40
const MAX_CONTENT_CHARS = 8000

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

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

  let upstream
  try {
    upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, max_tokens: 1024, temperature: 0.7 }),
    })
  } catch (err) {
    return json({ error: `Could not reach Groq: ${String(err?.message || err).slice(0, 120)}` }, 502)
  }

  if (!upstream.ok) {
    let detail = ''
    try { detail = (await upstream.json())?.error?.message || '' } catch { /* non-JSON */ }
    const hint = upstream.status === 401 ? 'Invalid Groq API key.' : upstream.status === 429 ? 'Groq rate limit hit — wait a moment.' : 'Groq request failed.'
    return json({ error: `${hint} ${detail}`.trim().slice(0, 200) }, upstream.status)
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
