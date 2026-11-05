import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { MentionChips } from './hive'

const MAX_MESSAGE_CHARS = 4000
const MAX_REDIRECT_CHARS = 500
const MAX_INPUT_PX = 168
const COUNT_FROM = 3200 // the character readout appears near the limit, not before

// Inline line icons for the session screens. One 16px grid, one stroke weight,
// currentColor, so they sit with the type instead of reading as emoji.
const ICONS = {
  redirect: <><path d="M3.5 3v3.5a3 3 0 0 0 3 3h6" /><path d="M10 6.5l3 3-3 3" /></>,
  pause: <path d="M5.75 3.5v9M10.25 3.5v9" />,
  play: <path d="M5.25 3.6v8.8L12.25 8z" fill="currentColor" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.6" />,
  fork: <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="11.5" cy="3.5" r="1.5" /><circle cx="8" cy="12.5" r="1.5" /><path d="M4.5 5v1a2.5 2.5 0 0 0 2.5 2.5h2A2.5 2.5 0 0 0 11.5 6V5M8 8.5V11" /></>,
  send: <><path d="M3 8h9.5" /><path d="M9 4.5L12.5 8 9 11.5" /></>,
  back: <><path d="M13 8H3.5" /><path d="M7 4.5L3.5 8 7 11.5" /></>,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  copy: <><rect x="5.5" y="5.5" width="7" height="7" rx="1.6" /><path d="M3.5 10V4.6a1.1 1.1 0 0 1 1.1-1.1H10" /></>,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  link: <><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6" /><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6" /></>,
  message: <path d="M3 4.6A1.6 1.6 0 0 1 4.6 3h6.8A1.6 1.6 0 0 1 13 4.6v4.8A1.6 1.6 0 0 1 11.4 11H7.2L4.2 13.2V11H4.6A1.6 1.6 0 0 1 3 9.4z" />,
  pin: <><path d="M5.5 2.5h5" /><path d="M6.5 2.5v3.6L4.5 9h7l-2-2.9V2.5" /><path d="M8 9v4.5" /></>,
  at: <><circle cx="8" cy="8" r="2.3" /><path d="M10.3 8v1a1.7 1.7 0 0 0 3.2.8A5.5 5.5 0 1 0 11 12.6" /></>,
  vote: <><rect x="2.75" y="3" width="10.5" height="10" rx="2" /><path d="M5.5 8.2l1.8 1.8 3.2-3.8" /></>,
  flag: <><path d="M4 13.5V2.75" /><path d="M4 3.25h7.75L10.25 6l1.5 2.75H4" /></>,
  rings: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.5" /></>,
}

