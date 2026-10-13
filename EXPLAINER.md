# HiveMind — The Complete Explainer

> Everything about this project in plain English: what it is, how it works, why it was built this way, what was hard, how it maps to AI roles, and exactly how to talk about it in interviews.
>
> Live: https://hivemind-agents.vercel.app · Code: https://github.com/Sohail-5678/hivemind-ai

---

## 1. The one-liner (memorize this)

**"HiveMind is a multiplayer AI-agent platform: one live agent session that a whole team can watch, steer, and hand off in real time — like a Google Doc, except the document is an AI agent doing the work."**

### 30-second version

AI tools today are single-player: you open a chat, you type, you get an answer in a box only you can see. The best you can do with a teammate is send a read-only transcript. HiveMind makes the *session* the shared thing. Anyone on the team can drop into the same running agent, see every token as it streams, redirect the agent mid-sentence, pause it and hand it to someone else, or fork it into a parallel exploration. It runs on a real-time WebSocket server with an append-only event timeline, works with local models (Ollama) or Groq, and it also ships as a zero-backend static build where multiplayer syncs across browser tabs.

### 2-minute version

Add to the above: the agent engine has a strict run lifecycle (one run per room, abortable with a *reason* — pause, stop, redirect, timeout — so partial output is always kept and labeled); redirects abort the stream, commit the partial, and start a follow-up run with the new instruction injected, with the guarantee that a later human click always wins over an in-flight redirect; providers are behind one streaming interface with first-token deadlines, empty-stream detection, and a fallback chain so a dead or hanging LLM never breaks the room; and the whole thing is covered by a 33-check end-to-end test that boots a real server and drives three WebSocket clients through the entire multiplayer flow.

---

## 2. What problem it solves (the "why")

Every category of work software that went multiplayer became dramatically more valuable: Word → Google Docs, Photoshop → Figma, email → Slack. AI agents are where documents were in 2005 — powerful, but used alone.

That matters more now because **agents are starting to run tasks that take hours or days**. Work at that scale was never meant to be done alone: a product manager scopes it, an engineer redirects it when it goes down the wrong path, an analyst picks it up the next morning. Today each of those people would open their own private chat and lose the others' context. HiveMind turns the agent's work into a **shared, living artifact** instead of a thousand private threads.

This is the exact thesis in Y Combinator's "Multiplayer AI" request for startups — the project is a working answer to it.

---

## 3. What it does — the user's view

Three sections, each with an exit path back to Home:

| Section | What you see | What it's for |
|---|---|---|
| **Demo** | A choreographed replay: three teammates (Maya, Jordan, Sam) and one agent planning a Q3 launch. Maya tasks the agent, Sam joins mid-stream, Jordan redirects it ("risks first, pricing after"), the agent pivots, Sam forks the session. | Shows the full vision in 60 seconds with zero setup. Runs entirely in the browser. |
| **Sample** | A private session with a real agent. | Learn the moves before going multiplayer. |
| **Live** | Create a room, get a 6-character code / invite link, teammates join, everyone shares one agent. | The actual product. |

**The five moves** every participant has:

1. **Message** — task the agent; everyone sees it and the response streams to all.
2. **Redirect** — change the agent's direction *while it is writing*.
3. **Pause / Resume** — freeze the agent for the whole room; resume continues where it stopped.
4. **Stop** — kill the run, keep what it produced.
5. **Fork** — branch the entire session (full history copied) into a new room.

**Agent brains:** a built-in *simulated* agent (zero setup, powers the demo), **Ollama** (any local model, auto-detected, fully private), and **Groq** (real hosted LLM, free API key, bring-your-own — never stored).

---

## 4. How it works — plain English, end to end

Think of a session as **a room with an append-only diary**.

