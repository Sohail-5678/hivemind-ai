// The built-in simulated agent brain — believable, deterministic-enough output
// with tool-call theater. Shared by the server (server mode) and mirrored by the
// client bundle (static mode) so the demo never depends on an API key.

const TOPIC_STOPWORDS = new Set([
  'agent', 'hivemind', 'please', 'can', 'you', 'could', 'would', 'together', 'put', 'make', 'give', 'draft', 'write',
  'the', 'our', 'your', 'for', 'with', 'about', 'into', 'this', 'that', 'now', 'exactly', 'help', 'need', 'want',
  'stop', 'focus', 'only', 'just', 'instead', 'actually', 'rather', 'then', 'also', 'and', 'but', 'from', 'all',
])

export function topicOf(text) {
  const clean = String(text || '').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = clean.split(' ').filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w.toLowerCase())).slice(0, 6)
  return words.length ? words.join(' ') : 'this task'
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content.replace(/^\[?[A-Za-z0-9 _-]{1,40}( redirected the agent)?\]?:\s*/, '')
    }
  }
  return 'the task'
}

const TEMPLATES = [
  (topic, redirected) => ({
    tool: { name: 'web_search', args: { query: topic }, result: `Found 5 relevant sources on ${topic}. Top result summarized and added to working context.` },
    text:
      (redirected ? `Understood — changing course. Refocusing on ${topic} now.\n\n` : `On it. Let me work through ${topic} step by step.\n\n`) +
      `Here's what I've put together:\n\n` +
      `**1. Framing.** The core question behind "${topic}" splits into what we know, what we can verify quickly, and what needs a decision from the team.\n\n` +
      `**2. Findings.** From the material I just pulled in:\n` +
      `- The strongest signal points to a clear primary direction, with two viable alternatives worth keeping on the table.\n` +
      `- One assumption in the thread so far doesn't hold up under the sources — flagged below rather than silently dropped.\n` +
      `- There's a quick win available that requires no further research.\n\n` +
      `**3. Recommendation.** Take the primary direction, timebox the quick win, and assign the flagged assumption to whoever owns that area. ` +
      `Anyone here can redirect me if you'd rather I go deeper on an alternative — I'll pick it up mid-stream.\n\n` +
      `Next I can draft the concrete artifact (doc, plan, or checklist) if someone tells me which format the team prefers.`,
  }),
  (topic, redirected) => ({
    tool: { name: 'analyze_context', args: { query: topic }, result: `Reviewed the session so far and 3 reference documents for ${topic}. Extracted constraints, owners, and open questions.` },
    text:
      (redirected ? `Got it — dropping the previous thread and pivoting to ${topic}.\n\n` : `Picking this up. Here's a structured pass on ${topic}.\n\n`) +
      `**What we're actually deciding**\n` +
      `Underneath "${topic}" there are three decisions, and they don't all need the same people:\n\n` +
      `1. **Scope** — what's in for this iteration versus what's a fast-follow.\n` +
      `2. **Sequencing** — the dependency that gates everything else, which I'd put first.\n` +
      `3. **Ownership** — one named owner per workstream, not a committee.\n\n` +
      `**Proposed plan**\n` +
      `- Week 1: lock scope and confirm the gating dependency.\n` +
      `- Week 2: execute the critical path; parallelize the rest.\n` +
      `- Week 3: review against the original goal and cut anything that drifted.\n\n` +
      `**Risks I'd flag now**\n` +
      `- The timeline assumes no external approvals. If there's one, it goes first.\n` +
      `- Two of the open questions in this thread contradict each other — worth settling before anyone builds.\n\n` +
      `Tell me which of the three decisions to go deep on, or redirect me and I'll change course immediately.`,
  }),
]

export function simulatedPlan(topic, redirected) {
  // Stable choice per topic so replays feel consistent, but different topics vary.
  let hash = 0
  for (const ch of topic) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return TEMPLATES[hash % TEMPLATES.length](topic, redirected)
}
