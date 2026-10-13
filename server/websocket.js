// WebSocket room manager — presence, typing, and event broadcasting per session.
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { getSession, getEvents, addEvent } from './db.js'
// Circular with agent.js is fine: both sides only call at runtime.
import { agentStatus, getRunSnapshot } from './agent.js'

// Presence palette drawn from the HiveMind theme (cobalt / red / sky / tints).
const PRESENCE_COLORS = ['#4F8FE8', '#E85D55', '#9DB8FF', '#DE1110', '#7B61FF', '#2BB3A3', '#F0A23B', '#C56BD6']

const rooms = new Map() // sessionId -> Set<client>
let colorCursor = 0

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(payload)) } catch { /* connection died mid-send */ }
  }
}

export function broadcast(sessionId, payload, { except = null } = {}) {
  const room = rooms.get(sessionId)
  if (!room) return
  for (const client of room) {
    if (client === except) continue
    safeSend(client.ws, payload)
  }
}

export function participantsOf(sessionId) {
  const room = rooms.get(sessionId)
  if (!room) return []
  return [...room].map((c) => ({ id: c.user.id, name: c.user.name, color: c.user.color, typing: c.typing || false }))
}

function joinRoom(client, sessionId) {
  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set())
  rooms.get(sessionId).add(client)
  client.sessionId = sessionId
}

function leaveRoom(client) {
  const { sessionId } = client
  if (!sessionId) return
  const room = rooms.get(sessionId)
  if (room) {
    room.delete(client)
    if (room.size === 0) rooms.delete(sessionId)
  }
  client.sessionId = null
}

export function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try { pathname = new URL(req.url, 'http://localhost').pathname } catch { /* bad url */ }
    if (pathname !== '/ws') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws) => {
    const client = { ws, user: null, sessionId: null, typing: false, alive: true }
    // Per-connection guardrails: REST is IP-rate-limited, so WS frames must be
    // limited too or join/typing spam amplifies into DB writes + broadcasts.
    const budget = { window: Date.now(), count: 0, joins: 0 }

    ws.on('pong', () => { client.alive = true })

    ws.on('message', (raw) => {
      if (raw.length > 16 * 1024) return
      const now = Date.now()
      if (now - budget.window > 10_000) {
        budget.window = now
        budget.count = 0
        budget.joins = 0
      }
      if (++budget.count > 40) return
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!msg || typeof msg.type !== 'string') return
      if (msg.type === 'join' && ++budget.joins > 5) {
        safeSend(ws, { type: 'error', error: 'too_many_joins' })
        return
      }

      if (msg.type === 'join') {
        const session = getSession(String(msg.sessionId || ''))
        if (!session) {
          safeSend(ws, { type: 'error', error: 'session_not_found' })
          return
        }
        if (client.sessionId) announceLeave(client)
        const name = String(msg.user?.name || 'Guest').slice(0, 40) || 'Guest'
        const requestedId = typeof msg.user?.id === 'string' && msg.user.id.length <= 40 ? msg.user.id : null
        client.user = {
          id: requestedId || `u_${randomUUID().slice(0, 8)}`,
          name,
          color: msg.user?.color && /^#[0-9A-Fa-f]{6}$/.test(msg.user.color)
            ? msg.user.color
            : PRESENCE_COLORS[colorCursor++ % PRESENCE_COLORS.length],
        }
        joinRoom(client, session.id)
        addEvent(session.id, { type: 'join', author: client.user })
        // Snapshot for the joiner: session, timeline, who's here, and the
        // in-flight run so a mid-stream joiner sees the text streamed so far.
        safeSend(ws, {
          type: 'joined',
          session,
          you: client.user,
          participants: participantsOf(session.id),
          events: getEvents(session.id),
          agentStatus: agentStatus(session.id),
          streaming: getRunSnapshot(session.id),
        })
        broadcast(session.id, {
          type: 'presence',
          participants: participantsOf(session.id),
          joined: client.user,
        }, { except: client })
        return
      }

      if (!client.sessionId || !client.user) return

      if (msg.type === 'typing') {
        client.typing = Boolean(msg.isTyping)
        broadcast(client.sessionId, { type: 'presence', participants: participantsOf(client.sessionId) }, { except: client })
        return
      }

      if (msg.type === 'leave') announceLeave(client)
    })

    ws.on('close', () => announceLeave(client))
    ws.on('error', () => announceLeave(client))
  })

  function announceLeave(client) {
    const { sessionId, user } = client
    if (!sessionId) return
    leaveRoom(client)
    if (user) {
      addEvent(sessionId, { type: 'leave', author: user })
      broadcast(sessionId, { type: 'presence', participants: participantsOf(sessionId), left: user })
    }
  }

  // Heartbeat: drop dead connections so presence stays truthful.
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const client of room) {
        if (!client.alive) {
          try { client.ws.terminate() } catch { /* already gone */ }
          continue
        }
        client.alive = false
        try { client.ws.ping() } catch { /* already gone */ }
      }
    }
  }, 30_000)
  heartbeat.unref()

  return wss
}
