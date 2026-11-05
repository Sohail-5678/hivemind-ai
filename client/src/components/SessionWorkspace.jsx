import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PresenceBar } from './PresenceBar'
import { AgentTimeline } from './AgentTimeline'
import { Composer, Icon } from './Composer'
import { HivePanel, EscalationBanner, VotePanel, mentionTargets } from './hive'
import { sanitizeConfig } from '../hooks/teamRoom'

const NOTICE_MS = 4000
const NARROW_QUERY = '(max-width: 979px)' // below this the Hive panel becomes a tab
const PINNED_PX = 80                      // same "at the bottom" slack AgentTimeline uses

// session.config as every runtime sanitizes it (the static room's own helper,
// mirrored by the server's). Sessions from before v2 carry no config at all,
// which means a single agent.
export const sanitizeCrewConfig = sanitizeConfig

// The four room types: mode (sample | live) × crew (single | team).
const ROOM_TYPES = { sample: { single: 'Solo', team: 'Agent team' }, live: { single: 'Multiplayer', team: 'Hive' } }
export function roomTypeName(mode, crew) {
  return ROOM_TYPES[mode === 'sample' ? 'sample' : 'live'][crew === 'team' ? 'team' : 'single']
}

function useMediaQuery(query) {
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false)
  const [matches, setMatches] = useState(read)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange) // Safari < 14
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [query])
  return matches
}

// Rendered into <body> so no ancestor transform or overflow can trap a fixed toast.
// Visual only: the workspace announces the same text through a live region that
// is already in the page, since a region inserted with its text is often silent.
function NoticeToast({ notice, progress, onDismiss }) {
  if (!notice || typeof document === 'undefined') return null
  return createPortal(
    <div
      key={notice}
      className={`notice-toast${progress ? ' is-progress' : ''}`}
      style={{ '--ws-toast-ms': `${NOTICE_MS}ms` }}
    >
      <span className="ws-toast-mark" aria-hidden="true" />
      <span className="ws-toast-text">{notice}</span>
      {onDismiss && (
        <button type="button" className="ws-toast-close" aria-label="Dismiss notice" onClick={onDismiss}>
          <Icon name="close" size={14} />
        </button>
      )}
      <span className="ws-toast-track" aria-hidden="true"><span className="ws-toast-bar" /></span>
    </div>,
    document.body,
  )
}

