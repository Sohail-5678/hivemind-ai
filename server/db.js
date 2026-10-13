// SQLite persistence — Node's built-in sqlite, zero native dependencies.
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DB_PATH = process.env.HIVEMIND_DB || path.join(__dirname, 'data', 'hivemind.db')
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
}

const db = new DatabaseSync(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mode        TEXT NOT NULL DEFAULT 'live',
    status      TEXT NOT NULL DEFAULT 'idle',
    provider    TEXT NOT NULL DEFAULT 'simulated',
    model       TEXT,
    room_code   TEXT UNIQUE,
    forked_from TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    type         TEXT NOT NULL,
    author_id    TEXT,
    author_name  TEXT,
    author_color TEXT,
    content      TEXT,
    meta         TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
`)

// A restart orphans any in-flight run — reset stale statuses so sessions
// aren't reported as running with no live run behind them.
db.exec(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`)

// Room codes avoid ambiguous characters (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generateRoomCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return code
}

function rowToSession(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    status: row.status,
    provider: row.provider,
    model: row.model,
    roomCode: row.room_code,
    forkedFrom: row.forked_from,
    createdAt: row.created_at,
  }
}

function rowToEvent(row) {
  if (!row) return null
  let meta = null
  if (row.meta) {
    try { meta = JSON.parse(row.meta) } catch { meta = null }
  }
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    type: row.type,
    author: row.author_id ? { id: row.author_id, name: row.author_name, color: row.author_color } : null,
    content: row.content,
    meta,
    createdAt: row.created_at,
  }
}

export function createSession({ name, mode = 'live', provider = 'simulated', model = null, forkedFrom = null }) {
  const id = `sess_${randomUUID().slice(0, 12)}`
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateRoomCode()
    try {
      db.prepare(
        `INSERT INTO sessions (id, name, mode, provider, model, room_code, forked_from) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name, mode, provider, model, code, forkedFrom)
      return getSession(id)
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err
    }
  }
  throw new Error('could not allocate room code')
}

export function getSession(id) {
  return rowToSession(db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id))
}

export function getSessionByCode(code) {
  return rowToSession(db.prepare(`SELECT * FROM sessions WHERE room_code = ?`).get(String(code).toUpperCase()))
}

export function updateSessionStatus(id, status) {
  db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
}

export function addEvent(sessionId, { type, author = null, content = null, meta = null }) {
  const result = db.prepare(
    `INSERT INTO events (session_id, type, author_id, author_name, author_color, content, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId, type,
    author ? author.id : null,
    author ? author.name : null,
    author ? author.color : null,
    content,
    meta ? JSON.stringify(meta) : null
  )
  return getEvent(Number(result.lastInsertRowid))
}

export function getEvent(id) {
  return rowToEvent(db.prepare(`SELECT * FROM events WHERE id = ?`).get(id))
}

// Newest `limit` events in chronological order (a long-lived room must never
// freeze its snapshot at the first N rows).
export function getEvents(sessionId, { sinceId = 0, limit = 500 } = {}) {
  return db.prepare(
    `SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT ?`
  ).all(sessionId, sinceId, limit).map(rowToEvent).reverse()
}

// Fork: a new session that copies the timeline (optionally up to an event id).
export function forkSession(sourceId, { name, upToEventId = null, provider, model } = {}) {
  const source = getSession(sourceId)
  if (!source) return null
  const fork = createSession({
    name: name || `${source.name} (fork)`,
    mode: source.mode,
    provider: provider || source.provider,
    model: model || source.model,
    forkedFrom: source.id,
  })
  const rows = upToEventId
    ? db.prepare(`SELECT * FROM events WHERE session_id = ? AND id <= ? ORDER BY id ASC`).all(sourceId, upToEventId)
    : db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id ASC`).all(sourceId)
  const insert = db.prepare(
    `INSERT INTO events (session_id, type, author_id, author_name, author_color, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const row of rows) {
    insert.run(fork.id, row.type, row.author_id, row.author_name, row.author_color, row.content, row.meta, row.created_at)
  }
  return fork
}

export default db
