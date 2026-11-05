// Robust JSON extraction from model output. Models wrap JSON in prose or code
// fences, add trailing commas, or use smart quotes; plans must never crash a run.

const MAX_STARTS = 24

export function extractJSON(text) {
  if (!text) return null
  const s = String(text).replace(/```(?:json)?/gi, '').trim()
  // Every plan schema is an object, so objects are tried first; prose before the
  // JSON may hold a stray bracket ("[two] notes"), so a start that does not
  // parse moves on to the next one.
  for (const open of ['{', '[']) {
    let start = s.indexOf(open)
    for (let n = 0; start >= 0 && n < MAX_STARTS; n++) {
      const parsed = parseFrom(s, start, open)
      if (parsed !== undefined) return parsed
      start = s.indexOf(open, start + 1)
    }
  }
  return null
}

// The value starting at `start`, or undefined when it does not parse.
function parseFrom(s, start, open) {
  const close = open === '{' ? '}' : ']'
  // Find the matching close bracket, respecting strings.
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) { depth--; if (depth === 0) { end = i; break } }
  }
  const candidate = end > 0 ? s.slice(start, end + 1) : s.slice(start)
  const attempts = [
    candidate,
    candidate.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    candidate.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1'),
  ]
  for (const a of attempts) {
    try { return JSON.parse(a) } catch { /* try next */ }
  }
  return undefined
}

export function asString(v, max = 200) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

export function asArray(v, max = 10) {
  return Array.isArray(v) ? v.slice(0, max) : []
}
