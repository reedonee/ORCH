import { parseVoiceCommand } from '../src/lib/voice-parser.ts';

const cases: Array<[string, string, string | undefined]> = [
  ['arrange',                          'arrange', undefined],
  ['tidy up',                          'arrange', 'grid'],
  ['grid layout',                      'arrange', 'grid'],
  ['arrange the agents in a grid',     'arrange', 'grid'],
  ['put them in a grid',               'arrange', 'grid'],
  ['focus layout',                     'arrange', 'focus'],
  ['arrange into focus',               'arrange', 'focus'],
  ['spotlight view',                   'arrange', 'focus'],
  ['split view',                       'arrange', 'split'],
  ['arrange them side by side',        'arrange', 'split'],
  ['two columns',                      'arrange', 'split'],
  ['rail layout',                      'arrange', 'rail'],
  ['line them up in a row',            'arrange', 'rail'],
  ['constellation view',               'arrange', 'constellation'],
  ['cluster the agents',               'arrange', 'constellation'],
  ['group them by relationship',       'arrange', 'constellation'],
  ['stage view',                       'arrange', 'stage'],
  ['clean up the canvas',              'arrange', 'grid'],
  ['organise everything',              'arrange', 'grid'],
];

let pass = 0, fail = 0;
for (const [utterance, wantKind, wantMode] of cases) {
  const cmd = parseVoiceCommand(utterance) as any;
  const gotMode = cmd.mode;
  const ok = cmd.kind === wantKind && gotMode === wantMode;
  if (ok) { pass++; }
  else { fail++; console.log(`FAIL  "${utterance}" -> kind=${cmd.kind} mode=${gotMode} (want ${wantKind}/${wantMode})`); }
}
console.log(`\npass=${pass} fail=${fail}`);

// Regression: non-layout commands must not be swallowed by the broadened
// arrange patterns.
const nonLayout = ['spawn claude', 'open a browser', 'close all agents', 'play some music'];
for (const u of nonLayout) {
  const c = parseVoiceCommand(u) as any;
  console.log(`  "${u}" -> ${c.kind}${c.mode ? '/' + c.mode : ''}`);
}

console.log('\n--- routing regression ---');
const routing: Array<[string, string]> = [
  ['open a browser', 'browser'], ['open browser', 'browser'], ['show the web preview', 'browser'],
  ['close the browser', 'browser'],
  ['play some music', 'music'], ['play music', 'music'], ['put on some music', 'music'],
  ['pause', 'music'], ['next track', 'music'],
  ['spawn claude', 'spawn'], ['open claude', 'spawn'], ['launch two codex agents', 'spawn'],
  ['close all agents', 'removeAll'], ['clean up the canvas', 'arrange'],
  ['go to https://example.com', 'browser'],
];
let rp = 0, rf = 0;
for (const [u, want] of routing) {
  const c = parseVoiceCommand(u) as any;
  if (c.kind === want) rp++;
  else { rf++; console.log(`FAIL  "${u}" -> ${c.kind} (want ${want})`); }
}
console.log(`routing pass=${rp} fail=${rf}`);

console.log('\n--- approvals ---');
// [utterance, kind, decision-or-mode, query, all]
const approvalCases: Array<[string, string, string, string | undefined, boolean?]> = [
  ['approve', 'approval', 'approve', undefined],
  ['approve it', 'approval', 'approve', undefined],
  ['approve max', 'approval', 'approve', 'max'],
  ['allow sky', 'approval', 'approve', 'sky'],
  ['let max go ahead', 'approval', 'approve', 'max'],
  ['deny', 'approval', 'deny', undefined],
  ['reject codex', 'approval', 'deny', 'codex'],
  ['approve all', 'approval', 'approve', undefined, true],
  ['approve everyone', 'approval', 'approve', undefined, true],
  ['set max to auto', 'approvalMode', 'auto', 'max'],
  ['put sky on manual', 'approvalMode', 'manual', 'sky'],
  ['make max auto', 'approvalMode', 'auto', 'max'],
  ['auto approve for zed', 'approvalMode', 'auto', 'zed'],
  ['turn on auto approve for max', 'approvalMode', 'auto', 'max'],
  ['turn off auto approve', 'approvalMode', 'manual', undefined],
];
let ap = 0, af = 0;
for (const [u, kind, value, query, all] of approvalCases) {
  const c = parseVoiceCommand(u) as any;
  const got = c.decision ?? c.mode;
  const ok = c.kind === kind && got === value && c.query === query && (all === undefined || !!c.all === all);
  if (ok) ap++;
  else { af++; console.log(`FAIL  "${u}" -> ${JSON.stringify(c)} (want ${kind}/${value} query=${query}${all ? ' all' : ''})`); }
}
// Ordinary replies must still reach the agent as chat, and the existing
// commands must not be captured by the new intents.
for (const [u, want] of [['yes', 'message'], ['no', 'message'], ['spawn claude', 'spawn'], ['focus on max', 'focus'], ['switch to max', 'focus']] as const) {
  const c = parseVoiceCommand(u) as any;
  if (c.kind === want) ap++;
  else { af++; console.log(`FAIL  "${u}" -> ${c.kind} (want ${want})`); }
}
console.log(`approvals pass=${ap} fail=${af}`);

console.log('\n--- controller ---');
const controllerCases: Array<[string, string, string | undefined, boolean?]> = [
  ['make max the controller', 'controller', 'max'],
  ['make sky controller', 'controller', 'sky'],
  ['set the controller to zed', 'controller', 'zed'],
  ['let max coordinate', 'controller', 'max'],
  ['let sky take charge', 'controller', 'sky'],
  ['clear the controller', 'controller', undefined, true],
  ['stop the coordinator', 'controller', undefined, true],
  ['make max auto', 'approvalMode', 'max'],
  ['spawn claude', 'spawn', undefined],
];
let cp = 0, cf = 0;
for (const [u, kind, query, clear] of controllerCases) {
  const c = parseVoiceCommand(u) as any;
  const good = c.kind === kind && (kind !== 'controller' || (c.query === query && !!c.clear === !!clear)) &&
    (kind !== 'approvalMode' || c.query === query);
  if (good) cp++; else { cf++; console.log(`FAIL  "${u}" -> ${JSON.stringify(c)} (want ${kind} ${query ?? ''}${clear ? ' clear' : ''})`); }
}
console.log(`controller pass=${cp} fail=${cf}`);
if (af || cf) process.exit(1);
