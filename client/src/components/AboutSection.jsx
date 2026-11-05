import React, { useRef } from 'react'
import { PATTERNS, PATTERN_ORDER, TURN_TAKING, defaultConfig, estimateCalls, turnTakingFor } from '@shared/swarm/patterns.js'
import { ROLES, agentCard } from '@shared/swarm/roles.js'
import { TASK_STATE } from '@shared/swarm/a2a.js'
import { PatternShape } from '../demo/PatternShape'
import { RoomGlyph } from './hive/PatternGlyph'

// The About page: what HiveMind is, the four rooms, the nine architectures, how
// agents and people share one room, and how it is built. Pattern and role
// content comes straight from the engine's catalogs, so this page cannot
// describe an architecture the engine doesn't run.

// Glyphs like ✳ ✎ ✓ have emoji forms on some systems; VS15 keeps them text.
const text = (glyph) => `${glyph}︎`

const SECTIONS = [
  ['rooms', 'Rooms'],
  ['run', 'Team runs'],
  ['patterns', 'Architectures'],
  ['axes', 'Design axes'],
  ['talk', 'How agents talk'],
  ['roles', 'Roles'],
  ['cards', 'Agent cards'],
  ['loop', 'Humans in the loop'],
  ['system', 'System'],
  ['guards', 'Guardrails'],
  ['stack', 'Stack'],
]

const ROOMS = [
  { id: 'solo', name: 'Solo', who: 'Just me', crew: 'One agent', where: 'sample', body: 'You and one agent. A private place to learn the moves before anyone else joins.' },
  { id: 'team', name: 'Agent team', who: 'Just me', crew: 'Agent team', where: 'sample', body: 'You and a team of agents, organized in whichever of the nine architectures you pick.' },
  { id: 'multiplayer', name: 'Multiplayer', who: 'My team', crew: 'One agent', where: 'live', body: 'Your team shares one live agent. Everyone sees every token and anyone can steer.' },
  { id: 'hive', name: 'Hive', who: 'My team', crew: 'Agent team', where: 'live', body: 'Your team and a team of agents in one room, on one goal, on one shared blackboard.' },
]

const RUN_STEPS = [
  { title: 'Someone sets the goal', body: 'Any teammate sends a message. It is length-capped, stripped of control characters, checked for prompt-injection phrasing, and appended to the room’s timeline.' },
  { title: 'The room picks a shape', body: 'The architecture comes from the room’s setup, or from the Architect agent, which reads the goal and picks the cheapest pattern that fits the work and the budget.' },
  { title: 'Agents work on a shared board', body: 'Each step is one model call: the agent’s role, the goal, the blackboard, the humans’ messages and the teammates’ outputs it was handed. Tagged lines land on the board for everyone.' },
  { title: 'Everyone watches the same run', body: 'Streamed text, graph pulses, bids, votes and board changes reach every participant. Someone who joins mid-run gets a compact snapshot of the whole view.' },
  { title: 'People stay in charge', body: 'Pin a constraint, @mention an agent, vote with the debate peers, answer the Monitor, or redirect, pause and stop the whole team.' },
  { title: 'One answer, on the record', body: 'The final answer is marked as such. Every step is stored as an A2A-shaped task and message, so the handoffs can be traced. Fork with another architecture to compare.' },
]

const SPECTRUM = [
  { stop: 'Fixed', patterns: ['sequential'], body: 'The shape is decided at design time and never changes.' },
  { stop: 'Planned', patterns: ['router', 'orchestrator', 'hierarchical', 'parallel', 'fanout'], body: 'A coordinating agent plans the shape at runtime, then the team runs the plan.' },
  { stop: 'Peer', patterns: ['debate'], body: 'Nobody is in charge. Equal peers argue in turns and settle it by vote.' },
  { stop: 'Emergent', patterns: ['swarm'], body: 'The order of work emerges from a shared board, by bids or another turn-taking rule.' },
  { stop: 'Self-designing', patterns: ['auto'], body: 'The system chooses its own architecture for each goal.' },
]

