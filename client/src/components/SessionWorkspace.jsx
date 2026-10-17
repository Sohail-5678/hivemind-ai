import React, { useEffect, useRef } from 'react'
import { PresenceBar } from './PresenceBar'
import { AgentTimeline } from './AgentTimeline'
import { Composer } from './Composer'

// The shared multiplayer canvas. Demo feeds it replayed state; Sample and Live
// feed it real state (server or static transport). Everything is identical.
export function SessionWorkspace({
  session, you, events, participants, status, streaming, activeTool, connection = 'open',
  onSend, onAction, onTyping, onNotice,
  notice, noticeProgress = false, onClearNotice,
  banner = null, shareBar = null,
  readOnly = false, readOnlyHint = '',
}) {
  // Keep the latest callback in a ref: parents pass a new function every render,
  // and depending on it would restart the timer on every streamed token.
  const clearRef = useRef(onClearNotice)
  clearRef.current = onClearNotice
  useEffect(() => {
    if (!notice || noticeProgress) return undefined // progress notices clear when the answer starts
    const t = setTimeout(() => clearRef.current?.(), 4000)
    return () => clearTimeout(t)
  }, [notice, noticeProgress])

  return (
    <div className="workspace glass">
      {banner}
      <PresenceBar sessionName={session?.name || 'Session'} participants={participants} you={you} status={status} connection={connection} />
      {shareBar}
      <AgentTimeline events={events} streaming={streaming} activeTool={activeTool} you={you} />
      <Composer status={status} onSend={onSend} onAction={onAction} onTyping={onTyping} onNotice={onNotice} disabled={readOnly} disabledHint={readOnlyHint} />
      {notice && <div className="notice-toast" role="status">{notice}</div>}
    </div>
  )
}
