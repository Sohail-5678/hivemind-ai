import React, { useEffect, useRef, useState } from 'react'
import { PATTERNS, PATTERN_ORDER } from '@shared/swarm/patterns.js'
import { ROLES } from '@shared/swarm/roles.js'
import { textGlyph } from './PresenceBar'
import { hintCrew } from './hive'

// The scene the hive core plays: a Hive room (three people, a debate team)
// deciding how to open a beta. Each speaker lights up on its ring while its
// line streams into the readout below.
const CORE_AGENTS = ['architect', 'builder', 'skeptic', 'pragmatist']
const CORE_PEOPLE = [
  { id: 'maya', name: 'Maya', initial: 'M' },
  { id: 'jordan', name: 'Jordan', initial: 'J' },
  { id: 'sam', name: 'Sam', initial: 'S' },
]
const SCRIPT = [
  { who: 'maya', text: 'Open the beta to everyone, or start with design partners?' },
  { who: 'architect', text: 'Peer-to-peer fits: a real tradeoff, so three peers argue and everyone votes.' },
  { who: 'builder', text: 'Open it to everyone. Feedback volume beats a perfect first week.' },
  { who: 'skeptic', text: 'Onboarding is untested past 20 seats. Start smaller.' },
  { who: 'jordan', text: 'Pinned a constraint: support is two people until January.' },
  { who: 'pragmatist', text: 'Proposal: two cohorts of 25 partners, two weeks apart.' },
  { who: 'vote', text: 'Vote closed. The Pragmatist wins with 2 agents and 2 people.' },
]
const VISIBLE_LINES = 4
const TYPE_MS = 32
const HOLD_MS = 1500
const CALL_BUDGET = 10

const ROOMS = [
  { key: 'solo', name: 'Solo', who: 'Just you', crew: 'One agent', team: false, section: 'sample', people: 1, agents: 1, line: 'You and one agent. A private place to learn the controls.' },
  { key: 'agent-team', name: 'Agent team', who: 'Just you', crew: 'Agent team', team: true, section: 'sample', people: 1, agents: 4, line: 'You and a team of agents. Pick an architecture and watch it work.' },
  { key: 'multiplayer', name: 'Multiplayer', who: 'Your team', crew: 'One agent', team: false, section: 'live', people: 3, agents: 1, line: 'Your team and one agent. Everyone watches and steers the same run.' },
  { key: 'hive', name: 'Hive', who: 'Your team', crew: 'Agent team', team: true, section: 'live', people: 3, agents: 4, line: 'Your team and an agent team. Pin facts, vote and approve escalations together.' },
]
const SECTION_NAME = { sample: 'Sample', live: 'Live' }

const STEPS = [
  { title: 'Open a room', body: 'Pick Solo, Multiplayer, Agent team or Hive. In Live, share the room code and your team joins in seconds.' },
  { title: 'Set the goal', body: 'Send a message. In team rooms the agents take turns, hand work to each other and post facts and decisions to a shared board.' },
  { title: 'Steer it live', body: 'Redirect, pause, pin a constraint, vote with the agents, or fork the room to run the same goal under another architecture.' },
]

const speakerOf = (who) => {
  const person = CORE_PEOPLE.find((p) => p.id === who)
  if (person) return { kind: 'human', name: person.name }
  if (ROLES[who]) return { kind: 'agent', name: ROLES[who].name }
  return { kind: 'system', name: 'Vote' }
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// Types the script one line at a time while the core is on screen and the tab
// is visible. With reduced motion it holds a finished frame instead.
function useScript(rootRef) {
  const [reduced] = useState(prefersReducedMotion)
  const [pos, setPos] = useState(() => (reduced ? { index: 5, chars: SCRIPT[5].text.length } : { index: 0, chars: 0 }))
  const [active, setActive] = useState(false)
  const posRef = useRef(pos)

  useEffect(() => {
    if (reduced) return undefined
    const el = rootRef.current
    let inView = true
    const update = () => setActive(inView && !document.hidden)
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update() }, { threshold: 0.15 })
      : null
    if (io && el) io.observe(el)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      io?.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [reduced, rootRef])

  useEffect(() => {
    if (!active) return undefined
    let timer = null
    const step = () => {
      let { index, chars } = posRef.current
      const len = SCRIPT[index].text.length
      if (chars < len) {
        chars = Math.min(len, chars + 2)
        timer = setTimeout(step, chars < len ? TYPE_MS : HOLD_MS)
      } else {
        index = (index + 1) % SCRIPT.length
        chars = 0
        timer = setTimeout(step, TYPE_MS)
      }
      posRef.current = { index, chars }
      setPos(posRef.current)
    }
    timer = setTimeout(step, TYPE_MS)
    return () => clearTimeout(timer)
  }, [active])

  return { ...pos, typing: active && pos.chars < SCRIPT[pos.index].text.length }
}