1. **A teammate sends a message.** The server validates it (length caps, control characters stripped, obvious prompt-injection phrases flagged) and writes it into the diary as an *event*.
2. **The room fans it out.** Every connected browser in that room receives the event over a WebSocket within milliseconds, so everyone sees the message appear at the same time.
3. **The agent run starts** — but only if the room is idle (one run at a time per room). The engine reads the last 30 diary entries that matter to the model (every teammate's messages, the agent's previous replies, every redirect), prefixes each with who said it, adds a system prompt that tells the agent it's in a shared session with named people, and starts streaming from the chosen provider.
4. **Tokens stream to everyone.** Each text chunk is buffered for ~90 ms and broadcast as a batch, so all teammates watch the same words appear together. If someone joins mid-stream, their first message from the server is a *snapshot*: the diary so far plus the text streamed so far.
5. **Anyone can steer.** A redirect aborts the in-flight stream with the reason "redirect", commits whatever was written as a partial reply tagged *interrupted*, and immediately starts a follow-up run with the steering instruction injected. Pause, stop, and fork use the same abort-with-a-reason mechanism.
6. **Everything is a durable event.** Messages, replies, tool calls, redirects, pauses, resumes, forks, joins, leaves — all diary entries. Reconnecting is idempotent (events are de-duplicated by id); forking copies the diary into a new room.

### The two runtimes (this is the part interviewers like)

The same React client runs in two very different environments:

| | **Server runtime** (`npm start`) | **Static runtime** (what Vercel serves) |
|---|---|---|
| Real-time transport | WebSocket rooms on a Node server | `BroadcastChannel` between tabs in one browser |
| Diary storage | SQLite (Node's built-in, no native deps) | `localStorage` per room |
| Who can join | Any device that can reach the server (LAN, tunnel) | Other tabs in the same browser |
| Where the agent runs | The server process | The **host tab** (the creator); if it closes, the tab with the lowest id takes over |
| Brains | Simulated · Ollama · Groq | Simulated · Groq (via a Vercel edge function) |

The client detects which world it's in by probing `/api/health` (the Node server answers `realtime: "ws"`, the edge function answers `realtime: "tabs"`), then picks a transport. **Both transports emit the identical message protocol**, so the state reducer, the timeline, presence, and the composer are shared verbatim. That's why the deployed site can demo real multiplayer with no backend at all.

---

## 5. Architecture, file by file

```
hivemind-ai/
├── server/
│   ├── server.js      Express REST API, guardrails (rate limits, input caps, injection
│   │                  flags), static serving with correct cache headers, port fallback
│   ├── websocket.js   Rooms, presence, typing (with auto-expiry), join snapshots that
│   │                  include in-flight stream text, per-connection frame budgets
│   ├── agent.js       The run lifecycle: start / stream / abort-with-reason / finish.
│   │                  Redirect follow-ups, pause/resume, provider adapters (Ollama NDJSON,
│   │                  Groq SSE), first-token deadline, fallback chain, run-leak protection
│   ├── simulated.js   The built-in agent brain (shared with the client bundle)
│   └── db.js          SQLite schema, newest-N event queries, fork (copy timeline)
├── api/
│   ├── chat.js        Vercel Edge Function: streams Groq completions for the static build,
│   │                  BYOK key forwarded once, model allowlist, size caps, no CORS
│   └── health.js      Edge Function: advertises the static runtime
├── client/src/
│   ├── lib/runtime.js         Detects server vs static runtime
│   ├── hooks/sessionReducer.js One reducer for both transports (same message shapes)
│   ├── hooks/useSession.js     WebSocket transport with reconnect/backoff + resync
│   ├── hooks/useLocalRoom.js   BroadcastChannel rooms: host election, snapshots, acks,
│   │                           split-brain demotion, the in-tab agent engine
│   ├── agent/clientAgent.js    Host-tab agent runner (simulated / Groq via edge)
│   ├── components/             Landing · Demo · Sample · Live · About · SessionWorkspace
│   │                           (PresenceBar · AgentTimeline · Composer)
│   ├── lib/markdown.jsx        Safe markdown → React elements (no innerHTML)
│   └── demo/demoScript.js      The choreographed replay
└── test/smoke.test.js          33-check end-to-end multiplayer test
```

---

## 6. The hard problems — your talking points

These are the things that make this more than a chat UI. Each one is a story you can tell.

### 6.1 Redirect semantics without races
*Problem:* A redirect must abort the current stream and start a new run — but what if the user clicks Pause 100 ms later? A naïve `setTimeout(startNewRun)` would un-pause the session behind the user's back.
*Solution:* The redirect hands its steering text to the **aborted run itself**; the run's own finalizer starts the follow-up *synchronously* the moment its slot is free. A pause or stop clicked afterwards overwrites the abort reason first, so **the last human action always wins** and no timer ever races the user. (Node's event loop guarantees nothing interleaves between finalize and relaunch.)

