import React, { useRef } from 'react'

const MODES = [
  { key: 'demo', icon: '▶', title: 'Watch the demo', body: 'A choreographed replay of three teammates steering one live agent — presence, mid-stream redirects, forking. No setup, starts instantly.', cta: 'Play demo' },
  { key: 'sample', icon: '✳', title: 'Try it yourself', body: 'A private session to learn the moves: send a task, redirect the agent mid-stream, pause, resume, fork. Simulated brain or a real LLM.', cta: 'Start solo session' },
  { key: 'live', icon: '⚡', title: 'Go multiplayer', body: 'Create a shared session, send the room code, and work the same agent together — every teammate sees every token, live.', cta: 'Create a room' },
]

// A floating "hive" constellation behind the stage: teammates and agents as
// glowing nodes with signal travelling along the links.
const NODES = [
  { x: 60, y: 70, r: 5, cls: 'sky' },
  { x: 210, y: 28, r: 7, cls: 'cobalt' },
  { x: 372, y: 96, r: 5, cls: 'red' },
  { x: 398, y: 250, r: 8, cls: 'cobalt' },
  { x: 318, y: 392, r: 5, cls: 'sky' },
  { x: 130, y: 418, r: 6, cls: 'red' },
  { x: 22, y: 290, r: 4, cls: 'sky' },
  { x: 236, y: 238, r: 10, cls: 'core' },
]
const LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0], [7, 1], [7, 3], [7, 5], [7, 0], [7, 2], [7, 4], [7, 6]]

export function Landing({ onSelect, runtime }) {
  const stageRef = useRef(null)

  // Mouse-driven parallax tilt for the floating stage cards.
  const onMove = (e) => {
    const el = stageRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width - 0.5
    const y = (e.clientY - rect.top) / rect.height - 0.5
    el.style.setProperty('--ry', (x * 10).toFixed(2))
    el.style.setProperty('--rx', (-y * 10).toFixed(2))
  }
  const onLeave = () => {
    const el = stageRef.current
    if (!el) return
    el.style.setProperty('--ry', '0')
    el.style.setProperty('--rx', '0')
  }

  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><span className="live-dot" /> Multiplayer AI agents</span>
          <h1 className="display">One agent.<br /><em>In full</em> <span className="red">swarm.</span></h1>
          <p>
            AI had its chat moment. This is its multiplayer moment. HiveMind turns an agent session into a shared,
            living workspace — like a Google Doc, except the document is an agent doing real work your whole team
            can watch, steer, and hand off.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={() => onSelect('demo')}>▶ Watch the demo</button>
            <button className="btn btn-ghost" onClick={() => onSelect('live')}>Create a live room →</button>
          </div>
          <button className="text-link" onClick={() => onSelect('about')}>How it works &amp; how it's built →</button>
        </div>

        <div className="hero-stage" ref={stageRef} onMouseMove={onMove} onMouseLeave={onLeave}>
          <svg className="hive-net" viewBox="0 0 420 440" aria-hidden="true">
            {LINKS.map(([a, b], i) => (
              <line key={i} className="link" style={{ animationDelay: `${(i * 0.45) % 6}s` }}
                x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y} />
            ))}
            {NODES.map((n, i) => (
              <g key={i} className={`node ${n.cls}`} style={{ animationDelay: `${(i * 0.4) % 3}s` }}>
                <circle className="halo" cx={n.x} cy={n.y} r={n.r * 3} />
                <circle className="dot" cx={n.x} cy={n.y} r={n.r} />
              </g>
            ))}
          </svg>

          <div className="stage-card float presence glass">
            <div className="float-head"><span className="live-dot" /> Live now</div>
            <div className="avatars">
              <div className="avatar" style={{ background: '#4F8FE8' }}>M</div>
              <div className="avatar" style={{ background: '#E85D55' }}>J</div>
              <div className="avatar" style={{ background: '#9DB8FF' }}>S</div>
              <div className="avatar agent-av">✳</div>
            </div>
            <div className="float-sub">3 teammates · 1 agent</div>
            <div className="float-typing"><span /><span /><span /> Sam is typing</div>
          </div>

          <div className="stage-card float stream glass">
            <div className="float-head">Token stream</div>
            <div className="eq" aria-hidden="true">
              {Array.from({ length: 14 }).map((_, i) => <span key={i} style={{ animationDelay: `${(i * 0.13) % 1.1}s` }} />)}
            </div>
            <div className="float-sub">fanning out to 3 tabs · ~90 ms</div>
          </div>

          <div className="stage-card session glass">
            <div className="mini-presence">
              <div className="avatars">
                <div className="avatar" style={{ background: '#4F8FE8' }}>M</div>
                <div className="avatar" style={{ background: '#E85D55' }}>J</div>
                <div className="avatar" style={{ background: '#9DB8FF' }}>S</div>
              </div>
              <span className="mini-title">Q3 Launch Plan</span>
              <span className="status-chip running" style={{ marginLeft: 'auto' }}><span className="dot" />Agent working</span>
            </div>
            <div className="mini-line">Maya: draft the launch timeline and risks</div>
            <div className="mini-line agent">✳ On it. Weeks 1–2: feature freeze & hardening. Weeks 3–4: staged rollout at 10% with a crash-rate gate…</div>
            <div className="mini-line redirect">↪ Jordan redirected: “risks first, pricing after”</div>
            <div className="mini-line agent">✳ Understood — pivoting to the risk register. <span className="caret" /></div>
          </div>
        </div>
      </section>

      <div className="mode-grid">
        {MODES.map((m) => (
          <button key={m.key} className={`mode-card glass ${m.key}`} onClick={() => onSelect(m.key)}>
            <span className="mode-icon">{m.icon}</span>
            <h3>{m.title}</h3>
            <p>{m.body}</p>
            <span className="mode-cta">{m.cta} →</span>
          </button>
        ))}
      </div>

      <div className="stats-row">
        <div className="stat"><div className="k">~90 ms</div><div className="v">token fan-out to every teammate</div></div>
        <div className="stat"><div className="k">5 moves</div><div className="v">message · redirect · pause/resume · stop · fork</div></div>
        <div className="stat"><div className="k">4 brains</div><div className="v">free model · Groq · Ollama · scripted demo</div></div>
        <div className="stat"><div className="k">$0</div><div className="v">no accounts, no keys required to run</div></div>
      </div>

      <div className="landing-footer">
        {runtime?.mode === 'server'
          ? 'Running on the full Node server — WebSocket rooms, SQLite timeline, cross-device multiplayer.'
          : 'Static deployment — rooms sync across devices through an end-to-end encrypted relay; run the Node server for local models and a persistent room log.'}
        {' · '}<button className="text-link inline" onClick={() => onSelect('about')}>About this project</button>
        {' · '}<a href="https://github.com/Sohail-5678/hivemind-ai" target="_blank" rel="noreferrer">Source on GitHub</a>
      </div>
    </div>
  )
}
