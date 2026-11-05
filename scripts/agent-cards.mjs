#!/usr/bin/env node
// Publishes HiveMind's A2A-style agent cards as static JSON, so any A2A client
// can discover the team the usual way:
//   /.well-known/agent-card.json   the HiveMind card, one skill per architecture
//   /agents/<role>.json            one card per agent role
// The cards are generated from the engine's role and pattern catalogs, so they
// can never drift from what the agents actually do. Runs before every client
// build ("prebuild"); the output is deterministic, so committed files only
// change when a role or a pattern changes. Discovery only: HiveMind does not
// expose an A2A RPC endpoint.
//
//   node scripts/agent-cards.mjs                 base https://hivemind-agents.vercel.app
//   AGENT_CARD_BASE=https://example.com node scripts/agent-cards.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLES, agentCard, hiveCard } from '../server/swarm/roles.js'
import { patternSkills } from '../server/swarm/patterns.js'

const DEFAULT_BASE = 'https://hivemind-agents.vercel.app'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'client', 'public')
const agentsDir = path.join(publicDir, 'agents')
const wellKnownDir = path.join(publicDir, '.well-known')

function baseUrl() {
  const raw = (process.env.AGENT_CARD_BASE || DEFAULT_BASE).trim().replace(/\/+$/, '')
  let url
  try { url = new URL(raw) } catch { url = null }
  if (!url || !/^https?:$/.test(url.protocol) || url.search || url.hash) {
    console.error(`agent-cards: AGENT_CARD_BASE must be an http(s) origin or path without a query, got "${raw}"`)
    process.exit(1)
  }
  return raw
}

// Writes only when the content changed, so builds don't touch mtimes needlessly.
function writeJSON(file, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (prev === text) return false
  fs.writeFileSync(file, text)
  return true
}

const base = baseUrl()
fs.mkdirSync(agentsDir, { recursive: true })
fs.mkdirSync(wellKnownDir, { recursive: true })

let changed = 0
if (writeJSON(path.join(wellKnownDir, 'agent-card.json'), hiveCard(base, patternSkills()))) changed++

const roles = Object.keys(ROLES).sort()
for (const role of roles) {
  if (writeJSON(path.join(agentsDir, `${role}.json`), agentCard(role, base))) changed++
}

// A role removed from the catalog must not stay discoverable.
let removed = 0
for (const file of fs.readdirSync(agentsDir)) {
  if (file.endsWith('.json') && !ROLES[file.slice(0, -5)]) {
    fs.unlinkSync(path.join(agentsDir, file))
    removed++
  }
}

console.log(`agent-cards: ${roles.length + 1} cards for ${base} (${changed} updated${removed ? `, ${removed} stale removed` : ''})`)