### 6.2 Never leak a run
*Problem:* If any code path throws after a run is registered but before it's cleaned up, the room is stuck "running" forever — every future message is ignored.
*Solution:* Cleanup happens *before* error reporting, and a last-resort `catch` on the run task releases the slot even if the database itself throws. Stale `running` statuses are also reset on server boot.

### 6.3 Providers that hang, lie, or die
*Problem:* A model server can refuse (easy), hang (no error for minutes), or return HTTP 200 with an empty or non-JSON body (looks like success).
*Solution:* A 12-second **first-token deadline** that aborts with a plain error (not a user abort, so it takes the fallback path), **empty-stream detection** after the loop, and a **fallback chain** to the simulated agent with a visible notice. The room never hard-fails in front of a team.

### 6.4 Late joiners and the unflushed buffer
*Problem:* Tokens are batched before broadcast. A snapshot built from the full text includes bytes still sitting in the batch buffer — which then arrive *again* on the next flush, so the late joiner sees "work through Plan work through…".
*Solution:* The snapshot excludes the un-broadcast tail (`text.slice(0, text.length - pending.length)`). Found by a review that reproduced it against the real server; the fix is one line, but you have to understand the buffering to see it.

### 6.5 Multiplayer with no server at all (the static runtime)
*Problem:* Vercel is static + serverless; no WebSockets, no shared state. How do you demo *real* multiplayer on a free static host?
*Solution:* `BroadcastChannel` across tabs with a **host model**: the creator hosts and runs the agent; every tab mirrors the full timeline; if the host closes, the lowest-id tab takes over (deterministic election); a tab that wrongly believes it hosts (throttled background tab) **demotes itself** and re-syncs; non-host actions carry ids and are **acked** by the host, buffered while no host is listening, and **replayed on takeover** so nothing is silently lost. Tab identity is per page-load (not `sessionStorage`, which browsers clone on "Duplicate tab" — that would create two hosts).

### 6.6 Background-tab timer throttling
*Problem:* The host tab is usually hidden while the user watches the joiner tab, and browsers clamp timers in hidden tabs to ~1/s. A word-by-word stream with one timer per word would crawl at one word per second.
*Solution:* Pace by **wall-clock schedule**: on each wake-up, emit every word whose scheduled time has passed. Full speed regardless of throttling.

### 6.7 The `LIMIT` that silently froze long rooms
*Problem:* `ORDER BY id ASC LIMIT 500` returns the *oldest* 500 events. After a long session, joiners saw a timeline that never advanced and the agent lost all recent context.
*Solution:* Query newest-N (`ORDER BY id DESC LIMIT`) and reverse. A classic bug that only shows up after the demo is over.

### 6.8 Guardrails that match the threat model
Per-IP rate limits on REST **and** per-connection frame budgets on WebSockets (otherwise typing spam amplifies into DB writes and broadcasts), 4k-char messages, control-character stripping, prompt-injection flagging (recorded on the event, not silently dropped), run timeouts, concurrent-run caps, and a markdown renderer that builds React elements — **no `innerHTML`** — so one participant's output can never inject markup into another's browser. BYOK keys live only in the tab that typed them.

---

## 7. How this helps you land AI roles

### Role-by-role mapping

**Forward Deployed Engineer / Solutions Engineer (AI)**
- FDEs ship working AI systems into messy real environments and demo them live. This project *is* a live demo that never fails (fallback chain), runs on a customer laptop with zero accounts (`npm start`), and degrades gracefully (static mode). You can walk into a room, open two tabs, and show multiplayer in 60 seconds.
- You can speak to provider abstraction (swap Ollama ↔ Groq), on-prem vs hosted models (Ollama is fully local — a real enterprise concern), and BYOK key handling.

**LLM Engineer / AI Engineer**
- Streaming LLM integration done properly: SSE parsing for Groq, NDJSON for Ollama, abort signals, first-token deadlines, batching for fan-out.
- Context construction: turning a multi-user event log into a chat transcript with speaker attribution and injected steering — a real prompt-engineering problem (how do you tell a model "Jordan just redirected you" so it acknowledges and pivots?).
- Human-in-the-loop control of an agent run (redirect / pause / resume / stop) with correct abort semantics — the core of "agents people can trust".
- The simulated brain is a deliberate design: deterministic output for demos and tests, independent of API keys.

