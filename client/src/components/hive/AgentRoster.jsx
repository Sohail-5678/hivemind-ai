import React, { useState } from 'react'
import { ROLES } from '@shared/swarm/roles.js'
import { AgentCardModal } from './AgentCardModal'
import { plannedTeam } from './roster'
import { agentState, glyph, tail, teamOf } from './format'

// Every agent on the team with what it is doing right now. Before the first run
// it lists the planned team for the room's architecture.
export function AgentRoster({ swarm, config, provider = 'simulated', onOpen }) {
  const [local, setLocal] = useState(null)
  const live = teamOf(swarm)
  const agents = live.length ? live : plannedTeam(config, provider)
  const open = onOpen || setLocal

  if (!agents.length) return <p className="hv-empty">No agents yet.</p>

  return (
    <>
      {!live.length && <p className="hv-roster-note">The planned team. Each agent joins when the run reaches its step.</p>}
      <ul className="hv-roster">
        {agents.map((a) => {
          const state = agentState(a, swarm)
          const base = ROLES[a.role]
          const full = a.name || base?.name || 'Agent'
          const role = base && base.name !== full ? base.name : null
          const [, focus] = full.split(' · ')
          const name = focus && role ? focus : full
          return (
            <li key={a.id} className={`hv-agent is-${state.key}`}>
              <span className="hv-agent-disc" aria-hidden="true">{glyph(a.glyph || base?.glyph)}</span>
              <div className="hv-agent-main">
                <div className="hv-agent-top">
                  <span className="hv-agent-name">{name}</span>
                  {role && <span className="hv-agent-role">{role}</span>}
                  {a.count > 1 && <span className="hv-agent-role">{`× ${a.count}`}</span>}
                  <span className={`hv-status is-${state.key}`}>
                    {state.key === 'live' && <span className="dot live" aria-hidden="true" />}
                    {state.label}
                  </span>
                </div>
                {a.task
                  ? <p className="hv-agent-task" title={a.task}>{a.task}</p>
                  : <p className="hv-agent-task is-quiet">{a.description || base?.description || ''}</p>}
                {a.stream && state.key === 'live' && (
                  <p className="hv-agent-stream">{tail(a.stream, 140)}<span className="hv-caret" aria-hidden="true" /></p>
                )}
              </div>
              <button type="button" className="btn btn-sm btn-ghost hv-agent-card" onClick={() => open(a)} aria-label={`Open the agent card for ${full}`}>
                Card
              </button>
            </li>
          )
        })}
      </ul>
      {!onOpen && <AgentCardModal agent={local} onClose={() => setLocal(null)} />}
    </>
  )
}