export function Icon({ name, size = 16, className = '' }) {
  return (
    <svg
      className={`ws-icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name] || null}
    </svg>
  )
}

// The message well and run controls under every room. `team` switches the copy
// to the team; `mentionAgents` (team rooms) adds @role chips above the input.
export function Composer({
  status, onSend, onAction, onTyping, onNotice,
  disabled = false, disabledHint = '', placeholder = '', team = false, mentionAgents = null,
}) {
  const [text, setText] = useState('')
  const [redirectOpen, setRedirectOpen] = useState(false)
  const [redirectText, setRedirectText] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const redirectBtnRef = useRef(null)
  const typingTimer = useRef(null)
  const isTyping = useRef(false)
  const onTypingRef = useRef(onTyping)
  onTypingRef.current = onTyping
  const uid = useId()

  const running = status === 'running'
  const paused = status === 'paused'
  const who = team ? 'the team' : 'the agent'
  const showMentions = !disabled && Array.isArray(mentionAgents) && mentionAgents.length > 0

  const fieldPlaceholder = disabled
    ? (disabledHint || 'Read-only')
    : (placeholder || `Message ${who}. Everyone in the room sees it.`)

  // The well grows with the message (or a placeholder that wraps) up to a cap,
  // then scrolls. A new placeholder or a change of width re-measures it.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`
  }, [text, fieldPlaceholder, disabled])
  useEffect(() => {
    const el = inputRef.current
    if (!el || typeof ResizeObserver !== 'function') return undefined
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return // only a width change can re-wrap the text
      width = el.clientWidth
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Typing frames only on transitions (start / stop), never per keystroke.
  const stopTyping = () => {
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null }
    if (isTyping.current) { isTyping.current = false; onTypingRef.current?.(false) }
  }
  useEffect(() => stopTyping, []) // leaving the room never strands a "typing" dot

  // A read-only switch mid-edit closes the redirect row instead of leaving it orphaned.
  useEffect(() => { if (disabled) setRedirectOpen(false) }, [disabled])

  const handleTyping = (value) => {
    setText(value)
    if (!onTypingRef.current) return
    if (!value) { stopTyping(); return }
    if (!isTyping.current) { isTyping.current = true; onTypingRef.current(true) }
    if (typingTimer.current) clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(stopTyping, 1400)
  }

  const submit = async () => {
    const content = text.trim()
    if (!content || busy || disabled || !onSend) return
    setBusy(true)
    setText('')
    try {
      await onSend(content)
    } catch (err) {
      setText(content) // nothing typed is lost on a failed send
      onNotice?.(err?.message || 'That message didn’t send. Try again.')
    } finally {
      setBusy(false)
      stopTyping()
    }
  }

  const closeRedirect = () => {
    setRedirectOpen(false)
    setRedirectText('')
    requestAnimationFrame(() => redirectBtnRef.current?.focus())
  }

  const submitRedirect = async (e) => {
    e?.preventDefault()
    const instruction = redirectText.trim()
    if (!instruction || disabled || !onAction) return
    closeRedirect()
    try { await onAction('redirect', { content: instruction }) } catch (err) { onNotice?.(err?.message || 'The redirect didn’t go through.') }
  }

  const doAction = async (action) => {
    if (!onAction) return
    try { await onAction(action) } catch (err) { onNotice?.(err?.message || 'That didn’t go through. Try again.') }
  }

  // Insert "@role " at the caret (or over the selection), with a space before it
  // when it would otherwise glue onto a word, then put the caret after it.
  const insertMention = (handle) => {
    if (!handle || disabled) return
    const el = inputRef.current
    const start = el ? el.selectionStart : text.length
    const end = el ? el.selectionEnd : text.length
    const before = text.slice(0, start)
    const after = text.slice(end)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    const token = `@${handle}${/^\s/.test(after) ? '' : ' '}`
    const next = `${before}${lead}${token}${after}`
    if (next.length > MAX_MESSAGE_CHARS) { onNotice?.('The message is at its length limit.'); return }
    handleTyping(next)
    const caret = before.length + lead.length + token.length
    requestAnimationFrame(() => {
      const node = inputRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  const onInputKeyDown = (e) => {
    // Never send mid-composition (IME input for Chinese, Japanese, Korean…).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const count = text.length

  return (
    <div className={`composer${disabled ? ' is-readonly' : ''}`}>
      <div className="action-row" role="group" aria-label="Run controls">
        <button
          ref={redirectBtnRef}
          type="button"
          className="action-btn redirect"
          aria-expanded={redirectOpen}
          aria-controls={redirectOpen ? `${uid}-redirect` : undefined}
          disabled={disabled}
          onClick={() => (redirectOpen ? closeRedirect() : setRedirectOpen(true))}
          title={`Steer ${who} in a new direction, even mid-answer`}
        >
          <Icon name="redirect" /><span>Redirect</span>
        </button>
        {paused ? (
          <button type="button" className="action-btn" disabled={disabled} onClick={() => doAction('resume')} title="Resume from where it stopped">
            <Icon name="play" /><span>Resume</span>
          </button>
        ) : (
          <button type="button" className="action-btn" disabled={disabled || !running} onClick={() => doAction('pause')} title={`Pause ${who}`}>
            <Icon name="pause" /><span>Pause</span>
          </button>
        )}
        <button type="button" className="action-btn stop" disabled={disabled || !running} onClick={() => doAction('stop')} title="Stop the current run">
          <Icon name="stop" /><span>Stop</span>
        </button>
        <button type="button" className="action-btn" disabled={disabled} onClick={() => doAction('fork')} title="Branch this room into a new one">
          <Icon name="fork" /><span>Fork</span>
        </button>
        {disabled && disabledHint && <span className="composer-hint">{disabledHint}</span>}
      </div>

      {redirectOpen && (
        <form id={`${uid}-redirect`} className="redirect-input-row" onSubmit={submitRedirect}>
          <label className="label-mono" htmlFor={`${uid}-redirect-input`}>New direction</label>
          <input
            id={`${uid}-redirect-input`}
            autoFocus
            placeholder={`${team ? 'The team changes' : 'It changes'} course right away…`}
            value={redirectText}
            maxLength={MAX_REDIRECT_CHARS}
            autoComplete="off"
            onChange={(e) => setRedirectText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeRedirect() } }}
          />
          <button type="submit" className="btn btn-human btn-sm" disabled={!redirectText.trim()}>Redirect</button>
          <button type="button" className="composer-dismiss" aria-label="Cancel redirect" onClick={closeRedirect}>
            <Icon name="close" />
          </button>
        </form>
      )}

      {showMentions && (
        <div className="composer-mentions">
          <span className="label-mono" aria-hidden="true">Ask</span>
          <MentionChips agents={mentionAgents} onPick={insertMention} />
        </div>
      )}

      <div className="input-row">
        <div className="composer-well">
          <textarea
            ref={inputRef}
            rows={1}
            aria-label={`Message ${who}`}
            aria-describedby={`${uid}-keys`}
            placeholder={fieldPlaceholder}
            value={text}
            maxLength={MAX_MESSAGE_CHARS}
            disabled={disabled}
            onChange={(e) => handleTyping(e.target.value)}
            onKeyDown={onInputKeyDown}
            onBlur={stopTyping}
          />
          <div className="composer-meta">
            <span id={`${uid}-keys`} className="composer-keys">
              <kbd>Enter</kbd> to send <span className="composer-keys-sep" aria-hidden="true" /> <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
            </span>
            {count >= COUNT_FROM && (
              <span className={`composer-count${count >= MAX_MESSAGE_CHARS ? ' at-limit' : ''}`}>{count}/{MAX_MESSAGE_CHARS}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary composer-send"
          aria-label="Send message"
          disabled={disabled || busy || !text.trim()}
          onClick={submit}
        >
          <span className="composer-send-label">{busy ? 'Sending' : 'Send'}</span>
          <Icon name="send" />
        </button>
      </div>
    </div>
  )
}
