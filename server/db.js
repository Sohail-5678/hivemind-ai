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

// v2 columns: the room's crew config and its shared blackboard (both JSON).
// ADD COLUMN keeps database files created by v1 working without a rebuild.
const sessionColumns = new Set(db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name))
for (const column of ['config', 'blackboard']) {
  if (!sessionColumns.has(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`)
}

// A restart orphans any in-flight run — reset stale statuses so sessions
// aren't reported as running with no live run behind them.
db.exec(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`)

// Session reads skip the blackboard: it can be several KB and is only needed
// by snapshots, which load it on their own (getSessionBlackboard).
const SESSION_COLUMNS = 'id, name, mode, status, provider, model, room_code, forked_from, created_at, config'

// Room codes avoid ambiguous characters (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generateRoomCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return code
}

function parseJSON(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

// Sessions created before v2 have no config: they are single-agent rooms.
function parseConfig(text) {
  const parsed = parseJSON(text)
  return isPlainObject(parsed) ? { crew: 'single', ...parsed } : { crew: 'single' }
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
    config: parseConfig(row.config),
    createdAt: row.created_at,
  }
}

// Team agents carry glyph / kind / role on their author. The events table only
// has id, name and colour columns, so the extras ride in meta.authorExtra and are
// merged back here: readers always see them on `author`, never in meta.
const AUTHOR_EXTRA_KEYS = ['glyph', 'kind', 'role']

function authorExtraOf(author) {
  if (!author) return null
  const extra = {}
  for (const key of AUTHOR_EXTRA_KEYS) {
    if (typeof author[key] === 'string' && author[key]) extra[key] = author[key]
  }
  return Object.keys(extra).length ? extra : null
}

function rowToEvent(row) {
  if (!row) return null
  let meta = parseJSON(row.meta)
  let author = row.author_id ? { id: row.author_id, name: row.author_name, color: row.author_color } : null
  if (isPlainObject(meta) && 'authorExtra' in meta) {
    const { authorExtra, ...rest } = meta
    if (author && isPlainObject(authorExtra)) author = { ...author, ...authorExtra }
    meta = Object.keys(rest).length ? rest : null
  }
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    type: row.type,
    author,
    content: row.content,
    meta,
    createdAt: row.created_at,
  }
}

export function createSession({ name, mode = 'live', provider = 'simulated', model = null, forkedFrom = null, config = null }) {
  const id = `sess_${randomUUID().slice(0, 12)}`
  const configJson = isPlainObject(config) ? JSON.stringify(config) : null
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateRoomCode()
    try {
      db.prepare(
        `INSERT INTO sessions (id, name, mode, provider, model, room_code, forked_from, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name, mode, provider, model, code, forkedFrom, configJson)
      return getSession(id)
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err
    }
  }
  throw new Error('could not allocate room code')
}

export function getSession(id) {
  return rowToSession(db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id))
}

export function getSessionByCode(code) {
  return rowToSession(db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE room_code = ?`).get(String(code).toUpperCase()))
}

export function updateSessionStatus(id, status) {
  db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
}

// Callers sanitize first (agent.js sanitizeConfig); this only stores it.
export function updateSessionConfig(id, config) {
  db.prepare(`UPDATE sessions SET config = ? WHERE id = ?`).run(isPlainObject(config) ? JSON.stringify(config) : null, id)
  return getSession(id)
}

// The room's shared blackboard (pins, facts, decisions). null until first used.
export function getSessionBlackboard(id) {
  const row = db.prepare(`SELECT blackboard FROM sessions WHERE id = ?`).get(id)
  const board = parseJSON(row?.blackboard)
  return isPlainObject(board) ? board : null
}

export function updateSessionBlackboard(id, board) {
  db.prepare(`UPDATE sessions SET blackboard = ? WHERE id = ?`).run(isPlainObject(board) ? JSON.stringify(board) : null, id)
}

export function addEvent(sessionId, { type, author = null, content = null, meta = null }) {
  const extra = authorExtraOf(author)
  const stored = extra ? { ...(isPlainObject(meta) ? meta : {}), authorExtra: extra } : meta
  const result = db.prepare(
    `INSERT INTO events (session_id, type, author_id, author_name, author_color, content, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId, type,
    author ? author.id : null,
    author ? author.name : null,
    author ? author.color : null,
    content,
    stored ? JSON.stringify(stored) : null
  )
  return getEvent(Number(result.lastInsertRowid))
}

export function getEvent(id) {
  return rowToEvent(db.prepare(`SELECT * FROM events WHERE id = ?`).get(id))
}

// Shallow-merges `patch` into an event's meta (e.g. marking the answer a Critic
// approved as the run's final). Returns the updated event, or null if missing.
export function patchEventMeta(id, patch) {
  const row = db.prepare(`SELECT meta FROM events WHERE id = ?`).get(id)
  if (!row) return null
  const current = parseJSON(row.meta)
  const meta = { ...(isPlainObject(current) ? current : {}), ...patch }
  db.prepare(`UPDATE events SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), id)
  return getEvent(id)
}

// Newest `limit` events in chronological order (a long-lived room must never
// freeze its snapshot at the first N rows).
export function getEvents(sessionId, { sinceId = 0, limit = 500 } = {}) {
  return db.prepare(
    `SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT ?`
  ).all(sessionId, sinceId, limit).map(rowToEvent).reverse()
}

// Newest `limit` events of the given types in (sinceId, beforeId], oldest first.
// Team runs read their goal, prompt history and the humans' mid-run messages
// with it, without deserializing everything else in the room.
export function getEventsOfType(sessionId, types, { limit = 50, sinceId = 0, beforeId = null } = {}) {
  const list = [...new Set(types)].filter((t) => typeof t === 'string')
  if (!list.length) return []
  const marks = list.map(() => '?').join(', ')
  return db.prepare(
    `SELECT * FROM events WHERE session_id = ? AND type IN (${marks}) AND id > ? AND id <= ? ORDER BY id DESC LIMIT ?`
  ).all(sessionId, ...list, sinceId, beforeId ?? Number.MAX_SAFE_INTEGER, limit).map(rowToEvent).reverse()
}

// Fork: a new session that copies the timeline (optionally up to an event id)
// and the blackboard. `config` overrides the source's crew config (fork with
// another architecture); `blackboard` overrides the stored copy, so a fork taken
// mid-run gets the live board rather than the last debounced save.
export function forkSession(sourceId, { name, upToEventId = null, provider, model, config = null, blackboard } = {}) {
  const source = getSession(sourceId)
  if (!source) return null
  const board = blackboard === undefined ? getSessionBlackboard(sourceId) : blackboard
  const rows = upToEventId
    ? db.prepare(`SELECT * FROM events WHERE session_id = ? AND id <= ? ORDER BY id ASC`).all(sourceId, upToEventId)
    : db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id ASC`).all(sourceId)
  const insert = db.prepare(
    `INSERT INTO events (session_id, type, author_id, author_name, author_color, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  // One transaction: a long timeline copies in a single write, and a failure
  // never leaves a half-copied fork behind.
  db.exec('BEGIN')
  try {
    const fork = createSession({
      name: name || `${source.name} (fork)`,
      mode: source.mode,
      provider: provider || source.provider,
      model: model || source.model,
      forkedFrom: source.id,
      config: config || source.config,
    })
    if (board) updateSessionBlackboard(fork.id, board)
    for (const row of rows) {
      insert.run(fork.id, row.type, row.author_id, row.author_name, row.author_color, row.content, row.meta, row.created_at)
    }
    db.exec('COMMIT')
    return fork
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export default db
