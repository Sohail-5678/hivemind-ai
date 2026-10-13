import React, { useEffect, useState } from 'react'
import { Scene } from './components/Scene'
import { Landing } from './components/Landing'
import { DemoSection } from './components/DemoSection'
import { SampleSection } from './components/SampleSection'
import { LiveSection } from './components/LiveSection'
import { AboutSection } from './components/AboutSection'
import { useRuntime } from './lib/runtime'

const SECTION_META = {
  demo: { title: 'Demo', sub: 'A scripted replay of a real multiplayer session — sit back and watch.' },
  sample: { title: 'Sample', sub: 'Your private sandbox with a real agent — learn the moves before going multiplayer.' },
  live: { title: 'Live', sub: 'Real multiplayer. Share the room code and work one agent together.' },
  about: { title: 'About', sub: 'What HiveMind is, how a shared agent session works, and how it is built.' },
}
const NAV = ['demo', 'sample', 'live', 'about']

// Deep links: #/join/CODE opens Live with the code prefilled; #/about, #/demo,
// #/sample and #/live open that section directly.
function parseHash() {
  const hash = window.location.hash
  const join = hash.match(/^#\/join\/([A-Za-z0-9]{4,10})/)
  if (join) return { view: 'live', code: join[1].toUpperCase() }
  const section = hash.match(/^#\/(demo|sample|live|about)\b/)
  if (section) return { view: section[1], code: '' }
  return { view: 'home', code: '' }
}

export default function App() {
  const runtime = useRuntime()
  const [view, setViewState] = useState(() => parseHash().view)
  const [joinCode, setJoinCode] = useState(() => parseHash().code)

  useEffect(() => {
    const onHash = () => {
      const { view: next, code } = parseHash()
      if (code) setJoinCode(code)
      setViewState(next)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const setView = (key) => {
    setViewState(key)
    const target = key === 'home' ? '' : `#/${key}`
    if (window.location.hash !== target) {
      if (target) window.location.hash = target
      else history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }
  const goHome = () => setView('home')

  return (
    <>
      <Scene />
      <div className="app">
        <header className="topbar">
          <div className="brand" onClick={goHome} role="button" tabIndex={0}>
            <span className="brand-dots"><span /><span /><span /></span>
            HiveMind
          </div>
          <nav className="nav">
            {NAV.map((key) => (
              <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>
                {SECTION_META[key].title}
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <span>One agent. Whole team. Live.</span>
            {runtime && <span className="mode-pill">{runtime.mode === 'server' ? 'Server · WS' : 'Static · Tabs'}</span>}
          </div>
        </header>

        <main className="main">
          {view === 'home' && <Landing onSelect={setView} runtime={runtime} />}
          {view !== 'home' && (
            <div className="section-frame">
              <div className="section-head">
                <button className="back-btn" onClick={goHome}>← Home</button>
                <span className="section-title">{SECTION_META[view].title}</span>
                <span className="section-sub">{SECTION_META[view].sub}</span>
              </div>
              {view === 'demo' && <DemoSection onGoLive={() => setView('live')} />}
              {view === 'sample' && (runtime ? <SampleSection runtime={runtime} /> : <div className="info-note">Detecting runtime…</div>)}
              {view === 'live' && (runtime ? <LiveSection runtime={runtime} initialCode={joinCode} /> : <div className="info-note">Detecting runtime…</div>)}
              {view === 'about' && <AboutSection onSelect={setView} runtime={runtime} />}
            </div>
          )}
        </main>
      </div>
    </>
  )
}