// Every turn-taking strategy, with the teams that offer it (the default first).
const TURN_TEAMS = [['debate', turnTakingFor('debate')], ['swarm', turnTakingFor('swarm')]]
const TURN_NOTE = { auction: ' Every bid carries its reason, and ties break the same way every time.' }
const TURNS = [
  ...Object.values(TURN_TAKING).map((t) => ({
    name: t.name,
    where: TURN_TEAMS.filter(([, ids]) => ids.includes(t.id)).map(([p, ids]) => `${PATTERNS[p].name}${ids[0] === t.id ? ' (default)' : ''}`).join(', '),
    body: `${t.summary}${TURN_NOTE[t.id] || ''}`,
  })),
  { name: '@mentions', where: 'Every team', body: 'People call on any agent by role. Under priority bids it raises that agent’s bid; elsewhere the agent sees the message marked as addressed to it.' },
]

const LOG_SAMPLE = [
  { who: 'Maya', kind: 'human', text: 'Offline mode: Q3 vs. Q4?' },
  { who: 'Jordan', kind: 'human', text: 'pinned a constraint' },
  { who: 'Architect', kind: 'system', text: 'chose Peer-to-peer' },
  { who: 'Builder', kind: 'agent', text: 'round 1: go big, with a flag' },
  { who: 'Skeptic', kind: 'agent', text: 'round 1: price the failure modes' },
  { who: 'Vote', kind: 'system', text: 'Pragmatist wins, 3 of 5' },
]

const BOARD_SAMPLE = [
  { kind: 'Constraints', text: 'Support can only absorb one launch this quarter', by: 'Jordan', human: true },
  { kind: 'Facts', text: 'First users judge it on speed and clarity', by: 'Researcher' },
  { kind: 'Questions', text: 'Who signs off on the pilot?', by: 'Interrogator' },
  { kind: 'Decisions', text: 'Start with a two week pilot for one team', by: 'Analyst' },
]

const ROLE_GROUPS = (() => {
  const groups = [
    { name: 'Coordinators', roles: ['architect', 'router', 'orchestrator', 'planner', 'vp', 'manager', 'splitter', 'combiner', 'synthesizer'] },
    { name: 'Specialists', roles: ['researcher', 'interrogator', 'analyst', 'writer', 'critic', 'worker'] },
    { name: 'Debate peers', roles: ['builder', 'skeptic', 'pragmatist'] },
    { name: 'Observer', roles: ['monitor'] },
  ].map((g) => ({ ...g, roles: g.roles.filter((id) => ROLES[id]) }))
  // A role added to the catalog later still shows up, just ungrouped.
  const listed = new Set(groups.flatMap((g) => g.roles))
  const rest = Object.keys(ROLES).filter((id) => !listed.has(id))
  return rest.length ? [...groups, { name: 'Other', roles: rest }] : groups
})()
const ROLE_COUNT = Object.keys(ROLES).length

const HUMAN_MOVES = [
  ['Pin', 'Add a constraint, fact, question or decision to the board. Constraints are human-only and bind every agent.'],
  ['@mention', 'Call on one agent by role, like “@critic check the numbers”.'],
  ['Vote', 'Debate peers propose; people vote with them. The window is 20 seconds and closes early once everyone has voted. Ties go to the human majority, then to the first proposal.'],
  ['Answer the Monitor', 'Continue gives the team 4 more calls. Wrap up has the Synthesizer write the best answer from the work so far.'],
  ['Redirect, pause, stop', 'The same controls as a single agent, applied to the whole team. A redirect starts a new run on the new instruction.'],
  ['Fork with another shape', 'Branch the room, board included, and run the same goal under a different architecture to compare cost, time and answer.'],
]

const MONITOR_WATCHES = [
  ['Budget', 'model calls against the team’s budget, flagged at 80%'],
  ['Cost', 'an estimate of tokens used so far'],
  ['Time', 'elapsed time for the run'],
  ['Loops', 'an agent repeating itself almost word for word'],
  ['Inputs', 'human messages flagged as possible prompt injection'],
]

