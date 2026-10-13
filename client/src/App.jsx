import React, { useEffect, useState } from 'react'
import { Scene } from './components/Scene'
import { Landing } from './components/Landing'
import { DemoSection } from './components/DemoSection'
import { SampleSection } from './components/SampleSection'
import { LiveSection } from './components/LiveSection'
import { useRuntime } from './lib/runtime'

const SECTION_META = {
  demo: { title: 'Demo', sub: 'A scripted replay of a real multiplayer session — sit back and watch.' },
  sample: { title: 'Sample', sub: 'Your private sandbox with a real agent — learn the moves before going multiplayer.' },
  live: { title: 'Live', sub: 'Real multiplayer. Share the room code and work one agent together.' },
}

function parseHash() {
  const match = window.location.hash.match(/^#\/join\/([A-Za-z0-9]{4,10})/)
  return match ? match[1].toUpperCase() : null
}

export default function App() {
  const runtime = useRuntime()
  const [view, setView] = useState(() => (parseHash() ? 'live' : 'home'))
  const [joinCode, setJoinCode] = useState(() => parseHash() || '')

  useEffect(() => {
    const onHash = () => {
      const code = parseHash()
      if (code) { setJoinCode(code); setView('live') }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const goHome = () => { setView('home'); window.location.hash = '' }

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
            {['demo', 'sample', 'live'].map((key) => (
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
            </div>
          )}
        </main>
      </div>
    </>
  )
}
