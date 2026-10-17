import React, { useEffect, useState } from 'react'
import { useSession } from '../hooks/useSession'
import { useLocalRoom } from '../hooks/useLocalRoom'
import { SessionWorkspace } from './SessionWorkspace'

// Live-connected workspace shared by Sample and Live modes. Picks the transport
// from the runtime (server → WebSocket, static → encrypted relay) and handles
// the "you forked → hop into the fork" navigation plus connection errors.

function Connected({ s, renderShareBar, banner, onExit }) {
  const [localNotice, setLocalNotice] = useState(null)

  const notice = s.notice || localNotice
  const clearNotice = () => { s.clearNotice(); setLocalNotice(null) }

  if (s.connection === 'error') {
    return (
      <div className="setup-card glass" style={{ maxWidth: 560 }}>
        <h3>Couldn't open that session</h3>
        <div className="error-note">{s.error || 'Unknown error.'}</div>
        <button className="btn btn-ghost" onClick={onExit}>← Back</button>
      </div>
    )
  }

  return (
    <SessionWorkspace
      session={s.session}
      you={s.you}
      events={s.events}
      participants={s.participants}
      status={s.status}
      streaming={s.streaming}
      activeTool={s.activeTool}
      connection={s.connection}
      onSend={s.sendMessage}
      onAction={(action, extra) => s.act(action, extra)}
      onTyping={s.setTyping}
      onNotice={setLocalNotice}
      notice={notice}
      onClearNotice={clearNotice}
      banner={banner || null}
      shareBar={renderShareBar ? renderShareBar(s.session, s) : null}
    />
  )
}

function ServerSession({ sessionId, userName, onFork, ...rest }) {
  const s = useSession(sessionId, userName)
  useEffect(() => {
    if (s.forkTarget) { const t = s.forkTarget; s.clearFork(); onFork(t) }
  }, [s.forkTarget]) // eslint-disable-line react-hooks/exhaustive-deps
  return <Connected s={s} {...rest} />
}

function LocalSession({ roomCode, userName, apiKey, preferHost, onFork, ...rest }) {
  const s = useLocalRoom(roomCode, userName, { apiKey, preferHost })
  useEffect(() => {
    if (s.forkTarget) { const t = s.forkTarget; s.clearFork(); onFork(t) }
  }, [s.forkTarget]) // eslint-disable-line react-hooks/exhaustive-deps
  return <Connected s={s} {...rest} />
}

export function ActiveSession({ mode, sessionId, roomCode, userName, apiKey, preferHost = false, renderShareBar, banner, onExit }) {
  const [target, setTarget] = useState({ sessionId, roomCode, preferHost })
  const [forkNotice, setForkNotice] = useState(null)

  useEffect(() => { setTarget({ sessionId, roomCode, preferHost }) }, [sessionId, roomCode, preferHost])

  const onFork = (session) => {
    setForkNotice(`You're now in the fork: "${session.name}"`)
    setTarget({ sessionId: session.id, roomCode: session.roomCode, preferHost: true })
  }

  const wrappedBanner = (
    <>
      {banner}
      {forkNotice && (
        <div className="demo-banner" onAnimationEnd={undefined}>
          <span>⑂</span><span>{forkNotice}</span>
          <button className="replay" onClick={() => setForkNotice(null)}>Dismiss</button>
        </div>
      )}
    </>
  )

  if (mode === 'server') {
    return <ServerSession key={target.sessionId} sessionId={target.sessionId} userName={userName} onFork={onFork} renderShareBar={renderShareBar} banner={wrappedBanner} onExit={onExit} />
  }
  return <LocalSession key={target.roomCode} roomCode={target.roomCode} userName={userName} apiKey={apiKey} preferHost={target.preferHost} onFork={onFork} renderShareBar={renderShareBar} banner={wrappedBanner} onExit={onExit} />
}
