# HiveMind — Multiplayer AI Agents

> **AI had its chat moment. This is its multiplayer moment.**
> One shared, live agent session your whole team can watch, steer, and hand off — like a Google Doc, except the document is an AI agent doing real work.

**Live:** https://hivemind-ai.vercel.app · **Source:** https://github.com/Sohail-5678/hivemind-ai

![Node 22+](https://img.shields.io/badge/node-22%2B-021861?style=flat-square)
![React 18](https://img.shields.io/badge/react-18-255DCE?style=flat-square&logo=react&logoColor=white)
![Zero cloud deps](https://img.shields.io/badge/cloud%20deps-zero-DE1110?style=flat-square)
![Tests](https://img.shields.io/badge/e2e%20tests-33%20passing-255DCE?style=flat-square)

---

## Why this exists

Every category of work software that went multiplayer became worth 10× more — Word → Google Docs, Photoshop → Figma, email → Slack. AI agents are still single-player: a private chat window, and the best you can share is a read-only transcript.

HiveMind makes the **session** the product. Anyone on the team can drop into the same live agent run, watch every token, redirect it mid-stream, pause and hand it off, or fork it into a parallel exploration.

## The five multiplayer moves

| Move | What happens |
|---|---|
| **Message** | Anyone in the room tasks the agent; every teammate sees it and the response streams to all of them at once (~90 ms token fan-out). |
| **Redirect** | Steer the agent *while it's streaming*. The in-flight run is aborted, its partial output is kept (tagged “interrupted”), and a follow-up run starts immediately with the new direction injected. |
| **Pause / Resume** | Freeze the agent mid-run; resume picks up exactly where it stopped. |
| **Stop** | Kill the current run, keep the partial output. |
| **Fork** | Branch the whole session (full timeline copied) into a new room. |

## Two runtimes, one codebase

| | **Server mode** (`npm start`) | **Static mode** (Vercel) |
|---|---|---|
| Transport | WebSocket rooms on a Node server | `BroadcastChannel` across tabs in one browser |
| Timeline | SQLite (Node's built-in `node:sqlite`) | `localStorage` per room |
| Multiplayer | Cross-device (share the LAN URL or a tunnel) | Cross-tab (open the invite link in a second tab) |
| Agent brains | Simulated · **Ollama** (local, auto-detected) · **Groq** (BYOK) | Simulated · **Groq** (BYOK via an edge function) |
| Agent runs in | The server process | The **host tab**; if it closes, the lowest-id tab takes over |

The client detects which runtime it's on (`/api/health` advertises `realtime: "ws"`) and picks the transport. Both transports emit the **same message protocol**, so the reducer, workspace, timeline, and composer are shared verbatim.

## Run it locally (full server)

```bash
npm install
```

```bash
npm start
```

Open **http://localhost:3000**. No API keys, no accounts. Requires Node ≥ 22.5 (zero native dependencies).

The terminal prints a **Network URL** — anyone on your WiFi can open it and join your room with the 6-character code. For someone remote: `npx cloudflared tunnel --url http://localhost:3000`.

### Agent brains

| Provider | Setup | Notes |
|---|---|---|
| **Simulated** | none | Built-in. Streams believable output with tool-call theater. Powers the instant demo. |
| **Ollama** | [ollama.com](https://ollama.com), any model | Auto-detected at `localhost:11434`. Fully local and private. |
| **Groq** | free key at [console.groq.com](https://console.groq.com) | Entered in the UI, held in memory only (server) or forwarded once by an edge function (static). Never persisted, never logged. |

If a real provider fails (unreachable, hangs, returns an empty stream, bad key), the run **falls back to the simulated agent** with a visible notice instead of breaking the room.

### Development

```bash
npm run dev
```

Server on `:3000` + Vite dev server on `:5173` with hot reload.

```bash
npm test
```

Boots a real server on a scratch in-memory DB, connects three WebSocket clients, and verifies the full multiplayer flow — presence, broadcast, streaming to every client, a **mid-stream redirect with partial commit + follow-up run**, pause/resume, fork, late-joiner snapshots (including in-flight run text), rate limiting, malformed input, and disconnect cleanup. 33 checks.

```bash
npm run preview:static
```

Serves the production bundle with no API server — exactly what Vercel serves — so you can test static mode locally on `:4173`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      BROWSER  (React + Vite)                     │
│   Demo (scripted replay) · Sample (solo) · Live (rooms)          │
│   one shared SessionWorkspace — PresenceBar · Timeline · Composer│
│                                                                  │
│   runtime.js detects the transport ──► useSession (WebSocket)    │
│                                    └─► useLocalRoom (Broadcast-  │
│                                        Channel + host-tab agent) │
└───────────────┬──────────────────────────────────┬──────────────┘
         server mode                          static mode
                │                                  │
┌───────────────▼──────────────────┐   ┌───────────▼──────────────┐
│  NODE SERVER (one process)       │   │  VERCEL (static + edge)  │
│  Express REST · ws rooms         │   │  client/dist             │
│  agent engine · SQLite           │   │  api/chat.js — Groq SSE  │
│  guardrails                      │   │  proxy, BYOK, no storage │
└───┬────────────┬────────────┬────┘   └──────────────────────────┘
    │            │            │
 SQLite       Ollama        Groq
 (local)      (local)      (BYOK)
```

**Engineering details worth knowing**

- **Append-only timeline.** Every message, redirect, tool call, pause, fork, join, and leave is an event. Late joiners get a snapshot (events + the in-flight run's streamed text), then live deltas. Re-joins are idempotent (events dedup by id).
- **Redirect semantics.** The redirect hands its steering to the aborted run; the run's own finalizer starts the follow-up *synchronously* once the slot is free. A pause or stop clicked after the redirect overwrites the abort reason first, so the last human action always wins — no timers racing the user.
- **Never leak a run.** Run cleanup happens before error reporting, and a last-resort `catch` on the run task releases the slot even if the DB throws, so a session can never get stuck “running”.
- **Provider resilience.** First-token deadline (12 s), empty-stream detection, and a fallback chain to the simulated agent. A hanging provider falls back in seconds, not after the 120 s watchdog.
- **Guardrails.** Per-IP rate limits on REST *and* per-connection budgets on WebSocket frames, 4k-char message cap, control-character stripping, prompt-injection flagging, run timeouts, concurrent-run caps, restart recovery (stale `running` statuses reset on boot), and a markdown renderer that builds React elements (no `innerHTML`) so agent output can never inject markup.
- **BYOK, honestly.** A Groq key lives only in the browser tab that typed it; the server holds it in memory per session and the edge function forwards it once. Nothing writes it to disk or logs.

## Project layout

```
hivemind-ai/
├── server/            Express + ws + SQLite + agent engine (zero native deps)
│   ├── server.js      REST API, guardrails, static serving, port fallback
│   ├── websocket.js   rooms, presence, snapshots, per-connection limits
│   ├── agent.js       run lifecycle: stream / redirect / pause / resume / stop
│   ├── simulated.js   the built-in agent brain (shared with the client bundle)
│   └── db.js          node:sqlite schema + fork
├── api/chat.js        Vercel Edge Function — Groq streaming proxy (BYOK)
├── client/            Vite + React — spatial glass UI
│   └── src/
│       ├── hooks/     useSession (WS) · useLocalRoom (BroadcastChannel) · shared reducer
│       ├── agent/     clientAgent — host-tab agent runner for static mode
│       ├── components/ Landing · Demo · Sample · Live · SessionWorkspace · …
│       └── demo/      the choreographed replay script
├── test/smoke.test.js end-to-end multiplayer test (npm test)
└── vercel.json        static build + rewrites + security headers
```

## Design

Midnight Navy `#021861` · Cobalt Blue `#255DCE` · Bright Red `#DE1110`. A spatial glass system: layered depth gradients, drifting cobalt/red light, a perspective floor grid, translucent panels with backdrop blur, and mouse-driven parallax on the hero stage. Display type is Fraunces; UI type is Inter. Respects `prefers-reduced-motion`.

## Deploy your own

```bash
npx vercel --prod
```

`vercel.json` builds `client/` and deploys `api/chat.js` as an edge function. No environment variables are required.

## License

MIT
