import React from 'react'
import { glyph } from './format'

// @mention shortcuts above the composer. `handle` is the role id, which the
// engine matches against every agent of that role.
export function MentionChips({ agents, onPick, disabled = false }) {
  const list = (Array.isArray(agents) ? agents : []).filter((a) => a && a.role)
  if (!list.length) return null
  return (
    <div className="hv-mentions" role="group" aria-label="Mention an agent">
      {list.map((a) => (
        <button
          key={a.role}
          type="button"
          className="hv-mention"
          disabled={disabled || typeof onPick !== 'function'}
          // Keep focus (and the caret) in the composer when clicked with a pointer.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(a.role)}
          title={a.description || undefined}
          aria-label={`Mention the ${a.name || a.role}`}
        >
          <span className="hv-mention-glyph" aria-hidden="true">{glyph(a.glyph)}</span>
          <span className="hv-mention-handle">{`@${a.role}`}</span>
        </button>
      ))}
    </div>
  )
}
