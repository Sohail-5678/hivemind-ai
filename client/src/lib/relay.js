// Cross-device room transport for the static (no-backend) build.
//
// Every tab connects to several free public MQTT-over-WebSocket relays at once
// and publishes each frame to all of them; receivers de-duplicate by frame id.
// Two devices therefore meet as long as ANY relay is reachable from both.
// BroadcastChannel runs alongside for same-browser tabs and offline use.
//
// Frames are end-to-end encrypted: AES-GCM with a key derived from the room
// code via PBKDF2. The relay topic is derived from the same PBKDF2 output, so
// relay operators see neither the code nor the content, and brute-forcing a
// 6-character code costs 100k PBKDF2 rounds per guess.

// Mixed ports on purpose: three relays on 8xxx and one on 443, the standard
// HTTPS port, so rooms still connect on Wi-Fi that blocks non-standard ports.
const RELAYS = [
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://test.mosquitto.org:8081/mqtt' },
  { url: 'wss://public.cloud.shiftr.io:443', auth: { username: 'public', password: 'public' } },
]
const PBKDF2_ROUNDS = 100_000
const READY_TIMEOUT_MS = 8000
const SEEN_LIMIT = 4000

const enc = new TextEncoder()
const dec = new TextDecoder()

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function deriveRoomSecrets(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(code).toUpperCase()), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('hivemind-relay-v1'), iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    base,
    512,
  ))
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { key, topic: `hivemind/v1/${hex(bits.slice(32, 48))}` }
}

// Opens one room channel. onMessage(frame) receives decoded frames from OTHER
// tabs/devices only, in per-sender order. onStatus({ relays, total }) reports
// how many relays are currently connected.
export function openRoomChannel(code, { onMessage, onStatus }) {
  const src = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const state = { closed: false, seq: 0, seen: new Set(), seenOrder: [], clients: [], bc: null, secrets: null }
  let sendChain = Promise.resolve()
  let recvChain = Promise.resolve()

  const remember = (id) => {
    if (state.seen.has(id)) return false
    state.seen.add(id)
    state.seenOrder.push(id)
    if (state.seenOrder.length > SEEN_LIMIT) state.seen.delete(state.seenOrder.shift())
    return true
  }

  const deliver = (frame) => {
    if (state.closed || !frame || frame.__src === src) return
    if (!remember(`${frame.__src}:${frame.__seq}`)) return
    const { __src, __seq, ...data } = frame
    try { onMessage(data) } catch (err) { console.error('room frame handler failed:', err) }
  }

  const reportStatus = () => {
    const relays = state.clients.filter((c) => c.connected).length
    onStatus?.({ relays, total: RELAYS.length })
  }

  // Same-browser path: instant and works with no network.
  try {
    state.bc = new BroadcastChannel(`hivemind:${String(code).toUpperCase()}`)
    state.bc.onmessage = ({ data }) => deliver(data)
  } catch { /* very old browser — relays only */ }

  const canEncrypt = typeof crypto !== 'undefined' && crypto.subtle && window.isSecureContext
  const secretsReady = canEncrypt ? deriveRoomSecrets(code).catch(() => null) : Promise.resolve(null)

  const ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ relays: 0 }), READY_TIMEOUT_MS)
    secretsReady.then(async (secrets) => {
      if (state.closed) return
      state.secrets = secrets
      if (!secrets) { clearTimeout(timer); resolve({ relays: 0 }); reportStatus(); return }
      // Loaded on demand so the landing page doesn't pay for the MQTT client.
      let mqtt
      try { mqtt = (await import('mqtt')).default } catch { clearTimeout(timer); resolve({ relays: 0 }); reportStatus(); return }
      if (state.closed) return
      for (const relay of RELAYS) {
        let client
        try {
          client = mqtt.connect(relay.url, { connectTimeout: 7000, reconnectPeriod: 3000, keepalive: 45, clean: true, ...(relay.auth || {}) })
        } catch { continue }
        state.clients.push(client)
        client.on('connect', () => {
          client.subscribe(secrets.topic, { qos: 0 }, () => {
            reportStatus()
            clearTimeout(timer)
            resolve({ relays: state.clients.filter((c) => c.connected).length })
          })
        })
        client.on('close', reportStatus)
        client.on('error', () => { /* reconnect handles it; status reflects reality */ })
        client.on('message', (_topic, payload) => {
          const bytes = new Uint8Array(payload)
          if (bytes.length < 13) return
          recvChain = recvChain.then(async () => {
            try {
              const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, secrets.key, bytes.slice(12))
              deliver(JSON.parse(dec.decode(plain)))
            } catch { /* wrong key or corrupted frame — ignore */ }
          })
        })
      }
    })
  })

  const post = (data) => {
    if (state.closed) return
    const frame = { ...data, __src: src, __seq: state.seq++ }
    try { state.bc?.postMessage(frame) } catch { /* closed */ }
    // Serialize encryption so frames leave in the order they were posted.
    sendChain = sendChain.then(async () => {
      const secrets = state.secrets || await secretsReady
      if (!secrets || state.closed) return
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secrets.key, enc.encode(JSON.stringify(frame))))
      const packet = new Uint8Array(12 + cipher.length)
      packet.set(iv, 0)
      packet.set(cipher, 12)
      for (const client of state.clients) {
        try { client.publish(secrets.topic, packet, { qos: 0 }) } catch { /* queued or dropped */ }
      }
    }).catch(() => {})
  }

  // Best-effort synchronous send for page unload (BroadcastChannel only).
  const postNow = (data) => {
    try { state.bc?.postMessage({ ...data, __src: src, __seq: state.seq++ }) } catch { /* closed */ }
    post(data)
  }

  const close = () => {
    if (state.closed) return
    // Let queued frames (e.g. "bye") flush before tearing down.
    sendChain.finally(() => {
      state.closed = true
      for (const c of state.clients) { try { c.end(true) } catch { /* fine */ } }
      try { state.bc?.close() } catch { /* fine */ }
    })
  }

  return { post, postNow, close, ready }
}
