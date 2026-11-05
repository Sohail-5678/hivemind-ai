// The built-in simulated agent brain — believable, deterministic-enough output
// with tool-call theater. The staged steps only ever read the room's own thread:
// HiveMind agents have no tools or web access, so the script never claims to
// search. Shared by the server (server mode) and mirrored by the client bundle
// (static mode) so the demo never depends on an API key.

// A resumed team run's goal is "Continue the previous goal: <goal>"; the topic
// is the goal itself, not the resume wording.
const CONTINUE_PREFIX = /^\s*(?:continue the previous goal:\s*)+/i

// The topic is a short phrase lifted from the goal that reads well inside the
// scripted sentences ("Gather the key facts about <topic>"): the request's
// scaffolding is stripped ("Should we", "Can you", "Plan a"), a leading verb
// becomes a gerund ("open the beta" -> "opening the beta"), and the phrase
// stops at the first clause break.
const LEAD_INS = [
  /^(?:hey|hi|ok|okay|so|team|everyone|folks|all)\b[\s,!.:-]*/i,
  /^@[a-z-]+[\s,:]*/i,
  /^please\s+/i,
  /^(?:can|could|would|will)\s+(?:you|we|someone|the team)(?:\s+please)?\s+/i,
  /^(?:should|shall|must|do)\s+(?:we|i)\s+/i,
  /^(?:how|when|why|where)\s+(?:should|do|can|could|would|will|might)\s+(?:we|i)\s+/i,
  /^(?:what|which)(?:'s|\s+is|\s+are)\s+(?:the\s+)?(?:best|right|smartest|cheapest|fastest)\s+(?:way|approach|option)\s+(?:to|for)\s+/i,
  /^what\s+(?:do|should|can)\s+(?:we|you|i)\s+(?:know|think|do|say)\s+(?:about|of|with)\s+/i,
  /^(?:what|who)(?:'s|\s+is|\s+are)\s+/i,
  /^(?:is|are)\s+(?:it|there)\s+(?:worth|time|a good idea|smart|wise)\s+(?:to\s+)?/i,
  /^(?:i|we)\s+(?:need|want|have|plan|hope)\s+to\s+/i,
  /^(?:i|we)(?:'d|\s+would)\s+like\s+to\s+/i,
  /^let'?s\s+/i,
  /^help\s+(?:me|us)\s+(?:with\s+|to\s+)?/i,
  /^(?:give|tell|show)\s+(?:me|us)\s+(?:about\s+)?/i,
  /^(?:think|talk)\s+(?:about|through)\s+/i,
]
// "Plan a launch", "Write the onboarding email": the object is the topic.
const MAKE_VERBS = /^(?:plan|draft|write|create|make|design|outline|prepare|build out|put together|come up with|sketch|propose|figure out|work out|decide on|summarize|compare|evaluate|review|analy[sz]e)\s+/i
const GERUNDS = {
  open: 'opening', build: 'building', start: 'starting', launch: 'launching', choose: 'choosing', hire: 'hiring',
  move: 'moving', migrate: 'migrating', buy: 'buying', use: 'using', adopt: 'adopting', ship: 'shipping', add: 'adding',
  pick: 'picking', switch: 'switching', replace: 'replacing', cut: 'cutting', raise: 'raising', expand: 'expanding',
  test: 'testing', run: 'running', improve: 'improving', reduce: 'reducing', increase: 'increasing', go: 'going',
  keep: 'keeping', drop: 'dropping', rewrite: 'rewriting', outsource: 'outsourcing', 'self-host': 'self-hosting',
  host: 'hosting', price: 'pricing', sell: 'selling', partner: 'partnering', invest: 'investing', delay: 'delaying',
  split: 'splitting', merge: 'merging', rebuild: 'rebuilding', refactor: 'refactoring', deploy: 'deploying',
  roll: 'rolling', set: 'setting', get: 'getting', organize: 'organizing', stay: 'staying', wait: 'waiting',
  pay: 'paying', charge: 'charging', offer: 'offering', support: 'supporting', release: 'releasing', rename: 'renaming',
  sunset: 'sunsetting', pivot: 'pivoting', grow: 'growing', scale: 'scaling', automate: 'automating', learn: 'learning',
}
const TRAILING = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'with', 'and', 'or', 'but', 'in', 'on', 'at', 'by', 'our', 'your', 'my', 'their', 'its', 'is', 'are', 'be'])
const MAX_TOPIC_WORDS = 12

const gerund = (word) => GERUNDS[word.toLowerCase()] || null

export function topicOf(text) {
  let t = String(text || '').replace(CONTINUE_PREFIX, '').replace(/\s+/g, ' ').trim()
  // Stop at the first clause break: "Offline mode: Q3 or Q4" -> "Offline mode".
  t = t.split(/[?!;:\n]|\.(?:\s|$)|\s[-\u2013\u2014]\s|,\s(?=(?:so|because|since|given|and then|but)\b)/i)[0].trim()
  for (let changed = true, guard = 0; changed && guard < 6; guard++) {
    changed = false
    for (const re of LEAD_INS) {
      const next = t.replace(re, '')
      if (next !== t) { t = next.trim(); changed = true }
    }
  }
  const made = MAKE_VERBS.test(t)
  t = t.replace(MAKE_VERBS, '').replace(/^(?:for|on|about)\s+/i, '').trim()
  // "Which database should we use for analytics" -> "the database to use for analytics".
  t = t.replace(/^(?:which|what)\s+([\w-]+(?:\s+[\w-]+)?)\s+(?:should|do|can|could|would|will)\s+(?:we|i)\s+(.+)$/i, 'the $1 to $2')
  t = t.replace(/\s+(?:because|so that|since|given that|in order to)\b.*$/i, '').trim()
  t = t.replace(/[^\w\s'&/+.-]/g, ' ').replace(/\s+/g, ' ').trim()

  let words = t.split(' ').filter(Boolean)
  // A leading verb reads as a gerund, and so does the verb after "or" / "and"
  // in a choice: "build our own or buy one" -> "building our own or buying one".
  // After "Plan the ..." the next word is a noun ("launch"), not a verb.
  const lead = words.length && !made ? gerund(words[0]) : null
  if (lead) {
    words[0] = lead
    for (let i = 1; i < words.length - 1; i++) {
      if (/^(?:or|and)$/i.test(words[i])) {
        const g = gerund(words[i + 1])
        if (g) words[i + 1] = g
      }
    }
  }
  if (words.length > MAX_TOPIC_WORDS) words = words.slice(0, MAX_TOPIC_WORDS)
  while (words.length > 1 && TRAILING.has(words[words.length - 1].toLowerCase())) words.pop()
  if (words.length && /^(?:a|an|the|our|my|this|that)$/i.test(words[0])) words[0] = words[0].toLowerCase()
  const topic = words.join(' ').replace(/[.'/-]+$/, '')
  return topic.length >= 2 ? topic : 'this task'
}

// Steering messages look like "[Alice redirected you mid-run]: <instruction>. Drop your …".
// Extract the instruction itself; a resume carries no topic, so fall through to
// the teammate's last real message.
const STEERING_SUFFIX = /\.?\s*(Drop your previous direction and follow this immediately\.?|Follow this new direction\.?)\s*$/i

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const content = String(messages[i].content || '')
    const steer = content.match(/^\[([^\]]{1,80})\]:\s*([\s\S]*)$/)
    if (steer) {
      if (/ resumed the session$/i.test(steer[1])) continue
      const body = steer[2].replace(STEERING_SUFFIX, '').trim()
      if (body) return body
      continue
    }
    return content.replace(/^[A-Za-z0-9 _-]{1,40}:\s*/, '')
  }
  return 'the task'
}

const TEMPLATES = [
  (topic, redirected) => ({
    tool: { name: 'read_thread', args: { query: topic }, result: `Read the conversation so far on ${topic} and pulled out the goal, the open points and what the team already agreed.` },
    text:
      (redirected ? `Understood, changing course. Refocusing on ${topic} now.\n\n` : `On it. Let me work through ${topic} step by step.\n\n`) +
      `Here's what I've put together:\n\n` +
      `**1. Framing.** The core question behind "${topic}" splits into what we know, what we can verify quickly, and what needs a decision from the team.\n\n` +
      `**2. Findings.** From what the team has shared so far:\n` +
      `- The strongest signal points to a clear primary direction, with two viable alternatives worth keeping on the table.\n` +
      `- One assumption in the thread so far doesn't hold up on a closer look, so it's flagged below rather than silently dropped.\n` +
      `- There's a quick win available that needs no further digging.\n\n` +
      `**3. Recommendation.** Take the primary direction, timebox the quick win, and assign the flagged assumption to whoever owns that area. ` +
      `Anyone here can redirect me if you'd rather I go deeper on an alternative, and I'll pick it up mid-stream.\n\n` +
      `Next I can draft the concrete artifact (doc, plan, or checklist) if someone tells me which format the team prefers.`,
  }),
  (topic, redirected) => ({
    tool: { name: 'analyze_context', args: { query: topic }, result: `Reviewed the session so far for ${topic}. Pulled out constraints, owners, and open questions.` },
    text:
      (redirected ? `Got it, dropping the previous thread and pivoting to ${topic}.\n\n` : `Picking this up. Here's a structured pass on ${topic}.\n\n`) +
      `**What we're actually deciding**\n` +
      `Underneath "${topic}" there are three decisions, and they don't all need the same people:\n\n` +
      `1. **Scope:** what's in for this iteration versus what's a fast-follow.\n` +
      `2. **Sequencing:** the dependency that gates everything else, which I'd put first.\n` +
      `3. **Ownership:** one named owner per workstream, not a committee.\n\n` +
      `**Proposed plan**\n` +
      `- Week 1: lock scope and confirm the gating dependency.\n` +
      `- Week 2: execute the critical path; parallelize the rest.\n` +
      `- Week 3: review against the original goal and cut anything that drifted.\n\n` +
      `**Risks I'd flag now**\n` +
      `- The timeline assumes no external approvals. If there's one, it goes first.\n` +
      `- Two of the open questions in this thread contradict each other, so they're worth settling before anyone builds.\n\n` +
      `Tell me which of the three decisions to go deep on, or redirect me and I'll change course immediately.`,
  }),
]

const QUESTION = /^\s*(what|who|why|how|when|where|which|is|are|can|does|do|explain|define|tell me)\b|\?\s*$/i

export function simulatedPlan(topic, redirected, rawText = '', { fallback = false } = {}) {
  if (fallback) {
    return {
      tool: { name: 'analyze_context', args: { query: topic }, result: 'The language model did not respond in time; the scripted demo agent is standing in.' },
      text:
        `The language model behind this room didn't respond in time, so I'm the **scripted demo agent** standing in, and I can't give a real answer to "${String(rawText).trim().slice(0, 120)}".\n\n` +
        `**Send it again in a few seconds** and the model will pick it up. Everything else in the room (redirect, pause, resume, fork) keeps working while you wait.`,
    }
  }
  if (QUESTION.test(rawText)) {
    return {
      tool: { name: 'analyze_context', args: { query: topic }, result: 'This room is using the scripted demo agent, which has no language model behind it.' },
      text:
        (redirected ? 'Changing course. ' : '') +
        `That's a real question ("${String(rawText).trim().slice(0, 120)}"), and I'm HiveMind's **scripted demo agent**: I replay prepared text so the multiplayer mechanics can be shown with no setup, but I can't actually answer it.\n\n` +
        `**To get a real answer**, start a new session and pick **Free model** (no key needed) or **Groq** as the agent brain.\n\n` +
        `**What you can still try here:**\n` +
        `- Hit **Redirect** while I'm writing and watch me change course mid-sentence.\n` +
        `- **Pause** me, then **Resume**, and I continue where I stopped.\n` +
        `- **Fork** the session into a parallel room with the full history.`,
    }
  }
  // Stable choice per topic so replays feel consistent, but different topics vary.
  let hash = 0
  for (const ch of topic) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return TEMPLATES[hash % TEMPLATES.length](topic, redirected)
}
