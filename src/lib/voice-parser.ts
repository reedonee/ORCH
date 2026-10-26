// ── Local Voice Brain ─────────────────────────────────────────
// Fully local command understanding — no VPS, no cloud LLM.
// Uses multi-strategy parsing:
//   1. Intent classification via pattern scoring
//   2. Fuzzy provider/agent name matching
//   3. Context-aware entity extraction
//   4. Compound command support
//   5. Confidence scoring to reject noise
//
// This replaces the old VPS brain (qwen2.5 Ollama + Gemini) with
// a pure TypeScript engine that runs in-process, zero latency.

import type { AppCommand } from './agent-commands';

// ── Provider aliases (extended) ─────────────────────────────

const PROVIDER_ALIASES: Record<string, string[]> = {
  hermes: ['hermes', 'hermes agent', 'hermes cli', 'herms', 'hermes ai', 'hermes code'],
  'claude-code': ['claude', 'claude code', 'claude ai', 'anthropic', 'clod', 'claud', 'claude sonnet', 'sonnet'],
  codex: ['codex', 'openai codex', 'codex cli', 'codecs', 'open ai codex', 'code x'],
  opencode: ['opencode', 'open code', 'open coded', 'opened code', 'open-code', 'open code agent'],
  cursor: ['cursor', 'cursor agent', 'cursor ai', 'cursor editor'],
  antigravity: ['antigravity', 'anti gravity', 'anti-gravity', 'ag'],
};

const ALIAS_TO_PROVIDER: [string, string][] = [];
for (const [provider, aliases] of Object.entries(PROVIDER_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_PROVIDER.push([alias, provider]);
  }
}
ALIAS_TO_PROVIDER.sort((a, b) => b[0].length - a[0].length);

// ── Layout mode vocabulary ─────────────────────────────────
// Voice transcripts are noisy and users don't know the engine's internal
// names, so every mode carries a generous set of natural synonyms.

const LAYOUT_MODE_ALIASES: Record<string, string[]> = {
  grid: ['grid', 'tidy', 'neaten', 'clean', 'organize', 'organise', 'straighten',
         'matrix', 'snap', 'align', 'normal', 'default', 'even', 'equal', 'tiles', 'tile'],
  focus: ['focus', 'focused', 'spotlight', 'hero', 'zoom', 'main', 'primary',
          'big', 'large', 'one big', 'presentation', 'present'],
  // Not 'browser' or 'preview': anything said about the browser ("show the
  // browser view") switched the whole canvas into stage layout.
  stage: ['stage', 'theater', 'theatre', 'cinema', 'cinematic'],
  split: ['split', 'half', 'halves', 'side by side', 'side-by-side', 'two columns',
          'columns', 'compare', 'comparison', 'dual'],
  rail: ['rail', 'strip', 'row', 'filmstrip', 'film strip', 'line', 'horizontal', 'across'],
  constellation: ['constellation', 'cluster', 'clusters', 'clustered', 'graph',
                  'relationship', 'relationships', 'related', 'groups', 'grouped', 'smart'],
};

const LAYOUT_ALIAS_PAIRS: [string, string][] = [];
for (const [mode, aliases] of Object.entries(LAYOUT_MODE_ALIASES)) {
  for (const alias of aliases) LAYOUT_ALIAS_PAIRS.push([alias, mode]);
}
// Longest first so "side by side" wins over "side".
LAYOUT_ALIAS_PAIRS.sort((a, b) => b[0].length - a[0].length);