**Full-stack / Platform engineer on an AI team**
- Real-time systems: WebSocket rooms, presence, snapshots for late joiners, reconnect with backoff and resync, idempotent event logs.
- Distributed-systems thinking in the browser: host election, split-brain demotion, ack/replay — the same patterns as leader election and at-least-once delivery, explained on a whiteboard with no infrastructure.
- Testing: a 33-check end-to-end suite that boots the real server and drives real WebSocket clients, plus unit checks of the tricky logic.

### Keywords this project honestly covers (for ATS and recruiters)
Streaming LLM APIs (Groq, Ollama) · agent run lifecycle · human-in-the-loop · prompt/context construction · tool-call theater (simulated) · WebSockets · real-time collaboration · event sourcing (append-only timeline) · presence · React 18 + hooks + reducers · Node 22 · Express · SQLite · Vercel Edge Functions · BroadcastChannel · leader election · idempotency · rate limiting · prompt-injection mitigation · XSS-safe rendering · end-to-end testing · zero-dependency deployment.

### Resume bullets (honest and quantified)

> - Built **HiveMind**, a multiplayer AI-agent platform where a team shares one live agent session: WebSocket rooms with presence, streamed LLM output fanned out to every participant with ~90 ms batching, and human-in-the-loop controls (mid-stream redirect, pause/resume, stop, fork) over an append-only event timeline in SQLite.
> - Designed a provider-agnostic streaming agent engine (Groq, Ollama, simulated) with first-token deadlines, empty-stream detection, and a fallback chain; an abort-with-reason run lifecycle guarantees partial output is preserved and a session can never get stuck.
> - Shipped a zero-backend deployment mode on Vercel: BroadcastChannel multiplayer across tabs with deterministic host election, split-brain demotion, snapshot sync for late joiners, and ack/replay for actions sent while no host is listening; Groq via a BYOK edge function.
> - Wrote a 33-check end-to-end suite driving three WebSocket clients through the full multiplayer flow; found and fixed 20+ concurrency and robustness bugs (duplicated stream snapshots, run-slot leaks, oldest-N query, timer throttling in background tabs).

### LinkedIn / portfolio blurb

> HiveMind — multiplayer AI agents. One shared live agent session a whole team can watch, steer, and hand off. Real-time WebSocket rooms, streaming LLMs (Groq/Ollama), mid-stream redirect, pause/resume, fork; also runs with zero backend via BroadcastChannel. Live demo → hivemind-agents.vercel.app

---

## 8. Interview questions you will get — and strong answers

**"Walk me through what happens when I click Redirect."**
The client POSTs a redirect action. The server appends a `redirect` event and broadcasts it (everyone sees "Jordan redirected the agent: …" instantly). If a run is in flight, the handler stores the steering text *on that run* and aborts it with reason `redirect`. The run's catch block sees the reason, commits the partial text as an `agent_message` tagged `interrupted`, flips status to idle, and — synchronously, before anything else can run — starts the follow-up run with the steering injected as the last user turn. If no run is in flight, it just starts a run with the steering. If someone clicks Pause after the redirect but before finalize, the abort reason becomes `pause` and no follow-up starts — the human wins.

**"Why an append-only event log instead of just storing the conversation?"**
Because the *team's* actions are part of the record: who redirected, who paused, who forked, who joined mid-stream. That history is what makes the session a shared artifact rather than a chat. It also gives idempotent reconnects (de-dup by id), trivial forks (copy rows), and an audit trail for free.

**"How do you build the model context from a multi-user log?"**
Filter to the events the model should see (messages, agent replies, redirects), take the last 30, prefix each user message with the speaker's name, express redirects as a bracketed instruction (`[Jordan redirected the agent]: …`), and add a system prompt that names the participants and tells the agent to acknowledge a redirect in one sentence and then continue. Keeping it to 30 events bounds cost and latency.

**"Why not CRDTs / operational transforms?"**
There's no concurrent editing of the same text — the agent is the only writer of its output, and humans append discrete events. A single ordered log with one writer per room (the server, or the host tab) is simpler and strictly correct. CRDTs would matter if teammates co-edited the agent's artifact, which is a natural next step.

**"How does the static version do multiplayer without a server?"**
`BroadcastChannel` is a same-origin pub/sub bus between tabs. One tab hosts (runs the agent, owns ordering); every tab mirrors the log; new tabs say hello and get a snapshot; the lowest id takes over if the host disappears; a tab that mistakenly thinks it hosts demotes when it hears a lower-id host; non-host actions are acked and replayed on takeover. It's leader election and at-least-once delivery, in the browser. The limitation — same browser only — is stated on the share bar.

