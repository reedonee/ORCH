// ── ORCH Agent Approvals ────────────────────────────────────────
// Agents used to launch with --dangerously-skip-permissions, so nothing
// they did was ever put to the user. They now launch with their own
// permission prompts intact, and ORCH watches each PTY for those prompts
// so it can surface them on the agent's card and by voice, and answer
// them on the user's behalf.
//
// Approval is per agent:
//   manual — every prompt waits for the user (card button, voice, or
//            typing into the terminal as before).
//   auto   — ORCH answers "yes" as soon as it sees the prompt. The CLI's
//            own sandbox still applies; only the question is skipped.
//
// Auto is implemented here rather than with the CLIs' bypass flags so it
// can be switched on a running agent, and so an auto-approved action
// still passes through ORCH (and is logged) instead of never being asked.
//
// Pure logic, no Electron imports: tests/agent-approvals.check.mts
// drives it directly.

export type ApprovalMode = 'auto' | 'manual';
export type ApprovalDecision = 'approve' | 'deny';

/** Flags that switch a CLI's permission prompts off. ORCH strips them
 *  from every launch, including ones persisted in older settings, since
 *  an agent that never asks can't be approved from the card. */
export const PERMISSION_BYPASS_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions',               // claude-code
  '--dangerously-bypass-approvals-and-sandbox',   // codex
  '--yolo',                                       // codex alias
];

export function stripPermissionBypass(args: readonly string[]): string[] {
  return args.filter((a) => !PERMISSION_BYPASS_FLAGS.includes(a));
}

/** Providers whose prompts ORCH can recognise and answer. Others still
 *  launch without bypass flags; their prompts just stay in the terminal. */
export const APPROVAL_PROVIDERS: readonly string[] = ['claude-code', 'codex'];

/** `tool` is a request to run something; `trust` is Claude Code's
 *  one-time "do you trust this folder" gate. Trust is never answered
 *  automatically: it grants the agent the whole folder, and its default
 *  option is "No, exit", so it also needs different keys. */
export type ApprovalKind = 'tool' | 'trust';

export interface ApprovalPrompt {
  kind: ApprovalKind;
  /** The CLI's question, e.g. "Do you want to proceed?" */
  question: string;
  /** What is being approved, short enough to speak: a command, or the
   *  question's own object ("make this edit to App.tsx"). */
  detail: string;
}

// ── Terminal text ─────────────────────────────────────────────
// Stripping escape codes is not enough to recover readable text. On
// Windows, ConPTY re-encodes the CLI's output: newlines become absolute
// cursor moves (ESC[7;2H) and runs of spaces become cursor-forward
// (ESC[1C), so a naive strip yields "Doyouwanttoproceed?". Translate the
// moves back into the whitespace they stand for, then strip the rest.

export function terminalText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')                // OSC (titles, links)
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n || 1), 200)))
    .replace(/\x1b\[\d*(?:;\d*)?[Hf]|\x1b\[\d*[BE]/g, '\n')           // cursor to a row / down
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g, '')
    .replace(/\r/g, '');
}

// ── Prompt recognition ─────────────────────────────────────────
// Both CLIs pair a question with an option list. Requiring BOTH keeps a
// model merely writing "Do you want to proceed?" in its reply from being
// mistaken for a prompt, which in auto mode would press a key into the
// user's input box.
//
// Strings verified against Claude Code 2.1.310 (its bundle, and a real
// PTY capture under ConPTY) and codex-rs
// tui/src/bottom_pane/approval_overlay.rs (Oct 2026).

interface PromptSpec {
  kind: ApprovalKind;
  question: RegExp;
  options: RegExp;
}

// Questions may be word-wrapped across lines: a CLI in a narrow card
// breaks "…a project you / created or one you trust?" over two lines, and
// a pattern that required one line never saw the prompt at all. So words
// are separated by \s+ and the free text may span lines (bounded).
const SPECS: Record<string, PromptSpec[]> = {
  'claude-code': [
    {
      kind: 'tool',
      question: /Do\s+you\s+want\s+to\s[^?]{1,200}\?/g,
      options: /No, and tell Claude what to do differently|\b1\.\s*Yes\b/,
    },
    {
      kind: 'trust',
      question: /Is\s+this\s+a\s+project\s+you\s+created\s+or\s+one\s+you\s+trust\?/g,
      options: /Yes,\s+I\s+trust\s+this\s+folder/,
    },
  ],
  'codex': [
    {
      kind: 'tool',
      question: /(?:Would\s+you\s+like\s+to\s[^?]{1,200}\?|Do\s+you\s+want\s+to\s+approve\s+network\s+access\s+to\s[^\n]{1,200})/g,
      options: /Yes, proceed|Yes, just this once|No, and tell Codex what to do differently/,
    },
  ],
};

