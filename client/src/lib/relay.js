// Cross-device room transport for the static (no-backend) build.
//
// Every tab connects to several free public MQTT-over-WebSocket relays at once
// and publishes each frame to all of them; receivers de-duplicate by frame id.
// Two devices therefore meet as long as ANY relay is reachable from both.
// BroadcastChannel runs alongside for same-browser tabs and offline use.
//
// Frames are end-to-end encrypted: AES-GCM with a key derived from the room
// code via PBKDF2. The relay topic is derived from the same PBKDF2 output, so
// relay operators don't see the code or the content in the clear. The code is
// the only secret, though: each guess costs 100k PBKDF2 rounds, but the salt is
// fixed and a 6-character code has about 30 bits, so one precomputed table of
// every code would open every room. Treat room content as private from casual
// observers, not from a determined attacker.

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
const RECONNECT_MS = 3000          // first retry after a relay drops or refuses
const RECONNECT_MAX_MS = 60_000    // a relay this network never reached settles at one try a minute
const RECONNECT_DROPPED_MS = 15_000 // ...one that worked earlier is likely back soon: retry more often
const SEEN_LIMIT = 4000

// Public brokers cap packet size and not all of them document the cap, so no
// relay packet carries more than this much plaintext (AES-GCM adds 28 bytes).
// Larger frames (late-joiner snapshots, long final answers) travel as parts
// that the receiver reassembles. BroadcastChannel has no such limit and always
// carries whole frames.
export const MAX_PACKET_BYTES = 32 * 1024
const PART_ENVELOPE_BYTES = 256  // {"__src":…,"__seq":…,"__part":[i,n],"d":""} with room to spare
const MAX_PARTS = 64             // 2 MB per frame, far beyond anything the room sends
const MAX_PENDING_FRAMES = 16    // partially received frames kept at once
const PART_TTL_MS = 30_000
// A relay that lost a packet can hand over later frames before a slower relay
// fills the gap. Frames are held (per sender) for this long so they still
// arrive in the order they were posted; after that the gap is skipped.
const GAP_WAIT_MS = 1200
const SENDER_TTL_MS = 120_000

const enc = new TextEncoder()
const dec = new TextDecoder()

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// UTF-8 size of a string without allocating the encoded bytes.
export function utf8Length(str) {
  let n = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

// Splits serialized JSON into slices whose envelope stays under maxBytes once
// the slice is itself JSON-escaped. Never cuts between a surrogate pair.
function sliceByBytes(json, maxBytes) {
  const slices = []
  let start = 0
  let bytes = 0
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i)
    const low = c >= 0xdc00 && c <= 0xdfff
    let size
    if (c === 0x22 || c === 0x5c) size = 2 // `"` and `\` gain an escape inside the envelope
    else if (c < 0x20) size = 6            // can't appear in JSON text; counted escaped anyway
    else if (c < 0x80) size = 1
    else if (c < 0x800) size = 2
    else if (low) size = 1                 // a surrogate pair is 4 bytes, counted 3 + 1
    else size = 3
    if (bytes + size > maxBytes && i > start && !low) {
      slices.push(json.slice(start, i))
      start = i
      bytes = 0
    }
    bytes += size
  }
  slices.push(json.slice(start))
  return slices
}

// The plaintext packets for one frame: the frame itself when it fits, else
// parts tagged with the frame's own __src/__seq so de-duplication still works.
export function framePackets(frame, maxBytes = MAX_PACKET_BYTES) {
  const json = JSON.stringify(frame)
  if (utf8Length(json) <= maxBytes) return [json]
  const slices = sliceByBytes(json, maxBytes - PART_ENVELOPE_BYTES)
  if (slices.length > MAX_PARTS) return []
  return slices.map((d, i) => JSON.stringify({ __src: frame.__src, __seq: frame.__seq, __part: [i, slices.length], d }))
}