**"How would you scale the server to thousands of rooms?"**
Rooms are independent, so shard by room id. Replace in-process broadcast with Redis pub/sub so any node can serve any socket; move the agent runs to workers with a queue; keep the event log in Postgres with the same append-only shape; add presence TTLs in Redis. The protocol doesn't change — that's why the transport abstraction exists.

**"What about prompt injection and abuse?"**
Inputs are capped and sanitized; known injection phrasings are flagged on the event (visible in the log) rather than silently rewritten; the system prompt frames teammates' text as quoted messages; rate limits exist on both REST and WebSocket; output is rendered without `innerHTML`. For production I'd add an input/output classifier, per-tenant quotas, and audit hashes of flagged inputs — the production docs sketch that.

**"How did you test it?"**
A 33-check end-to-end test boots the real server on an in-memory SQLite, creates a room over REST, connects three WebSocket clients, and asserts the whole flow: broadcast, token streaming to all, late-joiner snapshot with in-flight text, redirect with partial commit and follow-up, pause/resume, fork, rate limiting, malformed JSON, and disconnect presence. Plus unit checks for the tricky logic and manual two-tab verification of the static runtime.

**"What would you do with another month?"**
Real tool calling for Groq (web search, code execution) with a human-approval gate for risky tools; auth and workspaces; Redis-backed scaling; a shared *artifact* the agent writes to (a doc), which is where CRDTs come in; evals for agent behaviour under redirects; and cross-device static multiplayer via a tiny relay.

**"What's the weakest part?"**
Honest answer: tool use is simulated (the real providers do plain streaming chat); there's no auth (by design for a local-first demo); the static runtime is same-browser only; and it's a single process. Each is a deliberate scope cut with a documented path forward.

---

## 9. The 90-second live demo script

1. Open https://hivemind-agents.vercel.app. *"This is HiveMind — multiplayer AI agents. One agent, a whole team, live."*
2. Click **Demo**. Let it run 20 seconds. *"Three teammates, one agent. Watch Jordan redirect it mid-sentence — it pivots without losing the thread. Sam forks it at the end."*
3. Click **Live → Create session** (Simulated). Copy the invite link, open it in a **second tab**, join as another name. *"Two tabs, one room, no backend — the deployed site syncs through BroadcastChannel."*
4. In tab two, send *"Draft a launch plan"*. Switch to tab one: the same stream is appearing there. Click **Redirect**, type *"risks only"*. Switch back: the partial is tagged interrupted and the agent has changed course.
5. *"Locally this runs on a Node server with WebSockets and SQLite, with Ollama for fully private models — `npm install`, `npm start`, done. The protocol is the same in both, which is why one client serves both."*

If you have a Groq key, pick **Groq** in step 3 and the agent is a real LLM.

---

## 10. Limitations to own (so nobody catches you out)

- Tool calls in the UI are **simulated** (the "web_search" is theater for the demo). Real providers stream plain chat completions.
- **No authentication** — rooms are protected only by unguessable codes. Fine for a demo, not for production.
- Static runtime multiplayer is **same-browser only**; cross-device needs the Node server.
- **Single process**, in-memory presence; scaling path described above.
- Ollama must have a model pulled; the UI hides it otherwise.
- The exact name `hivemind-ai.vercel.app` belongs to someone else; the project lives at `hivemind-agents.vercel.app`.

---

## 11. Glossary

- **Session / room** — one shared agent conversation with its participants and its event log.
- **Event / timeline** — the append-only log of everything that happened in a room.
- **Run** — one execution of the agent, from start to finish/abort. One per room at a time.
- **Abort reason** — why a run stopped: `pause`, `stop`, `redirect`, `timeout`, `demoted`. Decides what happens next.
- **Snapshot** — what a joining client receives: the session, the events, who's present, and any in-flight stream text.
- **Host (static runtime)** — the tab that runs the agent and owns ordering for a BroadcastChannel room.
- **Fan-out** — broadcasting one event/token batch to every participant.
- **BYOK** — bring your own key; the Groq key is supplied by the user and never stored.
- **Fallback chain** — provider fails → simulated agent, with a visible notice.

---

*This document is the plain-English companion to `README.md` (technical reference) and the in-app About page.*
