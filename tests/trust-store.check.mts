// Remembered folder trust (electron/trust-store.ts).
//
// Claude Code never saves trust for the home directory, so every agent
// ORCH started there asked "Do you trust this folder?" again. ORCH now
// remembers the user's own answer per agent type and folder.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { TrustStore, normaliseFolder } from '../electron/trust-store.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else { fail++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-trust-'));
const file = path.join(dir, 'trusted-folders.json');

{
  const s = new TrustStore(file, 'win32');
  ok('nothing is trusted to start with', !s.isTrusted('claude-code', 'C:\\Users\\me'));
  s.remember('claude-code', 'C:\\Users\\me');
  ok('a trusted folder is remembered', s.isTrusted('claude-code', 'C:\\Users\\me'));
  ok('Windows paths match whatever the case or trailing slash',
    s.isTrusted('claude-code', 'c:\\users\\ME\\') && s.isTrusted('claude-code', 'C:/Users/me'));
  ok('trust is per agent type', !s.isTrusted('codex', 'C:\\Users\\me'));
  ok('trust is per folder, not its children', !s.isTrusted('claude-code', 'C:\\Users\\me\\project'));
  ok('no folder, no trust', !s.isTrusted('claude-code', undefined));
  s.remember('claude-code', 'C:\\Users\\me');
  ok('remembering twice keeps one entry', s.list().length === 1, s.list());
}
{
  const s = new TrustStore(file, 'win32');
  ok('trust survives a restart', s.isTrusted('claude-code', 'C:\\Users\\me'));
  ok('forget removes it', s.forget('claude-code', 'C:\\USERS\\me') && !s.isTrusted('claude-code', 'C:\\Users\\me'));
  ok('forgetting an unknown folder is a no-op', !s.forget('claude-code', 'C:\\nope'));
}
{
  const s = new TrustStore(file, 'win32');
  ok('forgetting survives a restart', !s.isTrusted('claude-code', 'C:\\Users\\me') && s.list().length === 0);
}
{
  fs.writeFileSync(file, '{ not json');
  const s = new TrustStore(file, 'win32');
  ok('a corrupt file starts empty instead of throwing', s.list().length === 0);
}
ok('POSIX paths keep their case', normaliseFolder('/home/Me/', 'linux') === '/home/Me');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\ntrust-store pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
