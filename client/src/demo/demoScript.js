// Choreographed demo — a scripted multiplayer session that replays entirely
// client-side. Same UI components as the real thing; zero network calls.

export const CAST = {
  maya: { id: 'demo_maya', name: 'Maya', color: '#4F8FE8' },
  jordan: { id: 'demo_jordan', name: 'Jordan', color: '#E85D55' },
  sam: { id: 'demo_sam', name: 'Sam', color: '#9DB8FF' },
  agent: { id: 'agent', name: 'HiveMind', color: '#255DCE' },
}

const STREAM_A = `On it, Maya. Drafting the Q3 mobile release plan now.

**Timeline (6 weeks)**

- **Weeks 1–2 — Feature freeze & hardening.** Lock scope, burn down the P1 bug list, start release-candidate builds.
- **Weeks 3–4 — Beta rollout.** 10% staged rollout via TestFlight and Play Console, crash-rate gate at 99.7% sessions.
- **Week 5 — Full rollout.** Gradual ramp 25% → 50% → 100% with automatic halt on regression.
- **Week 6 — Post-launch.** Metrics review, retro, and fast-follow patch window.

**Owners**

- Engineering readiness: Jordan
- Release comms & app-store assets: Maya
- Metrics dashboard & rollout gates: Sam

Now moving to the risk register —`

const STREAM_B = `Understood, Jordan — pivoting to engineering risks first. Pricing moves to a follow-up.

**Engineering risk register (priority order)**

1. **Crash regression in the new navigation stack** — highest exposure. Mitigation: keep the old stack behind a feature flag for one release cycle.
2. **App-store review delay** — historically 2–5 days for this app. Mitigation: submit the RC at the end of week 3, not week 4.
3. **Cold-start time creep** — the new SDKs added ~180ms. Mitigation: defer non-critical SDK init to post-first-frame.
4. **Rollback path** — server-driven config must support downgrade gracefully. Mitigation: contract test on config schema before freeze.

**Recommendation:** treat risks 1 and 4 as launch blockers with named owners; 2 and 3 are trackable.

Sam — your pricing experiment fits cleanly as a fork of this session so it gets its own timeline without derailing launch planning.`

export const SCRIPT = [
  { delay: 500, type: 'join', user: CAST.maya },
  { delay: 900, type: 'join', user: CAST.jordan },
  { delay: 900, type: 'typing', user: CAST.maya, on: true },
  { delay: 1400, type: 'message', user: CAST.maya, text: 'HiveMind, draft a launch plan for the Q3 mobile release — timeline, owners, and risks.' },
  { delay: 700, type: 'agent_start' },
  { delay: 800, type: 'tool_call', tool: 'web_search', query: 'mobile app staged rollout launch checklist' },
  { delay: 1700, type: 'tool_result', tool: 'web_search', result: 'Found 5 sources — staged rollout gates, crash-rate thresholds, and store-review lead times pulled into context.' },
  { delay: 700, type: 'stream', text: STREAM_A },
  { delay: 400, type: 'join', user: CAST.sam },
  { delay: 1100, type: 'message', user: CAST.sam, text: 'Joining late — can we fold the pricing experiment into this plan too?' },
  { delay: 1300, type: 'typing', user: CAST.jordan, on: true },
  { delay: 1500, type: 'redirect', user: CAST.jordan, text: 'Focus on engineering risks first — pricing can come after.' },
  { delay: 300, type: 'interrupt' },
  { delay: 900, type: 'agent_start' },
  { delay: 600, type: 'stream', text: STREAM_B },
  { delay: 500, type: 'agent_done' },
  { delay: 1600, type: 'fork', user: CAST.sam, name: 'Pricing experiment deep-dive' },
  { delay: 1500, type: 'system', text: 'This whole session was a replay — three teammates and one agent, all seeing the same thing live.' },
  { delay: 800, type: 'end' },
]

// Expand stream steps into word-chunk deltas so the player is a flat timeline.
export function expandScript(script) {
  const steps = []
  for (const step of script) {
    if (step.type !== 'stream') { steps.push(step); continue }
    const words = step.text.split(/(?<=\s)/)
    let first = true
    let chunk = ''
    for (const word of words) {
      chunk += word
      if (chunk.split(/\s+/).filter(Boolean).length >= 3) {
        steps.push({ delay: first ? step.delay : 70 + Math.floor(Math.random() * 80), type: 'delta', delta: chunk })
        chunk = ''
        first = false
      }
    }
    if (chunk) steps.push({ delay: first ? step.delay : 70, type: 'delta', delta: chunk })
  }
  return steps
}
