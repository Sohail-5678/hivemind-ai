import React from 'react'

const FLOW = [
  { n: 1, title: 'A teammate sends a task', body: 'Anyone in the room types a message. It is validated (length caps, control characters stripped, prompt-injection patterns flagged) and appended to the session timeline as an event.' },
  { n: 2, title: 'The room fans it out', body: 'The event is broadcast to every participant in real time — over WebSockets on the Node server, or through an end-to-end encrypted relay on the static build, so any device on any network can join.' },
  { n: 3, title: 'The agent run starts', body: 'One run per session at a time. The engine builds the LLM context from the last 30 timeline events (every teammate’s messages, the agent’s replies, and every redirect), then starts streaming.' },
  { n: 4, title: 'Tokens stream to everyone', body: 'Deltas are batched (~90 ms) and broadcast, so all teammates watch the same text appear at the same moment. Late joiners get a snapshot that includes the text streamed so far.' },
  { n: 5, title: 'Anyone can steer', body: 'Redirect aborts the in-flight stream, commits the partial output (tagged “interrupted”), and immediately starts a follow-up run with the new direction injected. Pause, resume, stop, and fork work the same way for the whole room.' },
  { n: 6, title: 'Everything is a durable event', body: 'Messages, agent replies, tool calls, redirects, pauses, forks, joins and leaves are all append-only events. Reconnects are idempotent and a fork copies the full timeline into a new room.' },
]

const MOVES = [
  { icon: '💬', name: 'Message', what: 'Task the agent. Everyone sees it; the response streams to all.', how: 'Event appended → broadcast → run starts if the room is idle.' },
  { icon: '↪', name: 'Redirect', what: 'Change the agent’s direction while it is still writing.', how: 'Abort stream → commit partial → synchronous follow-up run with steering. A pause or stop clicked afterwards always wins.' },
  { icon: '⏸', name: 'Pause / Resume', what: 'Freeze the agent for the whole room, hand it off, pick it back up.', how: 'Abort with reason “pause”, keep partial; resume re-runs with a “continue where you left off” instruction.' },
  { icon: '◼', name: 'Stop', what: 'Kill the current run but keep what was produced.', how: 'Abort with reason “stop”; the partial is saved and the room returns to idle.' },
  { icon: '⤑', name: 'Fork', what: 'Branch the session into a parallel exploration.', how: 'New room with the full timeline copied; the forker hops in, everyone else is notified.' },
]

const GUARDRAILS = [
  ['Rate limits', 'Per-IP limits on every REST route and a per-connection frame budget on WebSockets, so join/typing spam can’t amplify into DB writes and broadcasts.'],
  ['Input hygiene', '4,000-char messages, 500-char redirects, control characters stripped, obvious prompt-injection patterns flagged on the event.'],
  ['Never leak a run', 'Run cleanup happens before error reporting and a last-resort catch releases the slot even if the database throws — a session can’t get stuck “running”.'],
  ['Provider resilience', 'First-token deadline, empty-stream detection, and a fallback chain to the built-in simulated agent so a dead or hanging provider never breaks the room.'],
  ['Bring your own key, honestly', 'A Groq key lives only in the tab that typed it. The server holds it in memory per session; the edge function forwards it once. Nothing persists or logs it.'],
  ['Safe rendering', 'Markdown is rendered by building React elements directly — no innerHTML — so agent or teammate output can never inject markup into another person’s browser.'],
  ['Restart recovery', 'Stale “running” statuses are reset on boot; late joiners and reconnects always receive an authoritative snapshot.'],
  ['Split-brain protection', 'In the tab-based runtime the lowest-id tab hosts; a tab that wrongly believes it hosts demotes itself and re-syncs, and un-acked actions are replayed on takeover.'],
]

const STACK = ['React 18', 'Vite', 'Node 22', 'Express', 'ws (WebSockets)', 'node:sqlite', 'MQTT over WebSockets', 'Web Crypto (AES-GCM)', 'BroadcastChannel', 'Vercel Edge Functions', 'Groq API', 'Ollama', 'Server-sent streaming', 'Zero native dependencies']

