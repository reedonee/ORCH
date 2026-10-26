// ── ORCH Command Bar Intelligence ───────────────────────────────
// Everything the command bar needs to feel like it understands you
// BEFORE you press Enter.
//
// The bar previously did one thing: on Enter, parse the text, run it, and
// send failures to console.warn. So a mistyped agent name looked
// identical to success — the input just cleared. There was no history, no
// completion, no way to see what it thought you meant, and no way to
// address a specific agent except by selecting its card first.
//
// This module supplies the analysis; the component renders it.

import type { AppCommand } from './agent-commands';
import { parseCommand } from './voice-parser';
import { shortName } from './voice-narration';

export interface AgentLike {
  id: string;
  name: string;
  provider?: string;
  status?: string;
}

export interface Completion {
  /** Text to insert when accepted. */
  value: string;
  /** What the user sees. */
  label: string;
  hint?: string;
  kind: 'agent' | 'command' | 'provider';
}

export interface InputAnalysis {
  /** Always a command — plain text becomes a `message` to the selected agent. */
  command: AppCommand;
  /** One line describing what will happen. Shown next to the input. */
  preview: string;
  /** Agent explicitly addressed with @name, if any. */
  target: AgentLike | null;
  /** Message body with the @mention removed. */
  body: string;
  /** Inline completions for the token under the cursor. */
  completions: Completion[];
  /** True when the input names an agent that doesn't exist. */
  unknownMention: string | null;
}

// ── Known verbs, for completion ─────────────────────────────────

const COMMAND_HINTS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'spawn ',      label: 'spawn',      hint: 'start a new agent' },
  { value: 'close ',      label: 'close',      hint: 'shut down an agent' },
  { value: 'close all',   label: 'close all',  hint: 'shut down every agent' },
  { value: 'focus ',      label: 'focus',      hint: 'select an agent' },
  { value: 'arrange ',    label: 'arrange',    hint: 'tidy the canvas' },
  { value: 'grid layout', label: 'grid',       hint: 'even grid' },
  { value: 'focus layout',label: 'focus view', hint: 'one large, rest in a rail' },
  { value: 'split view',  label: 'split',      hint: 'two columns' },
  { value: 'rail layout', label: 'rail',       hint: 'horizontal strip' },
  { value: 'constellation view', label: 'constellation', hint: 'cluster by relationship' },
  { value: 'open browser', label: 'browser',   hint: 'open the web panel' },
  { value: 'play music',  label: 'music',      hint: 'open the player' },
];

const PROVIDER_HINTS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'claude', label: 'Claude Code', hint: 'Anthropic CLI' },
  { value: 'hermes', label: 'Hermes',      hint: 'Hermes agent' },
  { value: 'codex',  label: 'Codex',       hint: 'OpenAI CLI' },
  { value: 'opencode', label: 'OpenCode',  hint: 'OpenCode agent' },
];

// ── @mention parsing ────────────────────────────────────────────

const MENTION_RE = /(^|\s)@([\w-]+)/;

/**
 * Resolve an @mention to an agent.
 *
 * Matching is on the short name ("Max"), case-insensitively, because that
 * is what the user sees on the card — not the full "Max - Claude Code".
 */
export function resolveMention(
  text: string,
  agents: AgentLike[],
): { target: AgentLike | null; body: string; mention: string | null } {
  const m = MENTION_RE.exec(text);
  if (!m) return { target: null, body: text, mention: null };

  const mention = m[2];
  const lower = mention.toLowerCase();

  const target =
    agents.find((a) => shortName(a.name).toLowerCase() === lower) ??
    agents.find((a) => shortName(a.name).toLowerCase().startsWith(lower)) ??
    null;

  const body = text.replace(MENTION_RE, '$1').trim();
  return { target, body, mention };
}

// ── Completions ─────────────────────────────────────────────────

function agentCompletions(prefix: string, agents: AgentLike[]): Completion[] {
  const lower = prefix.toLowerCase();
  return agents
    .filter((a) => shortName(a.name).toLowerCase().startsWith(lower))
    .slice(0, 6)
    .map((a) => ({
      value: `@${shortName(a.name)} `,
      label: shortName(a.name),
      hint: a.provider ? `${a.provider}${a.status ? ` · ${a.status}` : ''}` : a.status,
      kind: 'agent' as const,
    }));
}