const TEAM_GUARDS = [
  ['Budgets', 'Every architecture runs on a model-call budget (16 at most) with one call held back for the final answer. Continue adds 4, never past a hard cap of 24.'],
  ['Escalate, don’t act', 'The Monitor has no authority of its own. At the budget, or when a swarm keeps repeating itself, it asks the people in the room. No answer in 30 seconds means wrap up.'],
  ['Loop detection', 'Output that overlaps the same agent’s last turn by more than 90% is flagged. In a swarm a repeater loses priority (its bids are penalized, or it waits at the back when agents opt in), and a second repeat makes the Monitor ask the room.'],
  ['Fan-in deadline', 'Fan-out waits 60 seconds for its personas (4 minutes on the free model), then merges what arrived and says what is missing.'],
  ['Plans are validated', 'JSON plans are parsed defensively, roles must be known, sizes are capped, and a task may only depend on earlier tasks, so every task graph is acyclic. Unreadable plans fall back to a safe default.'],
  ['Prompt caps', 'Each teammate input is cut to 900 characters, the board to 1,800 and an agent’s whole context to 9,000. Board sections have their own item caps.'],
  ['Inputs stay data', 'Messages flagged as possible prompt injection reach agents labelled as data, never as instructions. Constraints pinned by people are listed as rules in every prompt.'],
  ['Honest fallbacks', 'If a model fails on one step, a scripted stand-in covers that step only, the message is tagged scripted, and the room is told. Agents have no tools, and their prompts say so.'],
]

const PLATFORM_GUARDS = [
  ['Rate limits', 'Per-IP limits on every REST route and a frame budget per WebSocket connection, so typing spam can’t turn into database writes and broadcasts.'],
  ['Input hygiene', '4,000-character messages, 500-character redirects, control characters stripped, prompt-injection phrasing flagged on the event.'],
  ['Never leak a run', 'One run per room, cleanup before error reporting, and a watchdog on every team run, so a room can’t get stuck running.'],
  ['Safe rendering', 'Markdown becomes React elements, never innerHTML, so nobody’s output can inject markup into someone else’s browser.'],
  ['Bring your own key', 'A Groq key stays in the tab that typed it. The server holds it in memory for that session and the edge function forwards it once. Nothing stores or logs it.'],
  ['Split-brain protection', 'In the static runtime the lowest-id tab hosts. A tab that wrongly believes it hosts steps down and re-syncs, and actions nobody acknowledged are replayed on takeover.'],
]

const AXES = [['control', 'Control'], ['execution', 'Execution'], ['collaboration', 'Collaboration'], ['timing', 'Timing']]

const RUNTIMES = [
  ['Transport', 'WebSocket rooms', 'Encrypted relay over 4 public MQTT brokers, plus BroadcastChannel'],
  ['Timeline and board', 'SQLite, Node’s built-in', 'localStorage, one record per room'],
  ['Where agents run', 'The server process', 'The host tab; the lowest-id tab takes over'],
  ['Brains', 'Free model, Groq, Ollama, scripted', 'Free model, Groq, scripted'],
]

const STACK = ['React 18', 'Vite', 'Node 22', 'Express', 'ws', 'node:sqlite', 'MQTT over WebSockets', 'Web Crypto (AES-GCM, PBKDF2)', 'BroadcastChannel', 'Vercel Edge Functions', 'Groq', 'Ollama', 'A2A agent cards', 'Pure ES module engine']

function callsLabel(id) {
  if (id === 'auto') return '1 call to choose, then the chosen team'
  return `about ${estimateCalls(id, defaultConfig(id, 'groq'))} model calls`
}

