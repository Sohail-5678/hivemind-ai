import React, { useRef, useState } from 'react'

export function Composer({ status, onSend, onAction, onTyping, onNotice, disabled, disabledHint }) {
  const [text, setText] = useState('')
  const [redirectOpen, setRedirectOpen] = useState(false)
  const [redirectText, setRedirectText] = useState('')
  const [busy, setBusy] = useState(false)
  const typingTimer = useRef(null)
  const isTyping = useRef(false)

  const running = status === 'running'
  const paused = status === 'paused'

  // Typing frames only on transitions (start / stop), never per keystroke.
  const stopTyping = () => {
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null }
    if (isTyping.current) { isTyping.current = false; onTyping && onTyping(false) }
  }

  const submit = async () => {
    const content = text.trim()
    if (!content || busy || disabled) return
    setBusy(true)
    setText('')
    try {
      await onSend(content)
    } catch (err) {
      setText(content)
      onNotice && onNotice(err.message)
    } finally {
      setBusy(false)
      stopTyping()
    }
  }

  const submitRedirect = async () => {
    const instruction = redirectText.trim()
    if (!instruction) return
    setRedirectOpen(false)
    setRedirectText('')
    try { await onAction('redirect', { content: instruction }) } catch (err) { onNotice && onNotice(err.message) }
  }

  const handleTyping = (value) => {
    setText(value)
    if (!onTyping) return
    if (!isTyping.current) { isTyping.current = true; onTyping(true) }
    if (typingTimer.current) clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(stopTyping, 1400)
  }

  const doAction = async (action) => {
    try { await onAction(action) } catch (err) { onNotice && onNotice(err.message) }
  }

  return (
    <div className="composer">
      <div className="action-row">
        <button className="action-btn warm" disabled={disabled} onClick={() => setRedirectOpen((v) => !v)} title="Steer the agent in a new direction — even mid-stream">
          ↪ Redirect
        </button>
        {running ? (
          <button className="action-btn" disabled={disabled} onClick={() => doAction('pause')} title="Pause the agent">⏸ Pause</button>
        ) : (
          <button className="action-btn" disabled={disabled || !paused} onClick={() => doAction('resume')} title="Resume from where it left off">▶ Resume</button>
        )}
        <button className="action-btn" disabled={disabled || !running} onClick={() => doAction('stop')} title="Stop the current run">◼ Stop</button>
        <button className="action-btn" disabled={disabled} onClick={() => doAction('fork')} title="Branch this session into a new one">⑂ Fork</button>
        {disabled && disabledHint && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{disabledHint}</span>}
      </div>

      {redirectOpen && (
        <div className="redirect-input-row">
          <input
            autoFocus
            placeholder="New direction for the agent… (it changes course immediately)"
            value={redirectText}
            maxLength={500}
            onChange={(e) => setRedirectText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitRedirect(); if (e.key === 'Escape') setRedirectOpen(false) }}
          />
          <button className="btn btn-red" onClick={submitRedirect}>Redirect</button>
        </div>
      )}

      <div className="input-row">
        <textarea
          rows={1}
          placeholder={disabled ? (disabledHint || 'Read-only') : 'Message the agent — everyone in the session sees it…'}
          value={text}
          maxLength={4000}
          disabled={disabled}
          onChange={(e) => handleTyping(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
        />
        <button className="btn btn-primary" disabled={disabled || busy || !text.trim()} onClick={submit}>Send</button>
      </div>
    </div>
  )
}