// The shared room canvas. Demo feeds it replayed state; Sample and Live feed it
// real state (server or static transport). Team rooms (session.config.crew ===
// 'team', or any room with a swarm view) add the Hive panel beside the timeline.
export function SessionWorkspace({
  session, you, events, participants, status, streaming, activeTool, connection = 'open',
  onSend, onAction, onTyping, onNotice,
  notice, noticeProgress = false, onClearNotice,
  banner = null, shareBar = null,
  readOnly = false, readOnlyHint = '',
  swarm = null, blackboard = null,
}) {
  // Keep the latest callback in a ref: parents pass a new function every render,
  // and depending on it would restart the timer on every streamed token.
  const clearRef = useRef(onClearNotice)
  clearRef.current = onClearNotice
  useEffect(() => {
    if (!notice || noticeProgress) return undefined // progress notices clear when the answer starts
    const t = setTimeout(() => clearRef.current?.(), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice, noticeProgress])

  const provider = session?.provider || swarm?.provider || 'simulated'
  // The session's config decides the room type: a room switched back to one
  // agent keeps its last team view in the snapshot but runs a single agent.
  // A canvas fed a swarm but no session config (a replay) reads as a team room
  // running the architecture that swarm asked for.
  const sessionConfig = session?.config || null
  const swarmPattern = swarm ? (swarm.requested || swarm.pattern || 'auto') : null
  const config = useMemo(
    () => sanitizeCrewConfig(sessionConfig || (swarmPattern ? { crew: 'team', pattern: swarmPattern } : null), provider),
    [sessionConfig, swarmPattern, provider],
  )
  const team = config.crew === 'team'
  const sample = session?.mode === 'sample'

  // Mention chips follow the live team once a run has registered agents, else
  // the planned team. Keyed on the roster, not on every streamed token.
  const rosterKey = swarm ? `${swarm.runId}:${swarm.status}:${(swarm.order || []).join(',')}` : ''
  const swarmRef = useRef(swarm)
  swarmRef.current = swarm
  const mentionAgents = useMemo(
    () => (team && !readOnly ? mentionTargets(config, swarmRef.current) : null),
    [team, readOnly, config, rosterKey], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Hive controls report their own errors inline. `readOnly` locks the composer;
  // the Hive controls stay live whenever the canvas owner handles actions (the
  // Hive demo lets a visitor vote, pin and answer the Monitor) and go inert
  // without a handler (the replay).
  const hiveAction = typeof onAction === 'function' ? onAction : undefined
  const hiveLocked = !hiveAction

  // Keyboard focus never falls back to <body> when the control holding it goes
  // away (a resolved escalation, a closed vote, Stop disabled as a run ends).
  // Neither removal nor disabling fires a blur, so the last focused control is
  // tracked here and checked after every render: it gets focus back if it is
  // still usable, otherwise the composer takes it (or the screen, when the
  // composer is read-only). A real blur (clicking away, tabbing out) clears the
  // record, so this never pulls focus back.
  const rootRef = useRef(null)
  const lastFocus = useRef(null)
  useLayoutEffect(() => {
    const el = lastFocus.current
    const active = document.activeElement
    if (!el || (active && active !== document.body && !(active === el && el.disabled))) return
    lastFocus.current = null
    const back = el.isConnected && !el.disabled && !el.closest('[hidden]') ? el : null
    const root = rootRef.current
    const target = back || root?.querySelector('.composer textarea:not(:disabled)') || root?.closest('main')
    target?.focus({ preventScroll: true })
  })
  const onFocusIn = (e) => { lastFocus.current = e.target }
  const onFocusOut = (e) => {
    if (!e.relatedTarget || !rootRef.current?.contains(e.relatedTarget)) lastFocus.current = null
  }

  // Narrow screens: "Conversation | Hive" tabs. Both stay mounted so the Hive
  // panel keeps its own tab and the timeline keeps its scroll position.
  const narrow = useMediaQuery(NARROW_QUERY)
  const tabbed = team && narrow
  const [tab, setTab] = useState('conversation')
  const [seenEvents, setSeenEvents] = useState(0)
  const feedRef = useRef(null)
  const feedScroll = useRef(null)
  const tabRefs = useRef({})
  const uid = useId()

  const switchTab = (next) => {
    if (next === tab) return
    if (tab === 'conversation') {
      const el = feedRef.current?.querySelector('.timeline')
      if (el) feedScroll.current = { top: el.scrollTop, atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_PX }
    }
    if (next === 'hive') setSeenEvents(events.length)
    setTab(next)
  }
  useLayoutEffect(() => {
    if (tab !== 'conversation' || !feedScroll.current) return
    const saved = feedScroll.current
    feedScroll.current = null
    const el = feedRef.current?.querySelector('.timeline')
    if (el) el.scrollTop = saved.atEnd ? el.scrollHeight : saved.top
  }, [tab])

  const onTabKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const next = e.key === 'Home' ? 'conversation' : e.key === 'End' ? 'hive' : tab === 'conversation' ? 'hive' : 'conversation'
    switchTab(next)
    tabRefs.current[next]?.focus()
  }

  // A closed vote stays up until the run ends; after that its result lives in
  // the timeline (and the final answer), so the panel steps aside.
  const showVote = team && Boolean(swarm?.vote) && (swarm.vote.open || swarm.status === 'running')
  const showConvo = !tabbed || tab === 'conversation'
  const showSide = team && (!tabbed || tab === 'hive')
  const convoUnseen = tabbed && tab === 'hive' && events.length > seenEvents
  const hiveLive = swarm?.status === 'running'

  // People get about 20 seconds to vote, so the opening is announced once per
  // vote, with the question and the time left when it opened.
  const vote = showVote ? swarm.vote : null
  const voteKey = vote?.open ? vote.voteId || vote.question || 'vote' : null
  const voteSay = useMemo(() => {
    if (!voteKey) return ''
    const q = vote.question || 'Which proposal should the team adopt?'
    const secs = Math.round(((Number(vote.deadline) || 0) - Date.now()) / 1000)
    return hiveLocked || !you || secs <= 0 ? `Vote open: ${q}` : `Vote open: ${q} ${secs} seconds to vote.`
  }, [voteKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const placeholder = readOnly
    ? (readOnlyHint || 'Read-only')
    : team
      ? (sample ? 'Give the team a goal, or @mention one agent…' : 'Message the room, or @mention one agent…')
      : (sample ? 'Message the agent…' : 'Message the agent. Everyone in the room sees it…')

  const tabProps = (id) => ({
    ref: (el) => { tabRefs.current[id] = el },
    id: `${uid}-tab-${id}`,
    type: 'button',
    role: 'tab',
    'aria-selected': tab === id,
    'aria-controls': `${uid}-panel-${id}`,
    tabIndex: tab === id ? 0 : -1,
    className: `ws-tab${tab === id ? ' is-active' : ''}`,
    onClick: () => switchTab(id),
  })

  // Narrow screens keep the vote above the tab panels, beside the escalation,
  // so a vote that opens while someone watches the Hive tab is still in view.
  const voteCallout = showVote && (
    <div className="ws-callout ws-vote">
      <VotePanel vote={swarm.vote} you={you} onAction={hiveAction} readOnly={hiveLocked} />
    </div>
  )

  return (
    <div className={`workspace${team ? ' is-team' : ''}`} ref={rootRef} onFocus={onFocusIn} onBlur={onFocusOut}>
      {banner}
      <div className={`ws-grid${team ? ' is-team' : ''}`}>
        <div className="ws-head">
          <PresenceBar
            sessionName={session?.name || 'Session'}
            participants={participants}
            you={you}
            status={status}
            connection={connection}
            config={config}
            swarm={swarm}
            mode={session?.mode || null}
          />
          {shareBar}
          {tabbed && (
            <div className="ws-tabs" role="tablist" aria-label="Room view" onKeyDown={onTabKey}>
              <button {...tabProps('conversation')}>
                <span>Conversation</span>
                {convoUnseen && <><span className="ws-tab-flag" aria-hidden="true" /><span className="ws-sr">, new activity</span></>}
              </button>
              <button {...tabProps('hive')}>
                <span>Hive</span>
                {hiveLive && <><span className="dot live" aria-hidden="true" /><span className="ws-sr">, team running</span></>}
              </button>
            </div>
          )}
          {team && swarm?.escalation && (
            <div className="ws-callout">
              <EscalationBanner escalation={swarm.escalation} onAction={hiveAction} readOnly={hiveLocked} />
            </div>
          )}
          {tabbed && voteCallout}
        </div>

        <div
          className="ws-convo"
          hidden={!showConvo}
          {...(tabbed ? { id: `${uid}-panel-conversation`, role: 'tabpanel', 'aria-labelledby': `${uid}-tab-conversation` } : {})}
        >
          {!tabbed && voteCallout}
          <div className="ws-feed" ref={feedRef}>
            <AgentTimeline events={events} streaming={streaming} activeTool={activeTool} you={you} swarm={swarm} teamRoom={team} />
          </div>
          <Composer
            status={status}
            onSend={onSend}
            onAction={onAction}
            onTyping={onTyping}
            onNotice={onNotice}
            disabled={readOnly}
            disabledHint={readOnlyHint}
            placeholder={placeholder}
            team={team}
            mentionAgents={mentionAgents}
          />
        </div>

        {/* A <div> with an explicit role: tabpanel is not allowed on <aside>, and
            one element type keeps the panel mounted across the breakpoint. */}
        {team && (
          <div
            className="ws-side"
            hidden={!showSide}
            {...(tabbed
              ? { id: `${uid}-panel-hive`, role: 'tabpanel', 'aria-labelledby': `${uid}-tab-hive` }
              : { role: 'complementary', 'aria-label': 'Hive' })}
          >
            <HivePanel
              swarm={swarm}
              blackboard={blackboard}
              config={config}
              you={you}
              participants={participants}
              status={status}
              onAction={hiveAction}
              provider={provider}
              readOnly={hiveLocked}
            />
          </div>
        )}
      </div>

      <div className="ws-sr" role="status">{notice || ''}</div>
      <div className="ws-sr" role="status">{voteSay}</div>
      <NoticeToast notice={notice} progress={noticeProgress} onDismiss={onClearNotice ? () => onClearNotice() : null} />
    </div>
  )
}