/** Generic questions that say nothing about WHAT is being approved; for
 *  these the detail comes from the lines around the question instead. */
const GENERIC_QUESTION = /^(?:Do you want to proceed\?|Would you like to run the following command\?|Would you like to make the following edits\?)$/;

/** Panel titles that sit above the interesting line in Claude Code's
 *  prompt ("Bash command" / then the command itself). */
const PANEL_TITLE = /^(?:Bash command|PowerShell command|Edit file|Create file|Write file|Read file|Fetch|Web ?Search|Tool use|Network request|Permission)\b/i;

const BOX_CHARS = /[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▌▐❯›>]+/g;

function cleanLine(line: string): string {
  return line.replace(BOX_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

function clip(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Find a live approval prompt in `text` (ANSI-stripped output since the
 * user last typed). Returns the most recent one, or null.
 */
export function detectApprovalPrompt(providerId: string, text: string): ApprovalPrompt | null {
  const specs = SPECS[providerId];
  if (!specs || !text) return null;

  let best: { spec: PromptSpec; match: RegExpExecArray } | null = null;
  for (const spec of specs) {
    let last: RegExpExecArray | null = null;
    spec.question.lastIndex = 0;
    for (let m = spec.question.exec(text); m; m = spec.question.exec(text)) last = m;
    if (!last || !promptIsLive(text.slice(last.index), spec)) continue;
    if (!best || last.index > best.match.index) best = { spec, match: last };
  }
  if (!best) return null;

  const { spec, match } = best;
  const question = cleanLine(match[0]);
  if (spec.kind === 'trust') return { kind: 'trust', question, detail: 'trust this folder' };
  const after = text.slice(match.index, match.index + 2000);
  return { kind: 'tool', question, detail: describe(question, text.slice(0, match.index), after) };
}

/** Hints a CLI prints under its option list while a prompt is open. */
const FOOTER = /\b(?:esc|enter|tab|cancel|confirm|amend|shortcuts?)\b/i;

/**
 * A prompt is live only if it is the last thing on screen: its option
 * list, then nothing but footer hints. ConPTY repaints the whole visible
 * screen from time to time, so an answered prompt that is still in view
 * comes through again — followed by whatever happened next ("● Ran …",
 * "Interrupted"). Without this check that repaint was taken for a new
 * prompt, and in auto mode ORCH typed "1" into the agent's input box.
 */
function promptIsLive(fromQuestion: string, spec: PromptSpec): boolean {
  const lines = fromQuestion.split('\n');
  const lastOption = lines.findLastIndex((l) => /^\s*[❯›>]?\s*\d+\.\s/.test(l) || spec.options.test(l));
  if (lastOption < 0 || !spec.options.test(lines.slice(0, lastOption + 1).join('\n'))) return false;
  const trailing = lines.slice(lastOption + 1).filter((l) => l.trim());
  return trailing.length <= 3 && trailing.every((l) => FOOTER.test(l));
}

function describe(question: string, before: string, after: string): string {
  // Codex prints the command as "$ npm test" beside the question.
  const dollar = (after.match(/^\s*[│ ]*\$ (.+)$/m) ?? before.match(/^\s*[│ ]*\$ (.+)$/m))?.[1];
  if (dollar) return clip(cleanLine(dollar));

  // Codex draws no panel to read a body from, so its question is the
  // best description left once there is no "$ command" line.
  if (!GENERIC_QUESTION.test(question) || question.startsWith('Would you like')) {
    // "Do you want to make this edit to App.tsx?" → "make this edit to App.tsx"
    return clip(question.replace(/^(?:Do you want to|Would you like to)\s+/, '').replace(/\?$/, ''));
  }

  // Claude Code draws the panel as: a solid rule, a title ("Bash command",
  // or "PowerShell command" on Windows), a description, then the command
  // itself between dashed rules. Read from the last solid rule so the
  // spinner text above the panel is never mistaken for its body.
  //
  // The window can also still hold an earlier prompt (a repaint, or the
  // previous request), so the panel starts after whichever comes last: the
  // solid rule, or the end of a previous prompt's question or options.
  const lines = before.split('\n');
  const isRule = (l: string) => /^\s*[─━═╌┄┈-]{10,}\s*$/.test(l);
  const boundary = lines.findLastIndex((l) =>
    /^\s*[─━═]{10,}\s*$/.test(l) || /^\s*[❯›>]?\s*\d+\.\s/.test(l) || /\?\s*$/.test(l));
  const panel = lines.slice(boundary + 1).filter((l) => l.trim()).slice(-8);
  const dashed = panel.findIndex(isRule);
  const title = panel.findLastIndex((l) => PANEL_TITLE.test(cleanLine(l)));
  const pick = dashed >= 0
    ? panel.slice(dashed + 1).find((l) => !isRule(l))
    : title >= 0 ? panel[title + 1] : panel[0];
  return clip(cleanLine(pick ?? '') || question.replace(/\?$/, ''));
}

/** Keystrokes that answer a prompt. Approve picks the CLI's "yes, once"
 *  option — never "don't ask again", which would widen a permission the
 *  user only meant to grant this time. */
export function approvalKeys(providerId: string, decision: ApprovalDecision, kind: ApprovalKind = 'tool'): string | null {
  if (!APPROVAL_PROVIDERS.includes(providerId)) return null;
  if (kind === 'trust') {
    // Options are "No, exit" (selected) then "Yes, I trust this folder".
    // Esc there means exit, which is what deny should do anyway.
    return decision === 'approve' ? '\x1b[B\r' : '\x1b';
  }
  if (decision === 'deny') return '\x1b';
  return providerId === 'codex' ? 'y' : '1';   // codex keymap.approve; claude option "1. Yes"
}

// ── Input classification ──────────────────────────────────────
// xterm writes more than keystrokes to the PTY: focus in/out reports and
// replies to terminal queries arrive as escape sequences. Those must not
// count as the user answering, or a prompt would vanish from the card the
// moment the user clicked into the terminal to read it.

const TERMINAL_REPORT = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1bO.|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

export function isUserKeystroke(data: string): boolean {
  return data.replace(TERMINAL_REPORT, '').length > 0;
}

// ── Per-session tracker ───────────────────────────────────────

export interface PendingApproval extends ApprovalPrompt {
  agentId: string;
  name: string;
  providerId: string;
  since: number;
}

/** Raw bytes kept per session. A prompt is a few KB once ConPTY's cursor
 *  codes and colours are counted; the window only has to reach back from
 *  the option list to the panel title. */
const WINDOW_CHARS = 16000;

/** Auto mode answers tool prompts only. */
export function shouldAutoApprove(mode: ApprovalMode, prompt: ApprovalPrompt): boolean {
  return mode === 'auto' && prompt.kind === 'tool';
}

/** After a prompt is answered, ConPTY can repaint it once more before the
 *  CLI's next output arrives, and for that moment it looks live. Ignore
 *  that same prompt for this long after answering it. */
const SETTLE_MS = 2000;

const signature = (p: ApprovalPrompt) => `${p.kind}\n${p.question}\n${p.detail}`;

export class ApprovalTracker {
  readonly agentId: string;
  readonly name: string;
  readonly providerId: string;
  mode: ApprovalMode;
  pending: PendingApproval | null = null;
  private text = '';
  private answered: { sig: string; at: number } | null = null;

  // Plain fields, not parameter properties: the checks run under node's
  // --experimental-strip-types, which cannot strip those.
  constructor(agentId: string, name: string, providerId: string, mode: ApprovalMode) {
    this.agentId = agentId;
    this.name = name;
    this.providerId = providerId;
    this.mode = mode;
  }

  get supported(): boolean {
    return APPROVAL_PROVIDERS.includes(this.providerId);
  }

  /** Feed raw PTY output. Returns the prompt when one newly appears. */
  feed(raw: string, now = Date.now()): PendingApproval | null {
    if (!this.supported) return null;
    this.text = (this.text + raw).slice(-WINDOW_CHARS);
    const found = detectApprovalPrompt(this.providerId, terminalText(this.text));
    if (!found) return null;
    const sig = signature(found);
    // TUIs repaint while a prompt is up; the same prompt is not news.
    if (this.pending && signature(this.pending) === sig) return null;
    if (this.answered?.sig === sig && now - this.answered.at < SETTLE_MS) return null;
    this.pending = { ...found, agentId: this.agentId, name: this.name, providerId: this.providerId, since: now };
    return this.pending;
  }

  /** Whether the pending prompt is still the live one: nothing but its
   *  footer has been drawn since. Auto mode checks this before pressing,
   *  so a prompt superseded during the delay is never answered. */
  stillLive(): boolean {
    if (!this.pending) return false;
    const found = detectApprovalPrompt(this.providerId, terminalText(this.text));
    return !!found && signature(found) === signature(this.pending);
  }

  /** Note bytes written to the PTY. Any real keystroke answers (or
   *  dismisses) the prompt and starts a fresh window, so a prompt left in
   *  the scrollback is never detected twice. Returns true if a pending
   *  prompt was cleared. */
  noteInput(data: string, now = Date.now()): boolean {
    if (!isUserKeystroke(data)) return false;
    this.text = '';
    if (this.pending) this.answered = { sig: signature(this.pending), at: now };
    const had = this.pending !== null;
    this.pending = null;
    return had;
  }
}