/** Resolve a spoken fragment to a layout mode, or null when unrecognised. */
export function matchLayoutMode(text?: string | null): string | null {
  if (!text) return null;
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (!t) return null;
  for (const [alias, mode] of LAYOUT_ALIAS_PAIRS) {
    // Word-boundary match so "grid" doesn't fire inside "gridiron".
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|\\s)${escaped}($|\\s)`).test(t)) return mode;
  }
  return null;
}

// ── Intent definitions ─────────────────────────────────────

interface IntentPattern {
  kind: AppCommand['kind'];
  patterns: RegExp[];
  priority: number;  // higher = wins ties
  extract: (match: RegExpMatchArray) => Partial<AppCommand> & { kind: AppCommand['kind'] };
  keywords: string[]; // for keyword scoring
}

/** "approve max" → "max"; "approve it" / "approve" → undefined, meaning
 *  whichever agent is waiting. */
function approvalTarget(raw: string | undefined): string | undefined {
  const q = (raw ?? '')
    .replace(/^(?:it|that|this|the request|the command|for|please)\b\s*/i, '')
    .replace(/\s*\b(?:please|request|now)$/i, '')
    .trim();
  return q || undefined;
}

const INTENTS: IntentPattern[] = [
  // ── APPROVE / DENY a waiting agent ─────────────────────
  // Above spawn and focus: "allow max" or "let sky go ahead" must never
  // start an agent or move focus while another is blocked on a prompt.
  {
    kind: 'approval',
    priority: 14,
    keywords: ['approve', 'allow', 'accept', 'deny', 'reject', 'decline', 'refuse', 'go ahead'],
    patterns: [
      /^(approve|allow|accept|deny|reject|decline|refuse)\b\s*(.*)$/i,
      /^(?:let|tell)\s+(.+?)\s+(go ahead|proceed|do it)$/i,
      // Deliberately no bare "yes"/"no": those are ordinary replies an
      // agent may be waiting for in chat, and must still reach it.
    ],
    extract: (m) => {
      const verb = m[0].toLowerCase();
      const deny = /^(deny|reject|decline|refuse)\b/.test(verb);
      // Pattern 2 captures the agent first; the others capture it second.
      const raw = /^(let|tell)\s/.test(verb) ? m[1] : m[2];
      const target = approvalTarget(raw);
      const all = !!target && /^(all|everyone|everything|every agent|all agents|them all)$/i.test(target);
      return {
        kind: 'approval', decision: deny ? 'deny' : 'approve',
        query: all ? undefined : target, all,
      } as AppCommand & { kind: 'approval' };
    },
  },

  // ── AUTO / MANUAL approval mode ────────────────────────
  {
    kind: 'approvalMode',
    priority: 14,
    keywords: ['auto approve', 'auto mode', 'manual', 'auto'],
    patterns: [
      // (?!on|off …): "turn off auto approve" belongs to the last pattern.
      /^(?:put|set|switch|turn|make)\s+(?!(?:on|off)\s+auto)(.+?)\s+(?:to|on|in|into)?\s*(auto|manual)(?:\s+(?:mode|approval|approve))?$/i,
      /^(auto|manual)\s+(?:approv\w*|mode)\s+(?:for|on)\s+(.+)$/i,
      /^turn\s+(on|off)\s+auto[- ]?approv\w*(?:\s+for\s+(.+))?$/i,
    ],
    extract: (m) => {
      const text = m[0].toLowerCase();
      if (text.startsWith('turn on') || text.startsWith('turn off')) {
        return { kind: 'approvalMode', mode: m[1].toLowerCase() === 'on' ? 'auto' : 'manual', query: approvalTarget(m[2]) } as AppCommand & { kind: 'approvalMode' };
      }
      if (/^(auto|manual)\s/.test(text)) {
        return { kind: 'approvalMode', mode: m[1].toLowerCase() as 'auto' | 'manual', query: approvalTarget(m[2]) } as AppCommand & { kind: 'approvalMode' };
      }
      return { kind: 'approvalMode', mode: m[2].toLowerCase() as 'auto' | 'manual', query: approvalTarget(m[1]) } as AppCommand & { kind: 'approvalMode' };
    },
  },

  // ── CONTROLLER ─────────────────────────────────────────
  // Above spawn: "make max the controller" must not start an agent.
  {
    kind: 'controller',
    priority: 14,
    keywords: ['controller', 'coordinator', 'coordinate', 'take charge', 'run the show'],
    patterns: [
      /^(?:clear|remove|stop|drop|no|unset)\s+(?:the\s+)?(?:controller|coordinator)$/i,
      /^(?:make|set|put)\s+(.+?)\s+(?:as\s+)?(?:the\s+)?(?:controller|coordinator|lead|leader)$/i,
      /^(?:set|change|switch)\s+(?:the\s+)?(?:controller|coordinator)\s+to\s+(.+)$/i,
      /^(?:let|have)\s+(.+?)\s+(?:coordinate|run the show|lead|take charge)(?:\s+of\s+the\s+others)?$/i,
    ],
    extract: (m) => {
      if (/^(clear|remove|stop|drop|no|unset)\b/i.test(m[0])) {
        return { kind: 'controller', clear: true } as AppCommand & { kind: 'controller' };
      }
      return { kind: 'controller', query: m[1].trim() } as AppCommand & { kind: 'controller' };
    },
  },

  // ── SPAWN ──────────────────────────────────────────────
  {
    kind: 'spawn',
    priority: 10,
    keywords: ['spawn', 'launch', 'open', 'create', 'start', 'add', 'make', 'new agent', 'bring in', 'summon', 'deploy', 'fire up', 'wake up'],
    patterns: [
      /^(?:spawn|launch|open|create|start|add|make|bring in|summon|deploy|fire up|wake up)\s+(?:a|an|the|another)?\s*(.+)/i,
      /^(?:i need|give me|get me|i want|can i have|set up)\s+(?:a|an|the)?\s*(.+)/i,
      /^(?:spin up|boot up|start up)\s+(?:a|an|the)?\s*(.+)/i,
      /^(?:new|another)\s+(.+?)\s*(?:agent|terminal)?$/i,
    ],
    extract: (m) => {
      const after = m[1].trim();
      const provider = extractProvider(after);
      if (provider) {
        const countMatch = after.match(/^(\d+)\s+/);
        const count = countMatch ? Math.max(parseInt(countMatch[1]), 1) : 1;
        return { kind: 'spawn', providerId: provider, count } as AppCommand & { kind: 'spawn' };
      }
      // Check if it's a name + provider pattern like "Max as Claude"
      const nameMatch = after.match(/^(\w+)\s+(?:as|the|using)\s+(.+)/i);
      if (nameMatch) {
        const name = nameMatch[1];
        const prov = extractProvider(nameMatch[2]);
        if (prov) return { kind: 'spawn', providerId: prov, count: 1, name } as AppCommand & { kind: 'spawn' };
      }
      // Named spawn with default provider
      const firstWord = after.split(/\s+/)[0];
      if (firstWord && !extractProvider(after) && firstWord.length > 1) {
        return { kind: 'spawn', providerId: 'hermes', count: 1, name: firstWord } as AppCommand & { kind: 'spawn' };
      }
      return { kind: 'spawn', providerId: 'hermes', count: 1 } as AppCommand & { kind: 'spawn' };
    },
  },

  // ── SPAWN with explicit count ──────────────────────────
  {
    kind: 'spawn',
    priority: 11,
    keywords: ['spawn', 'launch', 'create', 'start', 'add', 'make'],
    patterns: [
      /^(?:spawn|launch|create|start|add|make|open)\s+(\d+)\s+(.+)/i,
      /^(\d+)\s*(?:of\s+)?(.+?)\s*(?:agents?|terminals?)?$/i,
    ],
    extract: (m) => {
      const count = Math.max(parseInt(m[1]), 1);
      const after = m[2].trim();
      const provider = extractProvider(after);
      if (provider) {
        return { kind: 'spawn', providerId: provider, count } as AppCommand & { kind: 'spawn' };
      }
      return { kind: 'spawn', providerId: 'hermes', count } as AppCommand & { kind: 'spawn' };
    },
  },

  // ── REMOVE ─────────────────────────────────────────────
  {
    kind: 'remove',
    priority: 10,
    keywords: ['remove', 'close', 'kill', 'delete', 'dismiss', 'vanish', 'destroy', 'get rid of', 'shut down', 'take down', 'terminate', 'end'],
    patterns: [
      /^(?:remove|close|kill|delete|dismiss|vanish|destroy|get rid of|shut down|take down|terminate|end)\s+(?:the\s+)?(.+)/i,
      /^(?:get rid of|take down|shut down)\s+(?:the\s+)?(.+)/i,
    ],
    extract: (m) => {
      const query = m[1].trim();
      if (/all|everyone|everything|every|all agents/i.test(query)) {
        return { kind: 'removeAll' } as AppCommand & { kind: 'removeAll' };
      }
      return { kind: 'remove', query } as AppCommand & { kind: 'remove' };
    },
  },

  // ── REMOVE ALL ─────────────────────────────────────────
  {
    kind: 'removeAll',
    priority: 15,
    keywords: ['remove all', 'kill all', 'close all', 'delete all', 'clear all', 'reset'],
    patterns: [
      /^(?:remove|close|kill|delete|clear|vanish|destroy)\s+(?:all|everyone|everything|every\s+agent)/i,
      /^(?:clear all|reset all|start fresh)\s*$/i,
      // "clean up" on its own means tidy, not destroy — it must name the
      // agents explicitly before it is treated as a destructive command.
      /^clean\s+up\s+(?:all\s+)?(?:the\s+)?agents?\s*$/i,
    ],
    extract: () => ({ kind: 'removeAll' } as AppCommand & { kind: 'removeAll' }),
  },

  // ── ARRANGE ────────────────────────────────────────────
  {
    kind: 'arrange',
    priority: 8,
    keywords: [
      'arrange', 'organize', 'organise', 'layout', 'sort', 'tidy', 'grid', 'clean',
      'neaten', 'stage', 'align', 'snap', 'spread', 'focus', 'split', 'rail',
      'constellation', 'cluster', 'strip', 'row',
    ],
    patterns: [
      /^(?:arrange|organize|organise|layout|sort|tidy|grid|clean|neaten|stage|align|snap|spread|rearrange|re-?arrange)\s*(?:the\s+)?(?:agents?|nodes?|cards?|windows?|canvas|everything|them|all)?\s*(?:in(?:to)?|as|to|by|using)?\s*(?:an?\s+)?(.+)?$/i,
      /^(?:put|place|lay|line|group|cluster|stack)\s+(?:them|everything|it|the\s+\w+)?\s*(?:up|out)?\s*(?:in(?:to)?|as|by|side)?\s*(?:an?|the)?\s*(.+)$/i,
      /^(.+?)\s+(?:layout|view|mode)$/i,
      // Bare mode phrases: "two columns", "side by side", "constellation".
      /^(two columns|side by side|side-by-side|filmstrip|constellation|spotlight|split|rail)$/i,
    ],
    extract: (m) => {
      // Try the captured fragment first, then the whole utterance. The
      // mode word often IS the verb ("tidy up", "grid layout", "stage
      // view"), in which case the capture group holds only the leftover
      // filler and matching it alone yields nothing.
      const mode = matchLayoutMode(m[1]) ?? matchLayoutMode(m[0]);
      return { kind: 'arrange', mode: mode ?? undefined } as AppCommand & { kind: 'arrange' };
    },
  },

  // ── FOCUS ──────────────────────────────────────────────
  {
    kind: 'focus',
    priority: 7,
    keywords: ['focus', 'select', 'switch to', 'go to', 'highlight', 'center on', 'zoom to', 'show me', 'look at'],
    patterns: [
      /^(?:focus on|focus|select|switch to|go to|highlight|center on|zoom to|show me|look at)\s+(.+)/i,
      /^(?:switch|move)\s+(?:to\s+)?(.+)/i,
    ],
    extract: (m) => {
      const query = m[1].trim();
      return { kind: 'focus', query } as AppCommand & { kind: 'focus' };
    },
  },

  // ── MESSAGE / SEND-TO AGENT ────────────────────────────
  {
    kind: 'message',
    priority: 6,
    keywords: ['tell', 'ask', 'instruct', 'prompt', 'send to', 'message'],
    patterns: [
      /^(?:prompt|tell|ask|instruct|message)\s+(.+?)\s+(?:to|about|regarding|to do|and say)\s+(.+)/i,
      /^(?:tell|ask|message|send)\s+(.+?)\s+to\s+(?:do\s+)?(.+)/i,
      /^(?:send\s+(?:this|that|it|the following)\s+to)\s+(.+)/i,
    ],
    extract: (m) => {
      const target = m[1].trim();
      const instruction = m[2]?.trim() || '';
      return { kind: 'message', text: instruction, agentName: target } as AppCommand & { kind: 'message' };
    },
  },

  // ── BROWSER ─────────────────────────────────────────────
  {
    kind: 'browser',
    // Above spawn (10): these patterns all name the browser explicitly, so
    // they are strictly more specific than spawn's generic "open <thing>".
    // At priority 5 "open a browser" lost to spawn and created an agent.
    priority: 12,
    keywords: ['browser', 'web', 'internet', 'website', 'url', 'page'],
    patterns: [
      /^(?:open|launch|show|bring up)\s+(?:up\s+)?(?:a|an|the)?\s*(?:web\s+)?(?:browser|browser preview|web preview)\b/i,
      /^(?:open|launch|show)\s+(?:a|an|the)?\s*(?:browser|browser preview|web preview)\s+(?:and\s+)?(?:navigate to|go to|open|load)\s+(.+)/i,
      /^(?:navigate to|go to|open|load|browse to)\s+(https?:\/\/\S+)/i,
      /^(?:navigate to|go to|browse to)\s+([\w-]+\.[a-z]{2,}\S*)/i,
      /^(?:close|hide|dismiss)\s+(?:the\s+)?(?:browser|browser preview|web browser)\b/i,
    ],
    extract: (m) => {
      const text = m[0].toLowerCase();
      if (text.startsWith('close')) {
        return { kind: 'browser', action: 'close' } as AppCommand & { kind: 'browser' };
      }
      const url = m[1]?.trim() || null;
      return { kind: 'browser', action: 'open', url } as AppCommand & { kind: 'browser' };
    },
  },

  // ── MUSIC ───────────────────────────────────────────────
  {
    kind: 'music',
    // Same reasoning as browser: every pattern names music explicitly.
    priority: 12,
    keywords: ['music', 'play', 'song', 'track', 'youtube', 'audio', 'sound'],
    patterns: [
      /^play\s+(https?:\/\/\S+)/i,
      // Allow the filler people actually say: "play some music",
      // "put on a bit of music", "start the music".
      /^(?:play|put on|start|resume)\s*(?:some|a bit of|a little)?\s*(?:the\s+)?music\b/i,
      /^(?:play|resume)\s*(?:music|the music)?$/i,
      /^(?:pause|stop)\s*(?:music|the music)?$/i,
      /^(?:next|skip)\s*(?:track|song)?$/i,
      /^(?:previous|prev|back)\s*(?:track|song)?$/i,
      /^(?:shuffle)\s*(on|off|toggle)?$/i,
      /^(?:repeat)\s*(on|off|toggle)?$/i,
      /^close\s+(?:music|player)/i,
      /^(?:search|find|look up)\s+(.+?)\s+(?:on youtube|in music|on music|song|track)/i,
    ],
    extract: (m) => {
      const text = m[0].toLowerCase();
      const cmd = text.replace(/^play\s+/, '').trim();

      if (/^https?:\/\//.test(cmd)) {
        return { kind: 'music', action: 'playUrl', url: cmd } as AppCommand & { kind: 'music' };
      }
      if (/^play\s+music/.test(text)) {
        return { kind: 'music', action: 'toggle' } as AppCommand & { kind: 'music' };
      }
      if (/^(play|resume)/.test(text)) return { kind: 'music', action: 'play' } as AppCommand & { kind: 'music' };
      if (/^(pause|stop)/.test(text)) return { kind: 'music', action: 'pause' } as AppCommand & { kind: 'music' };
      if (/^(next|skip)/.test(text)) return { kind: 'music', action: 'next' } as AppCommand & { kind: 'music' };
      if (/^(previous|prev|back)/.test(text)) return { kind: 'music', action: 'prev' } as AppCommand & { kind: 'music' };
      if (/^shuffle/.test(text)) return { kind: 'music', action: 'shuffle' } as AppCommand & { kind: 'music' };
      if (/^repeat/.test(text)) return { kind: 'music', action: 'repeat' } as AppCommand & { kind: 'music' };
      if (/^close/.test(text)) return { kind: 'music', action: 'close' } as AppCommand & { kind: 'music' };
      if (m[1]) return { kind: 'music', action: 'search', query: m[1].trim() } as AppCommand & { kind: 'music' };
      return { kind: 'music', action: 'play' } as AppCommand & { kind: 'music' };
    },
  },

  // ── HELP ────────────────────────────────────────────────
  {
    kind: 'message',
    priority: 1,
    keywords: ['help', 'what can you do', 'commands', 'voice help', 'what can i say', 'capabilities'],
    patterns: [
      /^(?:help|what can you do|commands|voice help|what can i say|what do you do|capabilities)/i,
    ],
    extract: () => ({ kind: 'message', text: 'voice-help' } as AppCommand & { kind: 'message' }),
  },
];

// ── Intent scoring engine ────────────────────────────────────

interface ScoredIntent {
  intent: IntentPattern;
  score: number;
  match: RegExpMatchArray | null;
}

/**
 * Score all intents against the transcript using multiple signals:
 *  - Pattern match (exact regex hit)
 *  - Keyword density
 *  - Position of keywords (earlier = stronger)
 * Returns the best match or null.
 */
function scoreIntents(text: string): ScoredIntent | null {
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,]+/).filter(Boolean);
  const scored: ScoredIntent[] = [];

  for (const intent of INTENTS) {
    let score = 0;
    let bestMatch: RegExpMatchArray | null = null;

    // 1. Try each regex pattern
    for (const pattern of intent.patterns) {
      const m = text.match(pattern);
      if (m) {
        const patternScore = intent.priority * 10 + (m[0].length / text.length) * 5;
        if (patternScore > score) {
          score = patternScore;
          bestMatch = m;
        }
      }
    }

    // 2. Keyword density scoring (boost if many keywords match)
    const matchedKeywords = intent.keywords.filter(kw => lower.includes(kw));
    if (matchedKeywords.length > 0) {
      const kwScore = (matchedKeywords.length / intent.keywords.length) * 20;
      // Position bonus: keywords at the start matter more
      const firstKw = matchedKeywords[0];
      const posBonus = lower.indexOf(firstKw) === 0 ? 10 : 0;
      score += kwScore + posBonus;
    }

    if (score > 0) {
      scored.push({ intent, score, match: bestMatch });
    }
  }

  if (scored.length === 0) return null;

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return best, but only if it's clearly better than the runner-up
  if (scored.length === 1) return scored[0];
  if (scored[0].score > scored[1].score * 1.3) return scored[0];

  // Tie-break: prefer the intent with higher priority
  if (scored[0].intent.priority > scored[1].intent.priority) return scored[0];

  // Still too close — return the one with the most matched keywords
  const kw0 = scored[0].intent.keywords.filter(k => lower.includes(k)).length;
  const kw1 = scored[1].intent.keywords.filter(k => lower.includes(k)).length;
  return kw0 >= kw1 ? scored[0] : scored[1];
}


// ── Provider extraction ──────────────────────────────────────

function extractProvider(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [alias, provider] of ALIAS_TO_PROVIDER) {
    if (lower.includes(alias)) return provider;
  }
  return null;
}


// ── Ordinal / reference resolution ──────────────────────────

const ORDINALS: Record<string, number> = {
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
  '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4,
  one: 0, two: 1, three: 2, four: 3, five: 4,
  the: 0,
};

/**
 * Parse ordinal references like "the third Claude" or "the busy one".
 * Returns { targetMatch, ordinal } or null.
 */
export function parseOrdinalRef(query: string): { targetMatch: string; ordinal: number } | null {
  const lower = query.toLowerCase();
  // "the third agent" / "the second Claude"
  const ordMatch = lower.match(
    /^(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(.+)/i
  ) || lower.match(
    /^(.+?)\s+(?:number\s+)?(\d+)$/i
  );
  if (ordMatch) {
    const idx = ORDINALS[ordMatch[1]?.toLowerCase()];
    if (idx !== undefined) return { targetMatch: ordMatch[2].trim(), ordinal: idx };
    const num = parseInt(ordMatch[2]);
    if (!isNaN(num)) return { targetMatch: ordMatch[1].trim(), ordinal: num - 1 };
  }
  // Status-based: "the busy one", "the active one"
  const statusMatch = lower.match(/^(?:the\s+)?(busy|active|idle|sleeping|error)\s+one$/i);
  if (statusMatch) {
    return { targetMatch: statusMatch[1].toLowerCase(), ordinal: 0 };
  }
  return null;
}


// ── Public API ───────────────────────────────────────────────

/**
 * Parse a voice transcript into an AppCommand.
 * Uses multi-strategy intent scoring for robust NLU.
 * Falls back to `{ kind: 'message', text }` when nothing matches.
 * (Lenient — always returns a command, never null.)
 */
export function parseVoiceCommand(transcript: string): AppCommand {
  const cmd = parseCommand(transcript);
  return cmd ?? { kind: 'message', text: transcript.trim() };
}

/**
 * Strict parse — returns null when text is just a plain message.
 * Use this for the chat bar to distinguish commands from chat.
 */
export function parseCommand(text: string): AppCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ── Intent engine ─────────────────────────────────────
  const best = scoreIntents(trimmed);
  if (best && best.match) {
    try {
      const cmd = best.intent.extract(best.match);

      // Spawn with count from the extracted result
      if (cmd.kind === 'spawn') {
        return cmd as AppCommand;
      }
      if (cmd.kind === 'remove') {
        if ('query' in cmd) return cmd as AppCommand;
        return { kind: 'remove', query: (cmd as any).query || '' } as AppCommand;
      }
      if (cmd.kind === 'removeAll') {
        return { kind: 'removeAll' } as AppCommand;
      }
      if (cmd.kind === 'arrange') {
        return cmd as AppCommand;
      }
      if (cmd.kind === 'focus') {
        return cmd as AppCommand;
      }
      if (cmd.kind === 'message') {
        // Only return help messages; general messages go through fallback
        if ((cmd as any).text === 'voice-help') {
          return cmd as AppCommand;
        }
        // Message to a specific agent
        if ((cmd as any).agentName) {
          return cmd as AppCommand;
        }
      }
      if (cmd.kind === 'browser') {
        return cmd as AppCommand;
      }
      if (cmd.kind === 'music') {
        return cmd as AppCommand;
      }

      return cmd as AppCommand;
    } catch {
      // Fall through to fallback
    }
  }

  // ── Legacy direct patterns (keep for backward compat) ──

  const lower = trimmed.toLowerCase();

  // "prompt X to Y" / "tell X to Y" / "ask X to Y"
  const promptTriggers = [
    /^(prompt|tell|ask|instruct)\s+(.+?)\s+(?:to|about|regarding)\s+(.+)/i,
    /^(prompt|tell|ask)\s+(.+?)\s+to\s+do\s+(.+)/i,
  ];
  for (const re of promptTriggers) {
    const m = trimmed.match(re);
    if (m) {
      return { kind: 'message', text: m[3].trim(), agentName: m[2].trim() };
    }
  }

  // "send it to X" / "route to X"
  const sendTriggers = [
    /send\s+(?:it|this|that)\s+to\s+(.+)/i,
    /route\s+(?:it|this|that)\s+to\s+(.+)/i,
    /forward\s+(?:it|this|that)\s+to\s+(.+)/i,
    /give\s+(?:it|this|that)\s+to\s+(.+)/i,
  ];
  for (const re of sendTriggers) {
    const m = trimmed.match(re);
    if (m) {
      return { kind: 'focus', query: m[1].trim() };
    }
  }

  return null;
}

// ── Help text ────────────────────────────────────────────────

export const VOICE_HELP_TEXT = `🎤 **Voice Commands**
━━━━━━━━━━━━━━━━━━━━━━
**Spawning agents:**
  "spawn Hermes"  "launch Claude Code"  "open two Codex"
  "give me an OpenCode agent"  "summon a Claude agent"

**Removing agents:**
  "remove Max"  "close the Claude agent"  "kill all"
  "vanish the first agent"  "get rid of Eve"

**Canvas control:**
  "arrange"  "tidy up"  "grid layout"  "stage view"
  "focus on Sky"  "zoom to Zed"  "show me the busy one"

**Sending messages:**
  "tell Claude to run tests"  "ask Hermes to check the code"
  "send this to Eve"

**Browser & Music:**
  "open browser"  "close browser"
  "play music"  "next track"  "pause"  "search jazz on youtube"

**System:**
  "help"  "what can you do"`;

export function getVoiceHelpText(): string {
  return VOICE_HELP_TEXT;
}
