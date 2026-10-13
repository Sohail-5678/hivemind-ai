// Thin REST client for server mode. Same-origin in production; Vite proxies /api in dev.

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data
}

export const api = {
  health: () => request('/api/health'),
  providers: () => request('/api/providers'),
  createSession: (body) => request('/api/sessions', { method: 'POST', body }),
  joinByCode: (code) => request('/api/join', { method: 'POST', body: { code } }),
  getSession: (id) => request(`/api/sessions/${id}`),
  sendMessage: (id, body) => request(`/api/sessions/${id}/messages`, { method: 'POST', body }),
  action: (id, body) => request(`/api/sessions/${id}/actions`, { method: 'POST', body }),
}

export function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws`
}