export function AboutSection({ onSelect, runtime }) {
  return (
    <div className="about">
      <section className="about-section glass">
        <span className="eyebrow">What this is</span>
        <h2>A multiplayer workspace where the document is a live AI agent.</h2>
        <p>
          Every category of work software that went multiplayer became worth ten times more — Word became Google Docs,
          Photoshop became Figma, email threads became Slack. AI agents are still single-player: a private chat window, and the
          most you can share is a read-only transcript. <strong>HiveMind makes the session the product.</strong> Anyone on a team
          can drop into the same live agent run, watch every token, redirect it mid-stream, pause and hand it off, or fork it
          into a parallel exploration — the way they would work with any other teammate.
        </p>
        <div className="about-cta">
          <button className="btn btn-primary" onClick={() => onSelect('demo')}>▶ Watch the 60-second demo</button>
          <button className="btn btn-ghost" onClick={() => onSelect('live')}>Create a live room →</button>
        </div>
      </section>

      <section className="about-section glass">
        <span className="eyebrow">How a session works</span>
        <h2>From a teammate’s message to every screen in the room.</h2>
        <ol className="flow">
          {FLOW.map((s) => (
            <li key={s.n} className="flow-step">
              <span className="flow-n">{s.n}</span>
              <div>
                <div className="flow-title">{s.title}</div>
                <div className="flow-body">{s.body}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="about-section glass">
        <span className="eyebrow">The five moves</span>
        <h2>What a team can do to a running agent — and what happens underneath.</h2>
        <div className="moves-grid">
          {MOVES.map((m) => (
            <div key={m.name} className="move">
              <div className="move-head"><span className="move-icon">{m.icon}</span>{m.name}</div>
              <div className="move-what">{m.what}</div>
              <div className="move-how">{m.how}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section glass">
        <span className="eyebrow">Architecture</span>
        <h2>One React client, two runtimes, one protocol.</h2>
        <p>
          The client detects which runtime it is on by probing <code>/api/health</code> and picks a transport. Both transports emit the
          same message shapes, so the state reducer, the timeline, the presence bar, and the composer are shared verbatim.
          {runtime && <> You are currently on the <strong>{runtime.mode === 'server' ? 'full server' : 'static'}</strong> runtime.</>}
        </p>
        <div className="arch">
          <div className="arch-row">
            <div className="arch-box wide">
              <div className="arch-title">Browser — React + Vite</div>
              <div className="arch-sub">Demo (scripted replay) · Sample (solo) · Live (rooms) → one shared SessionWorkspace</div>
            </div>
          </div>
          <div className="arch-arrows"><span>WebSocket</span><span>Encrypted relay</span></div>
          <div className="arch-row two">
            <div className="arch-box">
              <div className="arch-title">Server runtime — Node, one process</div>
              <div className="arch-sub">Express REST · ws rooms + presence · agent engine · SQLite timeline · guardrails. Cross-device multiplayer on your LAN or through a tunnel.</div>
            </div>
            <div className="arch-box">
              <div className="arch-title">Static runtime — Vercel</div>
              <div className="arch-sub">Same bundle, no backend of its own. Frames are AES-GCM encrypted with a key derived from the room code and fanned out through redundant public relays; the agent runs in the creator’s tab and the lowest-id participant takes over if it closes. Groq via an edge function.</div>
            </div>
          </div>
          <div className="arch-arrows"><span>Ollama · Groq · simulated</span><span>Groq (edge proxy) · simulated</span></div>
          <div className="arch-row three">
            <div className="arch-box small"><div className="arch-title">Simulated brain</div><div className="arch-sub">Built in. Zero setup, tool-call theater, powers the demo.</div></div>
            <div className="arch-box small"><div className="arch-title">Ollama</div><div className="arch-sub">Auto-detected local models. Fully private.</div></div>
            <div className="arch-box small"><div className="arch-title">Groq</div><div className="arch-sub">Real LLM, free key, bring your own.</div></div>
          </div>
        </div>
        <table className="about-table">
          <thead><tr><th></th><th>Server runtime</th><th>Static runtime</th></tr></thead>
          <tbody>
            <tr><td>Transport</td><td>WebSocket rooms</td><td>Encrypted relay (MQTT over WSS) + BroadcastChannel</td></tr>
            <tr><td>Timeline storage</td><td>SQLite (Node’s built-in)</td><td>localStorage per room</td></tr>
            <tr><td>Multiplayer reach</td><td>Any device that can reach the server</td><td>Any device, any network</td></tr>
            <tr><td>Where the agent runs</td><td>The server process</td><td>The host tab</td></tr>
            <tr><td>Agent brains</td><td>Simulated · Ollama · Groq</td><td>Simulated · Groq</td></tr>
          </tbody>
        </table>
      </section>

      <section className="about-section glass">
        <span className="eyebrow">Safety &amp; reliability</span>
        <h2>Built to never hard-fail in front of a team.</h2>
        <div className="guard-grid">
          {GUARDRAILS.map(([k, v]) => (
            <div key={k} className="guard"><div className="guard-k">{k}</div><div className="guard-v">{v}</div></div>
          ))}
        </div>
      </section>

      <section className="about-section glass">
        <span className="eyebrow">Stack</span>
        <h2>Deliberately small.</h2>
        <div className="chip-row">{STACK.map((s) => <span key={s} className="chip">{s}</span>)}</div>
        <p style={{ marginTop: 16 }}>
          The full server has two runtime dependencies (<code>express</code>, <code>ws</code>) and uses Node’s built-in SQLite, so there is
          nothing to compile and nothing to sign up for. A 33-check end-to-end suite boots a real server, connects three WebSocket
          clients, and exercises the whole multiplayer flow — streaming to every client, a mid-stream redirect with partial commit, pause/resume,
          fork, late-joiner snapshots, rate limiting, and disconnect cleanup.
        </p>
      </section>

      <section className="about-section glass">
        <span className="eyebrow">Run it yourself</span>
        <h2>Two commands.</h2>
        <pre className="about-code">{`git clone https://github.com/Sohail-5678/hivemind-ai.git
cd hivemind-ai
npm install
npm start        # → http://localhost:3000  (prints a LAN URL for teammates)
npm test         # 33-check end-to-end multiplayer suite`}</pre>
        <p>
          Source, docs, and the test suite live at{' '}
          <a href="https://github.com/Sohail-5678/hivemind-ai" target="_blank" rel="noreferrer">github.com/Sohail-5678/hivemind-ai</a>.
          Built by Ameer Sohail Shaik.
        </p>
      </section>
    </div>
  )
}