function HeroOrbit() {
  const ring = (n, r, offset = 0) => Array.from({ length: n }, (_, i) => {
    const t = ((i / n) * 360 + offset) * (Math.PI / 180)
    return [Math.round((120 + r * Math.cos(t)) * 10) / 10, Math.round((120 + r * Math.sin(t)) * 10) / 10]
  })
  const humans = ring(3, 98, -60)
  const agents = ring(5, 58, -90)
  return (
    <svg className="about-orbit" viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <circle className="about-orbit-ring" cx="120" cy="120" r="98" />
      <circle className="about-orbit-ring faint" cx="120" cy="120" r="78" />
      <circle className="about-orbit-ring" cx="120" cy="120" r="58" />
      {agents.map(([x, y], i) => <line key={`l${i}`} className="about-orbit-link" x1={x} y1={y} x2="120" y2="120" />)}
      <rect className="about-orbit-board" x="102" y="102" width="36" height="36" rx="9" />
      <text className="about-orbit-label" x="120" y="123.5" textAnchor="middle">BOARD</text>
      {agents.map(([x, y], i) => <circle key={`a${i}`} className={`about-orbit-agent${i === 1 ? ' live' : ''}`} cx={x} cy={y} r="6.5" />)}
      {humans.map(([x, y], i) => <circle key={`h${i}`} className="about-orbit-human" cx={x} cy={y} r="7.5" />)}
    </svg>
  )
}

function Section({ id, eyebrow, title, lede, children, refs, className = '' }) {
  return (
    <section className={`about-section ${className}`.trim()} aria-labelledby={`about-h-${id}`}>
      <span className="eyebrow">{eyebrow}</span>
      <h2 id={`about-h-${id}`} tabIndex={-1} ref={(el) => { if (refs) refs.current[id] = el }}>{title}</h2>
      {lede && <p className="about-lede">{lede}</p>}
      {children}
    </section>
  )
}

