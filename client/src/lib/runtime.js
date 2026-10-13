// Runtime mode detection.
//   server  — the Node server is present (local `npm start`): real WebSocket rooms,
//             cross-device multiplayer, Ollama / Groq / simulated agents.
//   static  — a static deployment (Vercel): the same UI, with multiplayer across
//             browser tabs via BroadcastChannel and agents running in the host tab
//             (simulated, or Groq through the /api/chat edge function).
import { useEffect, useState } from 'react'

let cached = null

export function detectRuntime() {
  if (cached) return cached
  cached = (async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1800)
      const res = await fetch('/api/health', { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        const data = await res.json().catch(() => null)
        if (data?.realtime === 'ws') return { mode: 'server' }
      }
    } catch { /* no server → static */ }
    return { mode: 'static' }
  })()
  return cached
}

export function useRuntime() {
  const [runtime, setRuntime] = useState(null)
  useEffect(() => {
    let alive = true
    detectRuntime().then((r) => { if (alive) setRuntime(r) })
    return () => { alive = false }
  }, [])
  return runtime
}
