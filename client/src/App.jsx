import React, { useEffect, useRef } from 'react'
import { Scene } from './components/Scene'
import { Landing } from './components/Landing'
import { DemoSection } from './components/DemoSection'
import { SampleSection } from './components/SampleSection'
import { LiveSection } from './components/LiveSection'
import { AboutSection } from './components/AboutSection'
import { ThemeToggle } from './components/ThemeToggle'
import { useRuntime } from './lib/runtime'
import { useRoute, navigate, SECTIONS } from './lib/router'

const SECTION_META = {
  demo: { title: 'Demo', sub: 'Watch a room run on its own: a multiplayer replay, or an agent team working next to scripted teammates.' },
  sample: { title: 'Sample', sub: 'Your private room. One agent or a whole team, and nobody else in it.' },
  live: { title: 'Live', sub: 'Share a room code. Everyone sees the same agents, the same board and every token.' },
  about: { title: 'About', sub: 'What HiveMind is, the nine architectures, and how both runtimes are built.' },
}

const HOME_TITLE = 'HiveMind · Multiplayer, multi-agent rooms'

const RUNTIME_COPY = {
  server: { mode: 'Server', detail: 'WebSocket', title: 'Running on the Node server: WebSocket rooms and a SQLite timeline.' },
  static: { mode: 'Static', detail: 'Relay', title: 'No server here: rooms sync over an end-to-end encrypted relay and agents run in the host tab.' },
}

// Identifies the room a route points at, so a fork hop (same section, new room)
// counts as a new screen.
function roomKeyOf(route) {
  if (!route.room) return ''
  return route.room.kind === 'code' ? `code:${route.room.code}` : `session:${route.room.id}`
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="20" height="20" focusable="false">
        <path className="bm-hex" d="M16 3.5 26.8 9.75V22.25L16 28.5 5.2 22.25V9.75Z" />
        <circle className="bm-core" cx="16" cy="16" r="3.8" />
        <circle className="bm-human" cx="26.8" cy="9.75" r="2.7" />
        <circle className="bm-agent" cx="5.2" cy="22.25" r="2.1" />
      </svg>
    </span>
  )
}

function RuntimePill({ runtime }) {
  const copy = runtime ? RUNTIME_COPY[runtime.mode] || RUNTIME_COPY.static : null
  return (
    <span className={`runtime-pill ${runtime ? runtime.mode : 'pending'}`} title={copy?.title}>
      <span className="runtime-dot" aria-hidden="true" />
      {copy ? copy.mode : 'Detecting'}
      {copy && <span className="runtime-detail"> · {copy.detail}</span>}
    </span>
  )
}

function RuntimeProbe() {
  return (
    <div className="runtime-probe" role="status">
      <span className="tool-spinner" aria-hidden="true" />
      Looking for a HiveMind server…
    </div>
  )
}

export default function App() {
  const runtime = useRuntime()
  const route = useRoute()
  const mainRef = useRef(null)
  const lastScreen = useRef(null)

  const { section } = route
  const meta = SECTION_META[section] || null
  const inRoom = Boolean(route.room)
  const roomKey = roomKeyOf(route)
  // Screens built around a live workspace get exactly the height that is left.
  const fill = inRoom || section === 'demo'

  // Unknown URLs fall back to Home without leaving a broken entry in history.
  useEffect(() => {
    if (!route.valid) navigate('/', { replace: true })
  }, [route.valid, route.path])

  // Every new screen starts at the top. Focus follows the navigation for
  // keyboard and screen reader users, unless the screen already placed it
  // (a room that autofocuses its composer keeps that focus).
  useEffect(() => {
    const main = mainRef.current
    const key = `${section}|${roomKey}`
    const prev = lastScreen.current
    lastScreen.current = key
    if (!main || prev === key) return
    main.scrollTop = 0
    if (prev === null) return // first paint: leave focus where the browser put it
    if (!main.contains(document.activeElement)) main.focus({ preventScroll: true })
  }, [section, roomKey])

  useEffect(() => {
    if (!meta) { document.title = HOME_TITLE; return }
    document.title = `${inRoom ? `${meta.title} room` : meta.title} · HiveMind`
  }, [meta, inRoom])

  const select = (key) => navigate(key === 'home' ? '/' : `/${key}`)

  return (
    <>
      <Scene quiet={inRoom} />
      <div className={`app${inRoom ? ' in-room' : ''}`}>
        <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>Skip to content</button>

        <header className="topbar">
          <a className="brand" href="#/" aria-label="HiveMind home">
            <BrandMark />
            <span className="brand-word">HiveMind</span>
          </a>
          <nav className="nav" aria-label="Sections">
            {SECTIONS.map((key) => (
              <a
                key={key}
                href={`#/${key}`}
                className={section === key ? 'active' : undefined}
                aria-current={section === key ? 'page' : undefined}
              >
                {SECTION_META[key].title}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            <RuntimePill runtime={runtime} />
            <ThemeToggle />
          </div>
        </header>

        <main className="main" ref={mainRef} tabIndex={-1} aria-label={meta ? meta.title : 'Home'}>
          {!meta && <Landing onSelect={select} runtime={runtime} />}

          {meta && (
            <div className={`section-frame${fill ? ' fill' : ''}${inRoom ? ' in-room' : ''}`}>
              <div className="section-head">
                {/* Keyed so leaving a room swaps the link: focus falls to <main>
                    instead of staying on a control that now means Home. */}
                <a
                  key={inRoom ? 'leave' : 'home'}
                  className="back-btn"
                  href={inRoom ? `#/${section}` : '#/'}
                  aria-label={inRoom ? `Leave the room, back to ${meta.title}` : 'Back to Home'}
                >
                  <span className="back-arrow" aria-hidden="true">←</span>
                  {inRoom ? meta.title : 'Home'}
                </a>
                <h1 className="section-title">{inRoom ? `${meta.title} room` : meta.title}</h1>
                {!inRoom && <p className="section-sub">{meta.sub}</p>}
              </div>

              {section === 'demo' && <DemoSection onGoLive={() => navigate('/live')} />}
              {section === 'sample' && (runtime ? <SampleSection runtime={runtime} route={route} /> : <RuntimeProbe />)}
              {section === 'live' && (runtime ? <LiveSection runtime={runtime} route={route} /> : <RuntimeProbe />)}
              {section === 'about' && <AboutSection onSelect={select} runtime={runtime} />}
            </div>
          )}
        </main>
      </div>
    </>
  )
}