function HiveCore() {
  const rootRef = useRef(null)
  const { index, chars, typing } = useScript(rootRef)
  const speaker = SCRIPT[index].who
  const calls = SCRIPT.slice(0, index + 1).filter((l) => ROLES[l.who]).length
  const first = Math.max(0, index - VISIBLE_LINES + 1)
  const lines = SCRIPT.slice(first, index + 1)

  return (
    <div className="lp-stage" ref={rootRef}>
      <div className="lp-core" role="img" aria-label="Three people and four agents in one live room, debating how to open a beta. Each speaker lights up as their words stream in.">
        <svg className="lp-bezel" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
          <circle className="lp-bezel-ring" cx="100" cy="100" r="98" />
          {Array.from({ length: 72 }, (_, i) => {
            const major = i % 6 === 0
            const a = (i / 72) * Math.PI * 2
            const r1 = 98
            const r2 = major ? 93 : 95.5
            return (
              <line
                key={i}
                className={major ? 'tick major' : 'tick'}
                x1={100 + Math.sin(a) * r1} y1={100 - Math.cos(a) * r1}
                x2={100 + Math.sin(a) * r2} y2={100 - Math.cos(a) * r2}
              />
            )
          })}
          <circle className="lp-orbit-line" cx="100" cy="100" r="89" />
        </svg>

        <div className="lp-platter" aria-hidden="true">
          <div className="lp-groove" />
          <div className="lp-hub">
            <div className="lp-well">
              <span className="lp-well-glyph">{textGlyph('⬡')}</span>
              <span className="lp-well-label">live</span>
            </div>
          </div>
        </div>

        <div className="lp-orbit agents" aria-hidden="true">
          {CORE_AGENTS.map((id, i) => (
            <span key={id} className={`lp-node agent${speaker === id ? ' is-live' : ''}`} style={{ '--a': `${i * 90 + 45}deg` }}>
              <span className="lp-node-face">{textGlyph(ROLES[id].glyph)}</span>
            </span>
          ))}
        </div>
        <div className="lp-orbit people" aria-hidden="true">
          {CORE_PEOPLE.map((p, i) => (
            <span key={p.id} className={`lp-node human${speaker === p.id ? ' is-live' : ''}`} style={{ '--a': `${i * 120 + 20}deg` }}>
              <span className="lp-node-face">{p.initial}</span>
            </span>
          ))}
        </div>

        <div className="lp-readout tl" aria-hidden="true">
          <span>people <b>03</b></span>
          <span>agents <b>04</b></span>
        </div>
        <div className="lp-readout br" aria-hidden="true">
          <span>calls <b>{String(calls).padStart(2, '0')}/{CALL_BUDGET}</b></span>
          <span>{PATTERNS.debate.name.toLowerCase()}</span>
        </div>
      </div>

      <div className="lp-stream" aria-hidden="true">
        <div className="lp-stream-head">
          <span className="label-mono">Live token stream</span>
          <span className="lp-stream-meta"><span className="dot live" /> 3 people watching</span>
        </div>
        <div className="lp-stream-body">
          {lines.map((line, i) => {
            const at = first + i
            const current = at === index
            const who = speakerOf(line.who)
            return (
              <p key={at} className={`lp-line ${who.kind}${current ? ' current' : ''}`}>
                <span className="lp-who">{who.name}</span>
                <span className="lp-said">
                  {current ? line.text.slice(0, chars) : line.text}
                  {current && typing && <span className="caret" />}
                </span>
              </p>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function RoomCrowd({ people, agents }) {
  return (
    <span className="lp-crowd" aria-hidden="true">
      {Array.from({ length: people }, (_, i) => <span key={`p${i}`} className="lp-crowd-person" />)}
      <span className="lp-crowd-sep" />
      {Array.from({ length: agents }, (_, i) => <span key={`a${i}`} className="lp-crowd-agent" />)}
    </span>
  )
}

const archGlyphs = (id) => PATTERNS[id].team.slice(0, 3).map((role) => textGlyph(ROLES[role]?.glyph)).join(' ')

export function Landing({ runtime }) {
  return (
    <div className="landing">
      <section className="lp-hero" aria-labelledby="lp-title">
        <div className="lp-hero-copy">
          <span className="eyebrow"><span className="dot live" aria-hidden="true" /> Multiplayer · multi-agent</span>
          <h1 className="lp-title" id="lp-title">
            <span className="lp-title-human">People</span> and <span className="lp-title-agent">agent teams</span>, working in one live room.
          </h1>
          <p className="lp-lede">
            Invite your team, choose one of nine multi-agent architectures, and watch the agents plan, debate and
            write in real time. Everyone in the room sees every token, can pin facts to a shared board, vote with
            the agents, and steer the run while it happens.
          </p>
          <div className="lp-actions">
            <a className="btn btn-primary lp-cta" href="#/live">Start a room <span aria-hidden="true">→</span></a>
            <a className="btn lp-cta" href="#/demo">Watch the demo</a>
          </div>
          <dl className="lp-facts">
            <div><dt>architectures</dt><dd>9</dd></div>
            <div><dt>model options</dt><dd>4</dd></div>
            <div><dt>to run, no sign-up</dt><dd>$0</dd></div>
          </dl>
        </div>
        <HiveCore />
      </section>

      <section className="lp-block" aria-labelledby="lp-rooms-title">
        <div className="lp-block-head">
          <span className="label-mono">Four rooms</span>
          <h2 id="lp-rooms-title">Who is in the room, and who does the work.</h2>
        </div>
        <div className="lp-rooms">
          {ROOMS.map((r) => (
            <a
              key={r.key}
              className={`lp-room ${r.key}`}
              href={`#/${r.section}`}
              onClick={(e) => {
                // A plain click opens the setup with this room type picked; a
                // new-tab click just opens the section.
                if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) hintCrew(r.section, r.team ? 'team' : 'single')
              }}
            >
              <span className="lp-room-top">
                <span className="lp-room-axes">{r.who} · {r.crew}</span>
                <RoomCrowd people={r.people} agents={r.agents} />
              </span>
              <span className="lp-room-name">{r.name}</span>
              <span className="lp-room-line">{r.line}</span>
              <span className="lp-room-cta">Opens {SECTION_NAME[r.section]} <span aria-hidden="true">→</span></span>
            </a>
          ))}
        </div>
      </section>

      <section className="lp-block" aria-labelledby="lp-archs-title">
        <div className="lp-block-head">
          <span className="label-mono">Nine architectures</span>
          <h2 id="lp-archs-title">Choose how the agents organize, or let the Architect choose.</h2>
        </div>
        <ol className="lp-archs">
          {PATTERN_ORDER.map((id, i) => (
            <li key={id} className="lp-arch">
              <span className="lp-arch-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="lp-arch-glyphs" aria-hidden="true">{archGlyphs(id)}</span>
              <span className="lp-arch-name">{PATTERNS[id].name}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-block" aria-labelledby="lp-steps-title">
        <div className="lp-block-head">
          <span className="label-mono">How a run works</span>
          <h2 id="lp-steps-title">Three steps, and you can step in at any point.</h2>
        </div>
        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="lp-step">
              <span className="lp-step-n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="lp-footer">
        <span className="lp-footer-line">
          <span className={`runtime-dot ${runtime ? runtime.mode : 'pending'}`} aria-hidden="true" />
          {!runtime
            ? 'Checking which runtime is serving this page.'
            : runtime.mode === 'server'
              ? 'Running on the Node server: WebSocket rooms and a SQLite timeline.'
              : 'Static build: rooms sync between devices over an end-to-end encrypted relay, and agents run in the host tab.'}
        </span>
        <a className="text-link" href="#/about">How HiveMind is built <span aria-hidden="true">→</span></a>
      </footer>
    </div>
  )
}