function verbCompletions(prefix: string): Completion[] {
  if (!prefix) return [];
  const lower = prefix.toLowerCase();
  const out: Completion[] = [];

  for (const c of COMMAND_HINTS) {
    if (c.label.toLowerCase().startsWith(lower) || c.value.toLowerCase().startsWith(lower)) {
      out.push({ value: c.value, label: c.label, hint: c.hint, kind: 'command' });
    }
  }
  for (const p of PROVIDER_HINTS) {
    if (p.value.startsWith(lower) || p.label.toLowerCase().startsWith(lower)) {
      out.push({ value: `spawn ${p.value}`, label: `spawn ${p.label}`, hint: p.hint, kind: 'provider' });
    }
  }
  return out.slice(0, 7);
}

// ── Preview ─────────────────────────────────────────────────────

/** Human-readable description of what a parsed command will do. */
export function describeCommand(command: AppCommand | null, target: AgentLike | null): string {
  if (target) return `Send to ${shortName(target.name)}`;
  if (!command) return 'Send to the selected agent';

  switch (command.kind) {
    case 'spawn': {
      const n = command.count ?? 1;
      const who = command.name ? ` named ${command.name}` : '';
      return n > 1 ? `Start ${n} ${command.providerId} agents` : `Start ${command.providerId}${who}`;
    }
    case 'remove':    return `Close ${command.query}`;
    case 'removeAll': return 'Close every agent';
    case 'arrange':   return command.mode ? `Arrange: ${command.mode}` : 'Tidy the canvas';
    case 'focus':     return `Focus ${command.query}`;
    case 'browser':   return command.action === 'open'
      ? (command.url ? `Open browser at ${command.url}` : 'Open browser')
      : 'Close browser';
    case 'music':     return `Music: ${command.action}`;
    case 'message':   return command.agentName
      ? `Send to ${command.agentName}`
      : 'Send to the selected agent';
    default:          return 'Run command';
  }
}

/**
 * Analyse the current input.
 *
 * `cursorToken` is the word the caret sits in — completions apply to that
 * token, so typing "@ma" mid-sentence still suggests Max.
 */
export function analyzeInput(text: string, agents: AgentLike[]): InputAnalysis {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      command: { kind: 'message', text: '' },
      preview: '', target: null, body: '',
      completions: [], unknownMention: null,
    };
  }

  const { target, body, mention } = resolveMention(trimmed, agents);

  // An explicit @mention always wins: it is a routing instruction, not a
  // command verb, so "@Max close the file" must reach Max rather than
  // being parsed as the `close` command.
  //
  // Anything that isn't a recognised command is a PROMPT for the selected
  // agent. parseCommand() deliberately returns null for plain text, so
  // falling back to a `message` command here is what actually connects
  // the bar to the terminals — without it, typing a prompt silently
  // cleared the input and went nowhere.
  const command: AppCommand = target
    ? { kind: 'message', text: body, agentName: target.name }
    : (parseCommand(trimmed) ?? { kind: 'message', text: trimmed });

  // Completions for the final token, which is what the caret usually follows.
  const lastToken = trimmed.split(/\s+/).pop() ?? '';
  let completions: Completion[] = [];
  if (lastToken.startsWith('@')) {
    completions = agentCompletions(lastToken.slice(1), agents);
  } else if (!trimmed.includes(' ')) {
    completions = verbCompletions(lastToken);
  }

  return {
    command,
    preview: describeCommand(command, target),
    target,
    body,
    completions,
    unknownMention: mention && !target ? mention : null,
  };
}

// ── History ─────────────────────────────────────────────────────

const HISTORY_KEY = 'orch-command-history';
const HISTORY_MAX = 200;

export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function pushHistory(entry: string): string[] {
  const clean = entry.trim();
  if (!clean) return loadHistory();
  // Drop an immediately-repeated entry; cycling past three identical
  // lines is pure friction.
  const existing = loadHistory().filter((e) => e !== clean);
  const next = [...existing, clean].slice(-HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* quota */ }
  return next;
}

export function clearHistory(): void {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
