import React, { useId, useState } from 'react'
import { BOARD_KINDS } from '@shared/swarm/blackboard.js'
import { Markdown } from '../../lib/markdown'
import { boardItemCount } from './format'

const PIN_MAX = 200

// Section order on the board; `pin` is the label in the pin form.
const SECTIONS = [
  { kind: 'constraints', title: 'Constraints', pin: 'Constraint', empty: 'None yet. Constraints come only from people, and every agent must respect them.' },
  { kind: 'plan', title: 'Plan', pin: 'Plan step', empty: 'No plan yet.' },
  { kind: 'facts', title: 'Facts', pin: 'Fact', empty: 'No facts yet.' },
  { kind: 'questions', title: 'Questions', pin: 'Question', empty: 'No open questions.' },
  { kind: 'decisions', title: 'Decisions', pin: 'Decision', empty: 'No decisions yet.' },
]
const PIN_KINDS = SECTIONS.filter((s) => BOARD_KINDS.includes(s.kind))

function Author({ by, you }) {
  if (!by) return null
  const human = by.kind === 'human'
  const name = human && you?.id && by.id === you.id ? 'You' : by.name || (human ? 'A person' : 'Agent')
  return <span className={`hv-author ${human ? 'human' : 'agent'}`} title={human ? 'Pinned by a person' : 'Written by an agent'}>{name}</span>
}

function PinForm({ onAction, readOnly }) {
  const id = useId()
  const [kind, setKind] = useState('constraints')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const disabled = readOnly || !onAction

  const submit = async (e) => {
    e?.preventDefault()
    const content = text.trim().slice(0, PIN_MAX)
    if (!content || busy || disabled) return
    setBusy(true)
    setError(null)
    try {
      await onAction('pin', { kind, content })
      setText('')
    } catch (err) {
      setError(err?.message || 'Could not pin that. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="hv-pin" onSubmit={submit} aria-label="Pin to the board">
      <div className="hv-pin-row">
        <label className="hv-sr" htmlFor={`${id}-kind`}>Section</label>
        <span className="hv-select-wrap hv-pin-kind">
          <select id={`${id}-kind`} className="hv-select" value={kind} disabled={disabled} onChange={(e) => setKind(e.target.value)}>
            {PIN_KINDS.map((s) => <option key={s.kind} value={s.kind}>{s.pin}</option>)}
          </select>
        </span>
        <label className="hv-sr" htmlFor={`${id}-text`}>Text to pin</label>
        <input
          id={`${id}-text`}
          className="hv-pin-input"
          value={text}
          maxLength={PIN_MAX}
          disabled={disabled}
          placeholder={disabled ? 'Pinning is off in this view' : 'Pin something every agent will see'}
          onChange={(e) => { setText(e.target.value); if (error) setError(null) }}
          aria-describedby={`${id}-count`}
        />
        <button type="submit" className="btn btn-sm btn-human hv-pin-btn" disabled={disabled || busy || !text.trim()}>Pin</button>
      </div>
      <div className="hv-pin-meta">
        {error ? <span className="hv-error" role="alert">{error}</span> : <span>Enter pins it. Constraints bind every agent.</span>}
        <span id={`${id}-count`} className={`hv-pin-count${text.length >= PIN_MAX ? ' is-full' : ''}`}>{`${text.length}/${PIN_MAX}`}</span>
      </div>
    </form>
  )
}

function Answer({ board }) {
  const [open, setOpen] = useState(false)
  const final = typeof board.final === 'string' ? board.final.trim() : ''
  const draft = typeof board.draft === 'string' ? board.draft.trim() : ''
  const text = final || draft
  if (!text) {
    return (
      <section className="hv-sec">
        <div className="hv-sec-head"><h3 className="hv-sec-title">Draft</h3></div>
        <p className="hv-empty">The answer appears here as the team writes it.</p>
      </section>
    )
  }
  const long = text.length > 420
  return (
    <section className={`hv-sec hv-answer${final ? ' is-final' : ''}`}>
      <div className="hv-sec-head">
        <h3 className="hv-sec-title">{final ? 'Final answer' : 'Draft'}</h3>
        {final ? <span className="badge agent">Final</span> : <span className="badge">Working draft</span>}
      </div>
      <div className={`hv-answer-body${long && !open ? ' is-clamped' : ''}`}><Markdown text={text} /></div>
      {long && (
        <button type="button" className="hv-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </section>
  )
}

export function BlackboardPanel({ blackboard, onAction, readOnly = false, you }) {
  const board = blackboard && typeof blackboard === 'object' ? blackboard : {}
  const goal = typeof board.goal === 'string' ? board.goal.trim() : ''
  const total = boardItemCount(board)

  return (
    <div className="hv-board">
      <PinForm onAction={onAction} readOnly={readOnly} />

      <section className="hv-sec hv-goal">
        <div className="hv-sec-head"><h3 className="hv-sec-title">Goal</h3></div>
        {goal ? <p className="hv-goal-text">{goal}</p> : <p className="hv-empty">Set by the message that starts the run.</p>}
      </section>

      {total === 0 && (
        <p className="hv-board-hint">Agents write facts, questions and decisions here as they work. Anything you pin joins every agent’s prompt.</p>
      )}

      {SECTIONS.map((s) => {
        const items = Array.isArray(board[s.kind]) ? board[s.kind].filter((i) => i && typeof i.text === 'string') : []
        return (
          <section key={s.kind} className={`hv-sec${items.length ? '' : ' is-empty'}`} aria-label={s.title}>
            <div className="hv-sec-head">
              <h3 className="hv-sec-title">{s.title}</h3>
              <span className="hv-sec-count">{items.length}</span>
            </div>
            {items.length ? (
              <ul className="hv-items">
                {items.map((item, i) => (
                  <li key={item.id || `${s.kind}-${i}`} className={`hv-item${item.by?.kind === 'human' ? ' is-human' : ''}`}>
                    <span className="hv-item-text">{item.text}</span>
                    <Author by={item.by} you={you} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hv-empty">{s.empty}</p>
            )}
          </section>
        )
      })}

      <Answer board={board} />
    </div>
  )
}
