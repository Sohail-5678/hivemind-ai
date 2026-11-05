// The Blackboard (lecture: Group Chat pattern with structured shared state).
// Agents write tagged lines (FACT:, QUESTION:, DECISION:, PLAN:); humans pin
// constraints, facts, questions and decisions. Pure functions over plain data.
import { flagInjection, DATA_LABEL } from './guard.js'

export const BOARD_KINDS = ['constraints', 'plan', 'facts', 'questions', 'decisions']
const CAPS = { constraints: 10, plan: 10, facts: 14, questions: 8, decisions: 10 }
const ITEM_MAX = 240
const TEXT_MAX = 4000

const TAGS = {
  FACT: 'facts',
  QUESTION: 'questions',
  DECISION: 'decisions',
  PLAN: 'plan',
}
const TAG_LINE = /^\s*(?:[-*]\s*)?\**\s*(FACT|QUESTION|DECISION|PLAN)\s*\**\s*[:：]\s*(.+?)\s*$/i
const CONTROL_LINE = /^\s*(?:[-*]\s*)?\**\s*(VERDICT|VOTE|PROPOSAL)\s*\**\s*[:：]\s*(.+?)\s*$/i

export function emptyBoard() {
  return { goal: '', constraints: [], plan: [], facts: [], questions: [], decisions: [], draft: '', final: '', updatedAt: 0, seq: 0 }
}

export function normalizeBoard(b) {
  const base = emptyBoard()
  if (!b || typeof b !== 'object') return base
  const out = { ...base }
  out.goal = typeof b.goal === 'string' ? b.goal.slice(0, ITEM_MAX * 2) : ''
  for (const k of BOARD_KINDS) out[k] = Array.isArray(b[k]) ? b[k].filter((i) => i && typeof i.text === 'string').slice(-CAPS[k]) : []
  out.draft = typeof b.draft === 'string' ? b.draft.slice(0, TEXT_MAX) : ''
  out.final = typeof b.final === 'string' ? b.final.slice(0, TEXT_MAX) : ''
  out.updatedAt = Number(b.updatedAt) || 0
  out.seq = Number(b.seq) || 0
  return out
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, ITEM_MAX)
}

function similar(a, b) {
  const x = a.toLowerCase().replace(/[^a-z0-9 ]/g, '')
  const y = b.toLowerCase().replace(/[^a-z0-9 ]/g, '')
  return x === y || (x.length > 20 && (x.includes(y) || y.includes(x)))
}

// Returns a NEW board with the item added (deduped, capped). `by` is an author.
// `flagged` keeps text the Monitor flagged as a possible prompt injection on the
// board, but agents are shown it as data, never as an instruction.
export function addItem(board, kind, text, by, now = 0, { flagged = false } = {}) {
  if (!BOARD_KINDS.includes(kind)) return board
  const t = clean(text)
  if (!t) return board
  if (board[kind].some((i) => similar(i.text, t))) return board
  const seq = (board.seq || 0) + 1
  const item = { id: `${kind[0]}${seq}`, text: t, by: by ? { id: by.id, name: by.name, kind: by.kind || 'agent' } : null, at: now, ...(flagged ? { flagged: true } : {}) }
  const list = [...board[kind], item].slice(-CAPS[kind])
  return { ...board, [kind]: list, seq, updatedAt: now }
}

export function setText(board, field, text, now = 0) {
  if (field !== 'draft' && field !== 'final' && field !== 'goal') return board
  const max = field === 'goal' ? ITEM_MAX * 2 : TEXT_MAX
  return { ...board, [field]: String(text || '').trim().slice(0, max), updatedAt: now }
}

// Pull tagged lines out of an agent's output.
export function parseTags(text) {
  const items = []
  const control = {}
  for (const line of String(text || '').split('\n')) {
    const m = line.match(TAG_LINE)
    if (m) { items.push({ kind: TAGS[m[1].toUpperCase()], text: m[2].replace(/\**$/, '').trim() }); continue }
    const c = line.match(CONTROL_LINE)
    if (c) control[c[1].toLowerCase()] = c[2].replace(/\**$/, '').trim()
  }
  return { items, control }
}

// The prose a human should read: tagged lines removed (they show on the board).
export function stripTags(text) {
  const kept = String(text || '').split('\n').filter((l) => !TAG_LINE.test(l) && !CONTROL_LINE.test(l))
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function applyTags(board, text, by, now = 0) {
  const { items, control } = parseTags(text)
  let next = board
  for (const it of items) next = addItem(next, it.kind, it.text, by, now)
  return { board: next, items, control }
}

// Compact rendering for prompts, capped so it never crowds out the task.
export function renderBoard(board, { maxChars = 1800 } = {}) {
  const b = normalizeBoard(board)
  const flag = ` ${DATA_LABEL}`
  const sec = (title, list) => (list.length ? `${title}:\n${list.map((i) => `- ${i.text}${i.by?.kind === 'human' ? ` (pinned by ${i.by.name})` : ''}${i.flagged ? flag : ''}`).join('\n')}` : '')
  const parts = [
    b.goal ? `Goal: ${b.goal}${flagInjection(b.goal) ? flag : ''}` : '',
    sec('Constraints set by the humans (must be respected)', b.constraints),
    sec('Plan', b.plan),
    sec('Facts', b.facts),
    sec('Open questions', b.questions),
    sec('Decisions', b.decisions),
    b.draft ? `Current draft (excerpt):\n${b.draft.slice(0, 600)}` : '',
  ].filter(Boolean)
  let out = parts.join('\n\n')
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…(board truncated)'
  return out || '(the blackboard is empty)'
}

export function boardCounts(board) {
  const b = normalizeBoard(board)
  return { facts: b.facts.length, questions: b.questions.length, decisions: b.decisions.length, constraints: b.constraints.length, plan: b.plan.length, hasDraft: Boolean(b.draft), hasFinal: Boolean(b.final) }
}
