import {
  shortName, speakList, narrate, narrateSpawn, narrateRemoval,
  pluralAgents, resetNarrationCursors, narrateApproval,
} from '../src/lib/voice-narration.ts';

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (got === want) pass++;
  else { fail++; console.log(`FAIL ${label}\n  got:  ${got}\n  want: ${want}`); };
};

// Names must lose the provider suffix before being spoken.
eq('shortName strips suffix', shortName('Max - Claude Code'), 'Max');
eq('shortName plain', shortName('Sky'), 'Sky');
eq('shortName empty', shortName(''), 'the agent');
eq('shortName null', shortName(null), 'the agent');

eq('list 1', speakList(['Max - Claude Code']), 'Max');
eq('list 2', speakList(['Max', 'Sky']), 'Max and Sky');
eq('list 3', speakList(['Max', 'Sky', 'Zed']), 'Max, Sky and Zed');
eq('list 5', speakList(['Max','Sky','Zed','Eve','Blue']), 'Max, Sky and 3 others');

// The headline requirement: agent names, correct verb agreement.
resetNarrationCursors();
eq('spawn 1 names agent', narrateSpawn(['Max - Claude Code'], 'starting'), 'Max is spinning up');
resetNarrationCursors();
eq('spawn ready 1', narrateSpawn(['Max'], 'ready'), 'Max is ready');
resetNarrationCursors();
eq('spawn 2 plural verb', narrateSpawn(['Max', 'Sky'], 'starting'), 'Max and Sky are spinning up');
resetNarrationCursors();
eq('removal 1', narrateRemoval(['Zed - Hermes']), 'Zed is gone');
resetNarrationCursors();
eq('removal many', narrateRemoval(['a','b','c','d','e']), 'Closed five agents');
eq('plural agents 1', pluralAgents(1), 'one agent');
eq('plural agents 3', pluralAgents(3), 'three agents');
eq('plural agents 42', pluralAgents(42), '42 agents');

// Repeated events must not repeat verbatim.
resetNarrationCursors();
const said = [narrate('ready', ['Max']), narrate('ready', ['Max']), narrate('ready', ['Max'])];
if (new Set(said).size < 2) { fail++; console.log('FAIL variation: identical phrasing every time', said); }
else pass++;

// Every phrase must actually contain the name — that is the whole point.
resetNarrationCursors();
for (const ev of ['spinningUp','ready','removed','focused','sent','working','finished','failed','sleeping','woken',
  'needsApproval','approved','denied','autoApprove','manualApprove','controllerSet'] as const) {
  for (let i = 0; i < 4; i++) {
    const line = narrate(ev, ['Max']);
    if (!line.includes('Max')) { fail++; console.log(`FAIL ${ev} dropped the name: "${line}"`); }
    else pass++;
    if (/\bagent (spawned|closed|starting)\b/i.test(line)) {
      fail++; console.log(`FAIL ${ev} used anonymous phrasing: "${line}"`);
    }
  }
}

// Approval prompts say what is being approved.
resetNarrationCursors();
eq('approval names command', narrateApproval('Max - Claude Code', 'npm test', 'tool'), 'Max needs your approval: npm test');
resetNarrationCursors();
eq('approval trust', narrateApproval('Sky', 'trust this folder', 'trust'), 'Sky needs your approval to trust this folder');
resetNarrationCursors();
const long = narrateApproval('Max', 'npx vitest run --reporter verbose src/components/AgentCard.test.tsx --coverage', 'tool');
if (long.length > 95 || !long.endsWith('…') || !long.startsWith('Max needs your approval: npx vitest')) {
  fail++; console.log(`FAIL long approval detail not trimmed: "${long}"`);
} else pass++;

console.log(`\nnarration pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
