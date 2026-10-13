import React, { useEffect, useRef, useState } from 'react'
import { Markdown } from '../lib/markdown'

function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
}

function timeOf(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

function EventItem({ event, you }) {
  const { type, author, content, meta } = event

  if (type === 'system' || type === 'join' || type === 'leave' || type === 'pause' || type === 'resume') {
    const label =
      type === 'join' ? `${author?.name} joined the session` :
      type === 'leave' ? `${author?.name} left` :
      type === 'pause' ? `${author?.name} paused the agent` :
      type === 'resume' ? `${author?.name} resumed the agent` :
      content
    return <div className="tl-system"><span className="pill">{label}</span></div>
  }
  if (type === 'redirect') {
    return (
      <div className="tl-action-note redirect">
        <span>↪</span>
        <span><strong>{author?.name}</strong> redirected the agent: “{content}”</span>
      </div>
    )
  }
  if (type === 'tool_call') {
    return <div className="tl-action-note tool"><span>⚙</span><span>{meta?.tool || 'tool'}: {content}</span></div>
  }
  if (type === 'tool_result') {
    return <div className="tl-action-note tool"><span>✓</span><span>{content}</span></div>
  }
  if (type === 'fork') {
    return (
      <div className="tl-action-note fork">
        <span>⑂</span>
        <span><strong>{author?.name}</strong> forked this session → “{content}”</span>
      </div>
    )
  }

  const isAgent = type === 'agent_message'
  return (
    <div className={`tl-event${isAgent ? ' agent' : ''}`}>
      <div className="tl-avatar" style={{ background: author?.color || '#8A9BD1' }}>
        {isAgent ? '✳' : initials(author?.name)}
      </div>
      <div className="tl-body">
        <div className="tl-head">
          <span className="tl-name">{author?.id === you?.id ? `${author?.name} (you)` : author?.name}</span>
          <span className="tl-time">{timeOf(event.createdAt)}</span>
          {meta?.partial && <span className="tl-tag partial">interrupted</span>}
        </div>
        <div className="tl-content"><Markdown text={content} /></div>
      </div>
    </div>
  )
}

export function AgentTimeline({ events, streaming, activeTool, you, agentName = 'HiveMind' }) {
  const scrollRef = useRef(null)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  }, [events, streaming, activeTool, pinned])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll}>
      {events.map((e) => <EventItem key={e.id} event={e} you={you} />)}

      {activeTool && (
        <div className="tl-action-note tool">
          <span className="tool-spinner" />
          <span>{activeTool.tool}: {activeTool.query || 'working…'}</span>
        </div>
      )}

      {streaming && (
        <div className="tl-event agent streaming">
          <div className="tl-avatar" style={{ background: '#255DCE' }}>✳</div>
          <div className="tl-body">
            <div className="tl-head">
              <span className="tl-name">{agentName}</span>
              <span className="tl-time">streaming</span>
            </div>
            <div className="tl-content">
              {streaming.text
                ? <><Markdown text={streaming.text} /><span className="caret" /></>
                : <em style={{ color: 'var(--muted)' }}>thinking<span className="caret" /></em>}
            </div>
          </div>
        </div>
      )}

      {!pinned && (
        <button className="scroll-pin" onClick={() => setPinned(true)}>↓ Jump to latest</button>
      )}
    </div>
  )
}
