import React from 'react'

function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
}

export function PresenceBar({ sessionName, participants, you, status, connection }) {
  const statusLabel = status === 'running' ? 'Agent working' : status === 'paused' ? 'Paused' : 'Idle'
  const names = participants.map((p) => (p.id === you?.id ? `${p.name} (you)` : p.name)).join(', ')

  return (
    <div className="presence-bar">
      <span className="session-name">{sessionName}</span>
      <div className="avatars">
        {participants.map((p) => (
          <div
            key={p.id}
            className={`avatar${p.typing ? ' typing' : ''}`}
            style={{ background: p.color }}
            title={p.id === you?.id ? `${p.name} (you)` : p.name}
          >
            {initials(p.name)}
          </div>
        ))}
      </div>
      <span className="presence-names">{names}</span>
      <div className={`status-chip ${status}`}>
        <span className="dot" />
        {connection === 'closed' ? 'Reconnecting…' : connection === 'connecting' ? 'Connecting…' : statusLabel}
      </div>
    </div>
  )
}
