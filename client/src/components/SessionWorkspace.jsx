import React, { useEffect } from 'react'
import { PresenceBar } from './PresenceBar'
import { AgentTimeline } from './AgentTimeline'
import { Composer } from './Composer'

// The shared multiplayer canvas. Demo feeds it replayed state; Sample and Live
// feed it real state (server or static transport). Everything is identical.
export function SessionWorkspace({
  session, you, events, participants, status, streaming, activeTool, connection = 'open',
  onSend, onAction, onTyping, onNotice,
  notice, onClearNotice,
  banner = null, shareBar = null,
  readOnly = false, readOnlyHint = '',
}) {
  useEffect(() => {
    if (!notice || !onClearNotice) return undefined
    const t = setTimeout(onClearNotice, 4000)
    return () => clearTimeout(t)
  }, [notice, onClearNotice])

  return (
    <div className="workspace glass">
      {banner}
      <PresenceBar sessionName={session?.name || 'Session'} participants={participants} you={you} status={status} connection={connection} />
      {shareBar}
      <AgentTimeline events={events} streaming={streaming} activeTool={activeTool} you={you} />
      <Composer status={status} onSend={onSend} onAction={onAction} onTyping={onTyping} onNotice={onNotice} disabled={readOnly} disabledHint={readOnlyHint} />
      {notice && <div className="notice-toast">{notice}</div>}
    </div>
  )
}
