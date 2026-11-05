// WebSocket room manager — presence, typing, and event broadcasting per session.
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { getSession, getEvents, addEvent } from './db.js'
// Circular with agent.js is fine: both sides only call at runtime.
import { agentStatus, getRunSnapshot, getSwarmSnapshot } from './agent.js'
// Presence colours stay in the human (rose and sand) family; agents are sage.
import { HUMAN_COLORS } from './palette.js'

const rooms = new Map() // sessionId -> Set<client>
let colorCursor = 0

// A dropped socket (refresh, phone switching networks) gets a short grace
// before it counts as leaving. A rejoin with the same user id inside the grace
// cancels the leave, so a refresh writes no "left" / "joined" pair.
const LEAVE_GRACE_MS = Number(process.env.HIVEMIND_LEAVE_GRACE_MS) || 8000
const pendingLeaves = new Map() // `${sessionId}:${userId}` -> timer

// `data` is a payload object or an already-serialized frame.
function safeSend(ws, data) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)) } catch { /* connection died mid-send */ }
  }
}

export function broadcast(sessionId, payload, { except = null } = {}) {
  const room = rooms.get(sessionId)
  if (!room) return
  // Serialize once per message, not once per client: team runs stream tokens
  // from several agents to every client in the room.
  const frame = JSON.stringify(payload)
  for (const client of room) {
    if (client === except) continue
    safeSend(client.ws, frame)
  }
}

export function participantsOf(sessionId) {
  const room = rooms.get(sessionId)
  if (!room) return []
  return [...room].map((c) => ({ id: c.user.id, name: c.user.name, color: c.user.color, typing: c.typing || false }))
}

// How many connections in the room carry this user id (one person, several tabs).
function connectionsOf(sessionId, userId) {
  const room = rooms.get(sessionId)
  if (!room) return 0
  let n = 0
  for (const c of room) if (c.user?.id === userId) n++
  return n
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
        if (client.sessionId) announceLeave(client, { now: true })
        const name = String(msg.user?.name || 'Guest').slice(0, 40) || 'Guest'
        const requestedId = typeof msg.user?.id === 'string' && msg.user.id.length <= 40 ? msg.user.id : null
        client.user = {
          id: requestedId || `u_${randomUUID().slice(0, 8)}`,
          name,
          color: msg.user?.color && /^#[0-9A-Fa-f]{6}$/.test(msg.user.color)
            ? msg.user.color
            : HUMAN_COLORS[colorCursor++ % HUMAN_COLORS.length],
        }
        joinRoom(client, session.id)
        const graceKey = `${session.id}:${client.user.id}`
        const returning = pendingLeaves.has(graceKey) || connectionsOf(session.id, client.user.id) > 1
        if (pendingLeaves.has(graceKey)) {
          clearTimeout(pendingLeaves.get(graceKey))
          pendingLeaves.delete(graceKey)
        }
        if (!returning) addEvent(session.id, { type: 'join', author: client.user })
        // Snapshot for the joiner: session, timeline, who's here, the
        // in-flight run so a mid-stream joiner sees the text streamed so far,
        // and the agent team's view (graph, roster, vote, monitor) + blackboard.
        const { swarm, blackboard } = getSwarmSnapshot(session.id)
        safeSend(ws, {
          type: 'joined',
          session,
          you: client.user,
          participants: participantsOf(session.id),
          events: getEvents(session.id),
          agentStatus: agentStatus(session.id),
          streaming: getRunSnapshot(session.id),
          swarm,
          blackboard,
        })
        broadcast(session.id, {
          type: 'presence',
          participants: participantsOf(session.id),
          ...(returning ? {} : { joined: client.user }),
        }, { except: client })
        return
      }

      if (!client.sessionId || !client.user) return

      if (msg.type === 'typing') {
        client.typing = Boolean(msg.isTyping)
        // A lost/dropped "stopped typing" frame must never pin the indicator on.
        if (client.typingTimer) clearTimeout(client.typingTimer)
        if (client.typing) {
          client.typingTimer = setTimeout(() => {
            client.typing = false
            client.typingTimer = null
            if (client.sessionId) broadcast(client.sessionId, { type: 'presence', participants: participantsOf(client.sessionId) }, { except: client })
          }, 5000)
        }
        broadcast(client.sessionId, { type: 'presence', participants: participantsOf(client.sessionId) }, { except: client })
        return
      }

      if (msg.type === 'leave') announceLeave(client, { now: true })
    })

    ws.on('close', () => announceLeave(client))
    ws.on('error', () => announceLeave(client))
  })

  // An explicit leave (the Leave button, switching rooms) is immediate; a
  // dropped socket waits out LEAVE_GRACE_MS first.
  function announceLeave(client, { now = false } = {}) {
    const { sessionId, user } = client
    if (client.typingTimer) { clearTimeout(client.typingTimer); client.typingTimer = null }
    if (!sessionId) return
    leaveRoom(client)
    if (!user) return
    const graceKey = `${sessionId}:${user.id}`
    const finish = () => {
      pendingLeaves.delete(graceKey)
      // Still here in another tab: nobody left.
      if (connectionsOf(sessionId, user.id) > 0) return
      if (!getSession(sessionId)) return
      addEvent(sessionId, { type: 'leave', author: user })
      broadcast(sessionId, { type: 'presence', participants: participantsOf(sessionId), left: user })
    }
    if (pendingLeaves.has(graceKey)) clearTimeout(pendingLeaves.get(graceKey))
    if (now) { finish(); return }
    // The presence bar updates at once; the timeline line waits for the grace.
    broadcast(sessionId, { type: 'presence', participants: participantsOf(sessionId) })
    const timer = setTimeout(finish, LEAVE_GRACE_MS)
    timer.unref?.()
    pendingLeaves.set(graceKey, timer)
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
