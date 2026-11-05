import React, { useEffect, useId, useState } from 'react'
import { useNow } from './hooks'
import { clock } from './format'

const KIND = {
  budget: { title: 'The team reached its call budget', cont: 'Continue (+4 calls)' },
  loop: { title: 'The team is repeating itself', cont: 'Continue' },
}

// The Monitor never acts on its own: it stops and asks the room. If no one
// answers before the deadline it takes the default (usually wrap up).
export function EscalationBanner({ escalation, onAction, readOnly = false }) {
  const domId = useId()
  const [sent, setSent] = useState(null)
  const [error, setError] = useState(null)
  const id = escalation?.escalationId
  const now = useNow(Boolean(id), 500)
  useEffect(() => { setSent(null); setError(null) }, [id])
  if (!escalation || !id) return null

  const k = KIND[escalation.kind] || { title: 'The Monitor needs a decision', cont: 'Continue' }
  const left = Math.max(0, (Number(escalation.deadline) || 0) - now)
  const fallback = escalation.defaultDecision === 'continue' ? 'continue' : 'wrap up'
  const disabled = readOnly || typeof onAction !== 'function' || sent !== null

  const decide = async (decision) => {
    if (disabled) return
    setSent(decision)
    setError(null)
    try {
      await onAction('escalation', { escalationId: id, decision })
    } catch (err) {
      setSent(null)
      setError(err?.message || 'That did not reach the team. Try again.')
    }
  }

  return (
    <section className="hv-esc" aria-labelledby={`${domId}-t`}>
      <span className="hv-esc-mark" aria-hidden="true">
        <svg width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="15" /><circle cx="17" cy="17" r="9" /><path d="M17 12.5 V18" /><circle cx="17" cy="21.6" r="1.1" /></svg>
      </span>
      <div className="hv-esc-body">
        <span className="label-mono">Monitor</span>
        {/* The alert wraps the heading so the title keeps its heading role. */}
        <div role="alert"><h2 id={`${domId}-t`} className="hv-esc-title">{k.title}</h2></div>
        {escalation.reason && <p className="hv-esc-reason">{escalation.reason}</p>}
        <p className="hv-esc-timer">
          {sent
            ? `Sent: ${sent === 'continue' ? 'continue' : 'wrap up'}. Waiting for the team.`
            : left > 0 ? <>If no one answers, the team will {fallback} in <span className="hv-mono" aria-hidden="true">{clock(left)}</span><span className="hv-sr">{`${Math.ceil(left / 1000)} seconds`}</span></> : `No answer yet, so the team will ${fallback}.`}
        </p>
        {error && <p className="hv-error" role="alert">{error}</p>}
      </div>
      <div className="hv-esc-actions">
        <button type="button" className={`btn btn-sm btn-primary${sent === 'continue' ? ' pressed' : ''}`} disabled={disabled} onClick={() => decide('continue')}>{k.cont}</button>
        <button type="button" className={`btn btn-sm${sent === 'wrap_up' ? ' pressed' : ''}`} disabled={disabled} onClick={() => decide('wrap_up')}>Wrap up</button>
      </div>
    </section>
  )
}