// Collects parts (from any relay, in any order, duplicates welcome) and returns
// the whole frame once the last part lands. Incomplete frames expire.
export function createReassembler({ maxParts = MAX_PARTS, maxPending = MAX_PENDING_FRAMES, ttlMs = PART_TTL_MS, now = Date.now } = {}) {
  const pending = new Map()
  const completed = new Set() // late duplicates of a finished frame (slower relays) start nothing new
  const complete = (key) => {
    completed.add(key)
    if (completed.size > maxPending * 8) completed.delete(completed.values().next().value)
  }
  return {
    accept(part) {
      const [i, n] = Array.isArray(part?.__part) ? part.__part : []
      if (!Number.isInteger(i) || !Number.isInteger(n) || n < 2 || n > maxParts || i < 0 || i >= n || typeof part.d !== 'string') return null
      const key = `${part.__src}:${part.__seq}`
      if (completed.has(key)) return null
      const t = now()
      for (const [k, entry] of pending) if (t - entry.at > ttlMs) pending.delete(k)
      let entry = pending.get(key)
      if (!entry) {
        if (pending.size >= maxPending) pending.delete(pending.keys().next().value)
        entry = { n, parts: new Array(n), got: 0, at: t }
        pending.set(key, entry)
      }
      if (entry.n !== n) return null
      if (entry.parts[i] === undefined) { entry.parts[i] = part.d; entry.got++ }
      if (entry.got < n) return null
      pending.delete(key)
      complete(key)
      try {
        const frame = JSON.parse(entry.parts.join(''))
        return frame && frame.__src === part.__src && frame.__seq === part.__seq ? frame : null
      } catch { return null }
    },
    get size() { return pending.size },
  }
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

// Opens one room channel. onMessage(frame, { src, seq }) receives decoded
// frames from OTHER tabs/devices only, in per-sender order, with the sending
// channel's id and the frame's sequence number. onGap(src) fires when frames
// from that sender were lost on every relay and skipped. onStatus({ relays,
// total }) reports how many relays are currently connected.
export function openRoomChannel(code, { onMessage, onStatus, onGap = null }) {
  const src = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const state = { closed: false, seq: 0, seen: new Set(), seenOrder: [], clients: [], bc: null, secrets: null }
  const parts = createReassembler()
  const wakers = [] // one per relay client: reconnect now if it's waiting out a backoff
  let sendChain = Promise.resolve()
  let recvChain = Promise.resolve()

  const remember = (id) => {
    if (state.seen.has(id)) return false
    state.seen.add(id)
    state.seenOrder.push(id)
    if (state.seenOrder.length > SEEN_LIMIT) state.seen.delete(state.seenOrder.shift())
    return true
  }

  const hand = (data, src, seq) => {
    if (state.closed) return
    try { onMessage(data, { src, seq }) } catch (err) { console.error('room frame handler failed:', err) }
  }

  // Per-sender ordering: { src, next, held: Map(seq → frame), timer, at }.
  const senders = new Map()
  const drain = (s) => {
    while (s.held.has(s.next)) {
      const seq = s.next
      const data = s.held.get(seq)
      s.held.delete(seq)
      s.next++
      hand(data, s.src, seq)
    }
    if (!s.held.size && s.timer) { clearTimeout(s.timer); s.timer = null }
  }
  const skipGap = (s) => {
    s.timer = null
    if (state.closed || !s.held.size) return
    s.next = Math.min(...s.held.keys())
    drain(s)
    if (s.held.size && !s.timer) s.timer = setTimeout(() => skipGap(s), GAP_WAIT_MS)
    // No relay delivered those frames: the room may want to resync.
    if (!state.closed) { try { onGap?.(s.src) } catch (err) { console.error('room gap handler failed:', err) } }
  }
  const inOrder = (from, seq, data) => {
    if (!Number.isInteger(seq)) { hand(data, from, seq); return }
    const now = Date.now()
    let s = senders.get(from)
    if (!s) {
      for (const [id, other] of senders) {
        if (now - other.at > SENDER_TTL_MS && !other.held.size) senders.delete(id)
      }
      s = { src: from, next: seq, held: new Map(), timer: null, at: now }
      senders.set(from, s)
    }
    s.at = now
    // Older than what we already handed on (sent before we first heard this
    // sender, or a gap we gave up on): late beats never.
    if (seq < s.next) { hand(data, from, seq); return }
    if (seq > s.next) {
      s.held.set(seq, data)
      if (!s.timer) s.timer = setTimeout(() => skipGap(s), GAP_WAIT_MS)
      return
    }
    s.next++
    hand(data, from, seq)
    drain(s)
  }

  const deliver = (frame) => {
    if (state.closed || !frame || frame.__src === src) return
    if (!remember(`${frame.__src}:${frame.__seq}`)) return
    const { __src, __seq, ...data } = frame
    inOrder(__src, __seq, data)
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

  // Packet from a relay: a whole frame, or one part of a larger frame.
  const receive = (packet) => {
    if (!packet || typeof packet !== 'object') return
    if (!packet.__part) { deliver(packet); return }
    if (packet.__src === src || state.seen.has(`${packet.__src}:${packet.__seq}`)) return
    const frame = parts.accept(packet)
    if (frame) deliver(frame)
  }

  const canEncrypt = typeof crypto !== 'undefined' && crypto.subtle && globalThis.isSecureContext
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
          client = mqtt.connect(relay.url, { connectTimeout: 7000, reconnectPeriod: RECONNECT_MS, keepalive: 45, clean: true, ...(relay.auth || {}) })
        } catch { continue }
        state.clients.push(client)
        // A relay this network can't reach would retry (and the browser would
        // log a failed socket) every few seconds for as long as the room is
        // open. Each failed attempt doubles the wait, up to a minute (15 s for
        // a relay that connected before); a connection resets it. The client
        // re-arms its timer from this option.
        let backoff = RECONNECT_MS
        let everConnected = false
        let waiting = false // closed, with the next attempt on a timer
        const setBackoff = (ms) => { backoff = ms; if (client.options) client.options.reconnectPeriod = ms }
        client.on('reconnect', () => { waiting = false; setBackoff(Math.min(everConnected ? RECONNECT_DROPPED_MS : RECONNECT_MAX_MS, backoff * 2)) })
        client.on('connect', () => { waiting = false; everConnected = true; setBackoff(RECONNECT_MS) })
        client.on('close', () => { waiting = true })
        // The device is back (network up, or the tab is in front again): try
        // now rather than when the backed-off timer fires. Coming to the front
        // only retries relays that worked before; a new network retries all.
        wakers.push((all) => {
          if (!waiting || client.connected || state.closed || (!all && !everConnected)) return
          waiting = false
          try { client.reconnect() } catch { return }
          setBackoff(RECONNECT_MS)
        })
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
              receive(JSON.parse(dec.decode(plain)))
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
    // Serialize now, so the relays carry exactly what BroadcastChannel carried.
    let packets
    try { packets = framePackets(frame) } catch { return }
    if (!packets.length) { console.warn(`room frame "${data?.t}" is too large for the relays and was sent to this browser only`); return }
    // Serialize encryption so frames leave in the order they were posted.
    sendChain = sendChain.then(async () => {
      const secrets = state.secrets || await secretsReady
      if (!secrets || state.closed) return
      for (const plain of packets) {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secrets.key, enc.encode(plain)))
        const packet = new Uint8Array(12 + cipher.length)
        packet.set(iv, 0)
        packet.set(cipher, 12)
        for (const client of state.clients) {
          try { client.publish(secrets.topic, packet, { qos: 0 }) } catch { /* queued or dropped */ }
        }
      }
    }).catch(() => {})
  }

  // For page unload. post() already hands the frame to BroadcastChannel
  // synchronously; the relays get it if the page lives long enough. One frame,
  // one sequence number: a second copy would leave remote peers a gap to wait out.
  const postNow = (data) => post(data)

  // A phone back from a dead zone or the background shouldn't sit out a long
  // backoff before it hears the room again.
  const wake = (all) => {
    if (state.closed) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    for (const fn of wakers) fn(all)
  }
  const onOnline = () => wake(true)
  const onVisible = () => wake(false)
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (hasWindow) window.addEventListener('online', onOnline)
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisible)

  const close = () => {
    if (state.closed) return
    if (hasWindow) window.removeEventListener('online', onOnline)
    if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisible)
    for (const s of senders.values()) if (s.timer) clearTimeout(s.timer)
    // Let queued frames (e.g. "bye") flush before tearing down.
    sendChain.finally(() => {
      state.closed = true
      for (const c of state.clients) { try { c.end(true) } catch { /* fine */ } }
      try { state.bc?.close() } catch { /* fine */ }
    })
  }

  return { post, postNow, close, ready }
}
