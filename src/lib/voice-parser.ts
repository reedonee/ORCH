// ── Local Voice Command Parser ─────────────────────────────────
// Parses voice transcripts into AppCommands without needing the VPS brain.
// Supports: spawn, remove/kill, arrange, focus, prompt/send-to, and plain messages.

import type { AppCommand } from './agent-commands';

const PROVIDER_ALIASES: Record<string, string[]> = {
  hermes: ['hermes', 'hermes agent', 'hermes cli'],
  'claude-code': ['claude', 'claude code', 'claude ai', 'anthropic'],
  codex: ['codex', 'openai codex'],
  opencode: ['opencode', 'open code'],
};

/** Reverse-lookup: "hermes agent" → "hermes" */
const ALIAS_TO_PROVIDER: [string, string][] = [];
for (const [provider, aliases] of Object.entries(PROVIDER_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_PROVIDER.push([alias, provider]);
  }
}
// Sort longest-first so "claude code" matches before "claude"
ALIAS_TO_PROVIDER.sort((a, b) => b[0].length - a[0].length);

/** Extract a provider ID from text like "spawn hermes agent" */
function extractProvider(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [alias, provider] of ALIAS_TO_PROVIDER) {
    if (lower.includes(alias)) return provider;
  }
  return null;
}

/** Extract a name/query from text after a trigger like "focus sky" */
function extractName(text: string, trigger: string): string | null {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(trigger.toLowerCase());
  if (idx === -1) return null;
  const after = text.slice(idx + trigger.length).trim();
  // Take the first word or two (multi-word names like "Blue Jay")
  const words = after.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  // If followed by "to" or "to do", only take up to that
  const toIdx = words.findIndex(w => w.toLowerCase() === 'to');
  return toIdx > 0 ? words.slice(0, toIdx).join(' ') : words[0];
}

/**
 * Parse a voice transcript into an AppCommand.
 * Falls back to `{ kind: 'message', text }` when no command pattern is detected.
 * (Lenient — always returns a command, never null.)
 */
export function parseVoiceCommand(transcript: string): AppCommand {
  const cmd = parseCommand(transcript);
  return cmd ?? { kind: 'message', text: transcript.trim() };
}

/**
 * Strict parse — returns null when text is just a plain message.
 * Use this for the chat bar so it can distinguish /commands from chat messages.
 */
export function parseCommand(text: string): AppCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // ── spawn / open / launch agent ─────────────────────────────
  const spawnTriggers = [
    /^(spawn|open|launch|create|start|add)\s+(.+)/i,
    /^(i need|make|give me)\s+(?:a|an|the)?\s*(.+)/i,
  ];
  for (const re of spawnTriggers) {
    const m = text.match(re);
    if (m) {
      const after = m[2].trim();
      const provider = extractProvider(after);
      if (provider) {
        return { kind: 'spawn', providerId: provider, count: 1, name: after };
      }
      // Try fuzzy: if the word after "spawn" looks like a provider name
      const firstWord = after.split(/\s+/)[0];
      if (firstWord) {
        // Default to hermes if we can't identify the provider
        return { kind: 'spawn', providerId: 'hermes', count: 1, name: firstWord };
      }
    }
  }

  // ── remove / close / kill / vanish agent ────────────────────
  const removeTriggers = [
    /^(remove|close|kill|delete|dismiss|vanish)\s+(.+)/i,
    /^(get rid of|take down|shut down)\s+(?:the\s+)?(.+)/i,
  ];
  for (const re of removeTriggers) {
    const m = text.match(re);
    if (m) {
      const query = m[2].trim();
      if (/all|everyone|everything|every/.test(query.toLowerCase())) {
        return { kind: 'removeAll' };
      }
      return { kind: 'remove', query };
    }
  }

  // ── remove all / close all / kill all ───────────────────────
  if (/^(remove|close|kill|delete|clear|vanish)\s+(all|everyone|everything)/i.test(text)) {
    return { kind: 'removeAll' };
  }

  // ── arrange / organize / layout agents ──────────────────────
  const arrangeMatch = text.match(/^(arrange|organize|layout|sort|tidy|grid|clean|neaten|stage)\s*(.+)?$/i);
  if (arrangeMatch) {
    const modeWord = arrangeMatch[2]?.trim().toLowerCase();
    if (modeWord) {
      // Map natural language to layout mode
      if (/^tidy|neaten|clean|straighten|organize$/.test(modeWord)) {
        return { kind: 'arrange', mode: 'tidy' };
      }
      if (/^grid|matrix|snap|align$/.test(modeWord)) {
        return { kind: 'arrange', mode: 'grid' };
      }
      if (/^stage|theater|cinema|cinematic|focus|spotlight$/.test(modeWord)) {
        return { kind: 'arrange', mode: 'stage' };
      }
      // Unknown mode — use the word as the command (e.g. "layout grid")
      // Try best-guess mapping
      return { kind: 'arrange' };
    }
    // Just "arrange" with no mode — triggers default fluid layout
    return { kind: 'arrange' };
  }

  // ── focus / select / switch to agent ────────────────────────
  const focusTriggers = [
    /^(focus on|focus|select|switch to|go to|highlight)\s+(.+)/i,
  ];
  for (const re of focusTriggers) {
    const m = text.match(re);
    if (m) {
      const query = m[2].trim();
      return { kind: 'focus', query };
    }
  }

  // ── "prompt X to Y" / "tell X to Y" / "ask X to Y" ─────────
  const promptTriggers = [
    /^(prompt|tell|ask|instruct)\s+(.+?)\s+(?:to|about|regarding|regarding)\s+(.+)/i,
    /^(prompt|tell|ask)\s+(.+?)\s+to\s+do\s+(.+)/i,
  ];
  for (const re of promptTriggers) {
    const m = text.match(re);
    if (m) {
      const target = m[2].trim();
      const instruction = m[3].trim();
      // Send as a message to the named agent
      return { kind: 'message', text: instruction, agentName: target };
    }
  }

  // ── "send it to X" / "send this to X" / "route to X" ───────
  const sendTriggers = [
    /send\s+(?:it|this|that)\s+to\s+(.+)/i,
    /route\s+(?:it|this|that)\s+to\s+(.+)/i,
    /forward\s+(?:it|this|that)\s+to\s+(.+)/i,
    /give\s+(?:it|this|that)\s+to\s+(.+)/i,
  ];
  for (const re of sendTriggers) {
    const m = text.match(re);
    if (m) {
      const target = m[1].trim();
      return { kind: 'focus', query: target };
    }
  }

  // ── help / what can I say ───────────────────────────────────
  if (/^(help|what can you do|commands|voice help)/i.test(text)) {
    return { kind: 'message', text: 'voice-help' };
  }

  // ── Plain text — not a command ──────────────────────────────
  return null;
}