export function AboutSection({ onSelect, runtime }) {
  const heads = useRef({})
  const card = agentCard('critic')

  // In-page jumps scroll and move focus to the heading. No hash anchors: the
  // hash is the router's, and an unknown route would send the reader Home.
  const jump = (id) => {
    const el = heads.current[id]
    if (!el) return
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    el.focus({ preventScroll: true })
  }

  return (
    <div className="about">
      <section className="about-section about-hero" aria-labelledby="about-h-what">
        <div className="about-hero-copy">
          <span className="eyebrow">About HiveMind</span>
          <h2 id="about-h-what">A shared room for a team of people and a team of agents.</h2>
          <p className="about-lede">
            Most AI tools seat one person in front of one model. HiveMind puts the whole team in the room: everyone watches
            the same run, anyone can steer it, and the work is done by one agent or by a team of agents organized in one of
            nine architectures. People pin constraints, call on agents by name, vote alongside them, and answer when the
            Monitor asks.
          </p>
          <p className="about-note">
            The agents have no tools and no web access. They work from the conversation, the shared blackboard and what
            they already know, and they say when something needs checking.
          </p>
          <div className="about-cta">
            <button className="btn btn-primary" onClick={() => onSelect('demo')}>Watch the Hive demo</button>
            <button className="btn" onClick={() => onSelect('live')}>Open a live room</button>
            <button className="btn btn-ghost" onClick={() => onSelect('sample')}>Try it solo</button>
          </div>
        </div>
        <div className="about-hero-art">
          <HeroOrbit />
          <div className="about-hero-legend">
            <span><span className="dot human" aria-hidden="true" />People</span>
            <span><span className="dot agent" aria-hidden="true" />Agents</span>
          </div>
        </div>
      </section>

      <nav className="about-toc" aria-label="On this page">
        <span className="label-mono">On this page</span>
        <div className="about-toc-list">
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" className="chip" onClick={() => jump(id)}>{label}</button>
          ))}
        </div>
      </nav>

      <Section id="rooms" refs={heads} eyebrow="Four rooms" title="Two choices, four kinds of room."
        lede="Who is in the room, and who does the work. Pick both when you create a room; the team’s architecture can change between runs.">
        <div className="about-rooms">
          <span className="about-rooms-corner" aria-hidden="true" />
          <span className="about-rooms-col label-mono" aria-hidden="true">One agent</span>
          <span className="about-rooms-col label-mono" aria-hidden="true">Agent team</span>
          {['Just me', 'My team'].map((who) => (
            <React.Fragment key={who}>
              <span className="about-rooms-row label-mono" aria-hidden="true">{who}</span>
              {ROOMS.filter((r) => r.who === who).map((r) => (
                <div key={r.id} className="about-room">
                  <div className="about-room-head">
                    <RoomGlyph kind={r.id} className="about-room-glyph" />
                    <div>
                      <h3>{r.name}</h3>
                      <span className="about-room-axes label-mono">{r.who} · {r.crew}</span>
                    </div>
                  </div>
                  <p>{r.body}</p>
                  <button type="button" className="about-link" onClick={() => onSelect(r.where)}>
                    Open in {r.where === 'live' ? 'Live' : 'Sample'}<span aria-hidden="true"> →</span>
                  </button>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </Section>

      <Section id="run" refs={heads} eyebrow="Team runs" title="From one message to a team’s answer.">
        <ol className="about-flow">
          {RUN_STEPS.map((s, i) => (
            <li key={s.title} className="about-step">
              <span className="about-step-n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="patterns" refs={heads} eyebrow="Nine architectures" title="Eight classic patterns, plus one that picks for you."
        lede="Each one is a different answer to who decides, who works in parallel, and how results come back together. The engine runs all nine for real.">
        <div className="about-patterns">
          {PATTERN_ORDER.map((id) => {
            const p = PATTERNS[id]
            return (
              <article key={id} className="about-pattern">
                <div className="about-pattern-shape"><PatternShape pattern={id} /></div>
                <div className="about-pattern-head">
                  <h3>{p.name}</h3>
                  <span className="label-mono">{p.aka}</span>
                </div>
                <p>{p.summary}</p>
                <p className="about-pattern-when"><span className="label-mono">Fits when</span>{p.usefulWhen}</p>
                <ul className="about-pattern-tradeoffs">
                  <li><span className="about-plus" aria-label="Strength">+</span>{p.pros[0]}</li>
                  <li><span className="about-minus" aria-label="Cost">−</span>{p.cons[0]}</li>
                </ul>
                <span className="about-pattern-calls label-mono">{callsLabel(id)}</span>
              </article>
            )
          })}
        </div>
      </Section>

      <Section id="axes" refs={heads} eyebrow="Design axes" title="Four questions describe every architecture."
        lede="Who holds control, how the work executes, how agents combine their results, and when the shape is decided.">
        <div className="about-axes-wrap">
          {/* Explicit roles: on phones the rows restack with display:block, which drops native table semantics. */}
          <table className="about-axes" role="table">
            <thead role="rowgroup">
              <tr role="row">{['Architecture', ...AXES.map(([, label]) => label)].map((h) => <th key={h} scope="col" role="columnheader">{h}</th>)}</tr>
            </thead>
            <tbody role="rowgroup">
              {PATTERN_ORDER.map((id) => (
                <tr key={id} role="row">
                  <th scope="row" role="rowheader">{PATTERNS[id].name}</th>
                  {AXES.map(([key, label]) => <td key={key} role="cell" data-label={label}>{PATTERNS[id].axes[key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="about-subhead">The autonomy spectrum</h3>
        <ol className="about-spectrum">
          {SPECTRUM.map((s, i) => (
            <li key={s.stop} className="about-spectrum-stop" style={{ '--about-stop': i }}>
              <span className="about-spectrum-tick" aria-hidden="true" />
              <span className="label-mono">{s.stop}</span>
              <strong>{s.patterns.map((id) => PATTERNS[id].name).join(', ')}</strong>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="about-note">
          More autonomy buys flexibility and costs predictability, so the guardrails tighten as autonomy grows: turn caps,
          loop detection, deterministic tie-breaks, and escalation to people.
        </p>
      </Section>

      <Section id="talk" refs={heads} eyebrow="How agents talk" title="A group chat, a blackboard, and rules for taking turns.">
        <div className="about-talk">
          <div className="about-talk-col">
            <h3>Group chat</h3>
            <p>
              The room’s timeline is an append-only log. Agent messages, human messages, pins, votes and Monitor notes are
              all events in it, so the record is complete and anyone who joins late can catch up.
            </p>
            <p>
              It travels over the same transport as before: WebSocket rooms on the Node server, or the encrypted relay on
              the static build.
            </p>
            <ol className="about-log" aria-label="Example timeline">
              {LOG_SAMPLE.map((e) => (
                <li key={e.text} className={`about-log-row is-${e.kind}`}>
                  <span className="about-log-who">{e.who}</span>
                  <span className="about-log-text">{e.text}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="about-talk-col">
            <h3>Blackboard</h3>
            <p>
              Structured shared state: goal, constraints, plan, facts, open questions, decisions, a draft and the final
              answer. Agents write tagged lines such as <code>FACT:</code> and <code>DECISION:</code>; people pin.
            </p>
            <div className="about-board" aria-label="Example blackboard">
              <span className="label-mono">Blackboard</span>
              {BOARD_SAMPLE.map((b) => (
                <div key={b.kind} className="about-board-row">
                  <span className="about-board-kind label-mono">{b.kind}</span>
                  <span className="about-board-text">{b.text}</span>
                  <span className={`badge ${b.human ? 'human' : 'agent'}`}>{b.by}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="about-talk-col">
            <h3>Turn-taking</h3>
            <ul className="about-turns">
              {TURNS.map((t) => (
                <li key={t.name}>
                  <div className="about-turns-head"><strong>{t.name}</strong><span className="label-mono">{t.where}</span></div>
                  <p>{t.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="roles" refs={heads} eyebrow="Roles" title={`${ROLE_COUNT} roles, each with one job.`}
        lede="Every agent is a role prompt plus the shared context. Managers, workers and fan-out personas are instances of a role with their own focus.">
        <div className="about-roles">
          {ROLE_GROUPS.map((g) => (
            <div key={g.name} className="about-role-group">
              <span className="label-mono">{g.name}</span>
              <ul>
                {g.roles.map((id) => (
                  <li key={id} className="about-role">
                    <span className="avatar-neu agent about-role-glyph" aria-hidden="true">{text(ROLES[id].glyph)}</span>
                    <div>
                      <strong>{ROLES[id].name}</strong>
                      <p>{ROLES[id].description}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section id="cards" refs={heads} eyebrow="Agent cards" title="Every agent publishes an A2A-style card."
        lede="Name, description, capabilities, input and output modes, and skills. The cards are generated at build time from the same role catalog the engine runs, and served by this app as static JSON.">
        <div className="about-cards">
          <div className="about-cards-copy">
            <ul className="about-endpoints">
              <li>
                <a className="about-endpoint" href="/.well-known/agent-card.json" target="_blank" rel="noopener">/.well-known/agent-card.json</a>
                <span>HiveMind itself, with one skill per architecture.</span>
              </li>
              <li>
                <span className="about-endpoint is-static">/agents/&lt;role&gt;.json</span>
                <span>One card per role:</span>
              </li>
            </ul>
            <div className="about-card-links">
              {Object.keys(ROLES).map((id) => (
                <a key={id} className="chip inset" href={`/agents/${id}.json`} target="_blank" rel="noopener">{ROLES[id].name}</a>
              ))}
            </div>
            <p>
              Inside a run, every agent step is recorded as an A2A-shaped Task, with a state of <code>{TASK_STATE.working}</code>,{' '}
              <code>{TASK_STATE.completed}</code>, <code>{TASK_STATE.failed}</code> or <code>{TASK_STATE.canceled}</code>,
              and its output as a Message whose <code>referenceTaskIds</code> point at the teammates’ work it was given.
              The room id is the <code>contextId</code>, so a room’s handoff graph can be rebuilt from its timeline.
            </p>
            <p className="about-note">Discovery only: HiveMind does not expose an A2A RPC endpoint.</p>
          </div>
          <pre className="about-json" aria-label="The Critic’s agent card" tabIndex={0}>{JSON.stringify(card, null, 2)}</pre>
        </div>
      </Section>

      <Section id="loop" refs={heads} eyebrow="Humans in the loop" title="The Monitor watches. People decide.">
        <div className="about-loop">
          <div className="about-loop-monitor">
            <div className="about-loop-head">
              <span className="avatar-neu agent" aria-hidden="true">{text(ROLES.monitor.glyph)}</span>
              <div>
                <h3>The Monitor</h3>
                <span className="label-mono">Deterministic code, not a model</span>
              </div>
            </div>
            <dl className="about-watch">
              {MONITOR_WATCHES.map(([k, v]) => (
                <div key={k}><dt className="label-mono">{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
            <p>
              It never steers the team itself. When the team reaches its budget, or a swarm keeps repeating itself, it stops
              and asks the people in the room: continue or wrap up.
            </p>
          </div>
          <ul className="about-moves">
            {HUMAN_MOVES.map(([k, v]) => (
              <li key={k}><strong>{k}</strong><p>{v}</p></li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="system" refs={heads} eyebrow="System" title="One client, two runtimes, one engine."
        lede={<>The client probes <code>/api/health</code> to find out where it runs and picks a transport. Both transports emit the same messages, so the reducer, the timeline and the Hive panels are shared verbatim.{runtime && <> You are on the <strong>{runtime.mode === 'server' ? 'server' : 'static'}</strong> runtime right now.</>}</>}>
        <div className="about-arch" role="img" aria-label="The browser client talks to either the Node server over WebSockets or the static Vercel runtime over an encrypted relay. Both run the same multi-agent engine.">
          <div className="about-arch-box wide">
            <span className="label-mono">Browser</span>
            <strong>React + Vite</strong>
            <span>Demo, Sample and Live, one shared workspace, one reducer.</span>
          </div>
          <div className="about-arch-links" aria-hidden="true"><span>WebSocket</span><span>Encrypted relay</span></div>
          <div className="about-arch-pair">
            <div className="about-arch-box">
              <span className="label-mono">Server runtime</span>
              <strong>Node, one process</strong>
              <span>Express REST, WebSocket rooms, SQLite timeline, guardrails. Team runs execute in the server.</span>
            </div>
            <div className="about-arch-box">
              <span className="label-mono">Static runtime</span>
              <strong>Vercel</strong>
              <span>No backend of its own. Frames are AES-GCM encrypted and fanned out over public relays; team runs execute in the host tab.</span>
            </div>
          </div>
          <div className="about-arch-links" aria-hidden="true"><span>imports</span><span>imports</span></div>
          <div className="about-arch-box engine">
            <span className="label-mono">Shared engine</span>
            <strong>server/swarm</strong>
            <span>Plain ES modules with no Node or DOM APIs. The server and the host tab import the same files, so both run the exact same orchestration.</span>
          </div>
        </div>
        <div className="about-axes-wrap">
          <table className="about-axes about-compare" role="table">
            <thead role="rowgroup">
              <tr role="row"><th scope="col" role="columnheader"><span className="about-sr">Aspect</span></th><th scope="col" role="columnheader">Server runtime</th><th scope="col" role="columnheader">Static runtime</th></tr>
            </thead>
            <tbody role="rowgroup">
              {RUNTIMES.map(([aspect, server, local]) => (
                <tr key={aspect} role="row">
                  <th scope="row" role="rowheader">{aspect}</th>
                  <td role="cell" data-label="Server">{server}</td>
                  <td role="cell" data-label="Static">{local}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="guards" refs={heads} eyebrow="Guardrails" title="Built so a team never watches it hard-fail.">
        <div className="about-guards">
          <div>
            <h3 className="about-subhead">Agent teams</h3>
            <dl className="about-guard-list">
              {TEAM_GUARDS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </div>
          <div>
            <h3 className="about-subhead">Platform</h3>
            <dl className="about-guard-list">
              {PLATFORM_GUARDS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </div>
        </div>
      </Section>

      <Section id="stack" refs={heads} eyebrow="Stack" title="Deliberately small.">
        <div className="about-stack">{STACK.map((s) => <span key={s} className="chip">{s}</span>)}</div>
        <p className="about-lede">
          The server has two runtime dependencies, <code>express</code> and <code>ws</code>, and uses Node’s built-in SQLite,
          so there is nothing to compile and nothing to sign up for. The multi-agent engine has no dependencies at all. An
          end-to-end suite boots a real server and drives real WebSocket clients through the multiplayer flow, and the
          engine is exercised across every architecture with the scripted brain.
        </p>
      </Section>

      <p className="about-credit">Designed and built by Ameer Sohail Shaik.</p>
    </div>
  )
}
