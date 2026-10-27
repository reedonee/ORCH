// Approval prompt detection and answering (electron/agent-approvals.ts).
//
// The claude-code fixtures are real PTY captures of Claude Code 2.1.310
// under Windows ConPTY (paths scrubbed), which is the hard case: ConPTY
// turns newlines and spaces into cursor moves. The codex cases are built
// from the strings in codex-rs's approval_overlay.rs.

import fs from 'fs';
import {
  ApprovalTracker, approvalKeys, detectApprovalPrompt, isUserKeystroke,
  shouldAutoApprove, stripPermissionBypass, terminalText,
} from '../electron/agent-approvals.ts';

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}.raw`, import.meta.url), 'utf8');

/** Feed raw output in small pieces, as a PTY delivers it, collecting raises. */
function replay(t: ApprovalTracker, raw: string, step = 97) {
  const raised = [];
  for (let i = 0; i < raw.length; i += step) {
    const p = t.feed(raw.slice(i, i + step));
    if (p) raised.push({ kind: p.kind, question: p.question, detail: p.detail });
  }
  return raised;
}

// ── Launch args ─────────────────────────────────────────────
eq('strip claude bypass', stripPermissionBypass(['--dangerously-skip-permissions', '--continue']), ['--continue']);
eq('strip codex bypass', stripPermissionBypass(['-y', '@openai/codex', '--yolo']), ['-y', '@openai/codex']);
eq('keep ordinary args', stripPermissionBypass(['--model', 'haiku']), ['--model', 'haiku']);

// ── ConPTY text recovery ────────────────────────────────────
eq('cursor-forward becomes spaces', terminalText('Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?'), 'Do you want to proceed?');
eq('cursor-position becomes newline', terminalText('a\x1b[7;2Hb'), 'a\nb');
eq('colours and titles stripped', terminalText('\x1b]0;title\x07\x1b[38;2;1;2;3mhi\x1b[m'), 'hi');

// ── Real Claude Code captures ───────────────────────────────
{
  const t = new ApprovalTracker('a1', 'Max', 'claude-code', 'manual');
  eq('claude tool prompt (real capture)', replay(t, fixture('claude-code-tool-prompt')),
    [{ kind: 'tool', question: 'Do you want to proceed?', detail: 'mkdir orch-probe-dir' }]);
  // Same chunking at a different size must find the same single prompt.
  const t2 = new ApprovalTracker('a1', 'Max', 'claude-code', 'manual');
  eq('chunk size does not matter', replay(t2, fixture('claude-code-tool-prompt'), 13).length, 1);
}
{
  const t = new ApprovalTracker('a1', 'Max', 'claude-code', 'manual');
  eq('claude trust prompt (real capture)', replay(t, fixture('claude-code-trust-prompt')),
    [{ kind: 'trust', question: 'Is this a project you created or one you trust?', detail: 'trust this folder' }]);
}

// ── Repaints, answering, and scrollback ─────────────────────
{
  const prompt = '\x1b[2;1HBash command\x1b[3;1H  npm test\x1b[4;1HDo you want to proceed?\x1b[5;1H❯ 1. Yes\x1b[6;1H  3. No';
  const t = new ApprovalTracker('a1', 'Max', 'claude-code', 'manual');
  eq('raises once', t.feed(prompt)?.detail, 'npm test');
  eq('repaint of the same prompt is not news', t.feed(prompt), null);
  eq('focus report does not answer', t.noteInput('\x1b[I'), false);
  eq('still pending after focus report', t.pending?.detail, 'npm test');
  eq('a keystroke answers', t.noteInput('1'), true);
  eq('cleared', t.pending, null);
  eq('old prompt in scrollback is not re-raised', t.feed('\x1b[8;1H● Ran npm test'), null);
  eq('a new prompt raises again', t.feed(prompt.replace('npm test', 'npm run build'))?.detail, 'npm run build');
}

// ── ConPTY repaints an answered prompt that is still on screen ─
// Found in the end-to-end run: the repaint was raised as a new prompt and
// auto mode pressed "1" into the agent's input box.
{
  const prompt = (cmd: string) => `${'─'.repeat(40)}\nPowerShell command\nRun ${cmd}\n${'╌'.repeat(40)}\n${cmd}\n${'╌'.repeat(40)}\n` +
    'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and always allow access\n  3. No\nEsc to cancel · Tab to amend\n';
  const t = new ApprovalTracker('a1', 'Max', 'claude-code', 'auto');
  eq('live prompt raises', t.feed(prompt('mkdir two'))?.detail, 'mkdir two');
  t.noteInput('\x1b');
  eq('repaint of the denied prompt, with what followed, is not raised',
    t.feed(`\x1b[H${prompt('mkdir two')}\n  Interrupted · What should Claude do instead?\n`), null);
  eq('repaint after an approval is not raised',
    t.feed(`\x1b[H${prompt('mkdir two')}\n● Ran mkdir two\n`), null);
  eq('the next real prompt still raises', t.feed(prompt('mkdir three'))?.detail, 'mkdir three');
}
// Found in the second end-to-end run: ConPTY repainted the just-answered
// prompt BEFORE the CLI's next output, so it was briefly the last thing on
// screen and auto mode pressed "1" a second time.
{
  const prompt = 'Bash command\n  npm test\nDo you want to proceed?\n❯ 1. Yes\n  3. No\nEsc to cancel\n';
  const t = new ApprovalTracker('a1', 'Max', 'claude-code', 'auto');
  t.feed(prompt, 1000);
  t.noteInput('1', 1100);
  eq('repaint of the answered prompt inside the settle window is ignored', t.feed(`\x1b[H${prompt}`, 1300), null);
  eq('stillLive is false once the next output lands', (t.feed(prompt, 1400), t.feed('\n● Ran npm test\n', 1500), t.stillLive()), false);
  const t2 = new ApprovalTracker('a1', 'Max', 'claude-code', 'auto');
  t2.feed(prompt, 1000);
  t2.noteInput('1', 1100);
  eq('the same prompt asked again after the window raises', t2.feed(prompt, 1100 + 2500)?.detail, 'npm test');
  eq('a live pending prompt reports stillLive', t2.stillLive(), true);
}

// ── Word-wrapped prompts (narrow cards) ─────────────────────
// A CLI in a narrow card wraps its question over lines; requiring it on
// one line meant the prompt was never seen.
{
  const trust = 'Accessing workspace:\n\nC:\\Users\\me\n\nQuick safety check: Is this a project you\ncreated or one you trust? (Like your own\ncode.)\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel\n';
  eq('wrapped trust prompt is recognised',
    detectApprovalPrompt('claude-code', trust),
    { kind: 'trust', question: 'Is this a project you created or one you trust?', detail: 'trust this folder' });
  const edit = 'Edit file\nsrc/components/AgentCard.tsx\nDo you want to make this edit to\nAgentCard.tsx?\n❯ 1. Yes\n  2. Yes, allow all edits\n  3. No\n';
  eq('wrapped edit question is recognised, as one line',
    detectApprovalPrompt('claude-code', edit)?.detail, 'make this edit to AgentCard.tsx');
}

// ── Not a prompt ────────────────────────────────────────────
eq('question without options is just text',
  detectApprovalPrompt('claude-code', 'I can refactor this. Do you want to proceed?\nLet me know.'), null);
eq('unsupported provider never raises',
  new ApprovalTracker('a1', 'Zed', 'hermes', 'manual').feed('Do you want to proceed?\n1. Yes'), null);
eq('claude edit prompt names the file',
  detectApprovalPrompt('claude-code', 'Edit file\nsrc/App.tsx\nDo you want to make this edit to App.tsx?\n❯ 1. Yes\n  2. Yes, allow all edits\n  3. No')?.detail,
  'make this edit to App.tsx');

// ── Codex ───────────────────────────────────────────────────
eq('codex command prompt',
  detectApprovalPrompt('codex', 'Would you like to run the following command?\n\n  $ npm test\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)'),
  { kind: 'tool', question: 'Would you like to run the following command?', detail: 'npm test' });
eq('codex edits prompt',
  detectApprovalPrompt('codex', 'Would you like to make the following edits?\n\n› 1. Yes, proceed (y)\n  2. Yes, and don\'t ask again for these files (a)')?.detail,
  'make the following edits');

// ── Keys ────────────────────────────────────────────────────
eq('claude approve presses 1 (Yes, once)', approvalKeys('claude-code', 'approve'), '1');
eq('claude deny presses Esc', approvalKeys('claude-code', 'deny'), '\x1b');
eq('codex approve presses y', approvalKeys('codex', 'approve'), 'y');
eq('codex deny presses Esc', approvalKeys('codex', 'deny'), '\x1b');
eq('trust approve moves to Yes, then Enter', approvalKeys('claude-code', 'approve', 'trust'), '\x1b[B\r');
eq('trust deny exits', approvalKeys('claude-code', 'deny', 'trust'), '\x1b');
eq('unknown provider has no keys', approvalKeys('hermes', 'approve'), null);

// ── Auto mode ───────────────────────────────────────────────
eq('auto approves tool prompts', shouldAutoApprove('auto', { kind: 'tool', question: '', detail: '' }), true);
eq('auto never trusts a folder', shouldAutoApprove('auto', { kind: 'trust', question: '', detail: '' }), false);
eq('manual approves nothing', shouldAutoApprove('manual', { kind: 'tool', question: '', detail: '' }), false);

// ── Keystrokes vs terminal reports ──────────────────────────
eq('Esc alone is a keystroke', isUserKeystroke('\x1b'), true);
eq('Enter is a keystroke', isUserKeystroke('\r'), true);
eq('device attributes reply is not', isUserKeystroke('\x1b[?1;2c'), false);
eq('focus out is not', isUserKeystroke('\x1b[O'), false);

console.log(`\nagent-approvals pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
