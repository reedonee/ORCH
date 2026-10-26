// Behaviour checks for the agent mesh: shared status, file-conflict
// detection, and addressed messaging between agents.
import { AgentMesh } from '../electron/agent-mesh.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${l}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const ok = (l: string, cond: boolean) => { if (cond) pass++; else { fail++; console.log(`FAIL ${l}`); } };

const mesh = new AgentMesh();

// ── Registration ──
mesh.register('a1', 'Max - Claude Code', 'claude-code');
mesh.register('a2', 'Sky - Codex', 'codex');
mesh.register('a3', 'Zed - Hermes', 'hermes');
eq('three agents registered', mesh.allStatuses().length, 3);
eq('starts idle', mesh.getStatus('a1')?.phase, 'idle');

// Re-registering must not duplicate or reset an in-flight agent.
mesh.setStatus('a1', { phase: 'working', task: 'refactoring auth' });
mesh.register('a1', 'Max - Claude Code', 'claude-code');
eq('re-register is idempotent', mesh.allStatuses().length, 3);
eq('re-register preserves status', mesh.getStatus('a1')?.task, 'refactoring auth');

// ── Partial status updates ──
mesh.setStatus('a1', { progress: 40 });
eq('progress applied', mesh.getStatus('a1')?.progress, 40);
eq('task survives partial update', mesh.getStatus('a1')?.task, 'refactoring auth');
mesh.setStatus('a1', { progress: 999 });
eq('progress clamped', mesh.getStatus('a1')?.progress, 100);
eq('unknown agent returns null', mesh.setStatus('nope', { phase: 'done' }), null);

// ── File conflicts — the main reason shared awareness exists ──
mesh.setStatus('a1', { phase: 'working', task: 'auth', files: ['src/auth.ts', 'src/db.ts'] });
mesh.setStatus('a2', { phase: 'working', task: 'login', files: ['src/auth.ts'] });
mesh.setStatus('a3', { phase: 'working', task: 'docs', files: ['README.md'] });

const conflicts = mesh.fileConflicts();
eq('one conflicting file', conflicts.length, 1);
eq('conflict is auth.ts', conflicts[0].file, 'src/auth.ts');
eq('two agents in conflict', conflicts[0].agents.length, 2);

// Windows and POSIX spellings of one path are the same file.
mesh.setStatus('a3', { files: ['src\\auth.ts'] });
ok('separator-insensitive', mesh.fileConflicts()[0].agents.length === 3);

// An idle agent is not "touching" anything.
mesh.setStatus('a3', { phase: 'idle' });
ok('idle agents excluded from conflicts', mesh.fileConflicts()[0].agents.length === 2);

// ── Messaging ──
const m1 = mesh.send({
  from: 'a1', fromName: 'Max - Claude Code', to: 'a2', toName: 'Sky - Codex',
  subject: 'auth.ts', body: 'I am mid-refactor, hold off', kind: 'note',
});
ok('message got an id', !!m1.id);

const skyInbox = mesh.inbox('a2');
eq('sky received it', skyInbox.length, 1);
eq('zed did not', mesh.inbox('a3').length, 0);
eq('sender does not receive own', mesh.inbox('a1').length, 0);

// Broadcasts reach everyone but the sender.
mesh.send({ from: 'a1', fromName: 'Max', to: null, subject: 'build green', body: 'ok', kind: 'note' });
eq('broadcast to sky', mesh.inbox('a2', { unreadOnly: false }).length, 2);
eq('broadcast to zed', mesh.inbox('a3', { unreadOnly: false }).length, 1);
eq('broadcast not to sender', mesh.inbox('a1', { unreadOnly: false }).length, 0);

// Read tracking.
eq('two unread for sky', mesh.inbox('a2', { unreadOnly: true }).length, 2);
mesh.markRead('a2');
eq('none unread after read', mesh.inbox('a2', { unreadOnly: true }).length, 0);
eq('still visible when not filtering', mesh.inbox('a2', { unreadOnly: false }).length, 2);

// ── Digest (what the flip view renders) ──
const digest = mesh.digest();
eq('digest covers every agent', digest.length, 3);
const max = digest.find((d) => d.agentId === 'a1')!;
eq('digest carries task', max.task, 'auth');
ok('digest reports conflicts', max.conflicts.includes('src/auth.ts'));
ok('digest has elapsed time', max.elapsedMs >= 0);
// An idle agent keeps its LAST task, which is useful context ("idle,
// last worked on docs"). Only an agent that never reported anything gets
// the placeholder.
const zed = digest.find((d) => d.agentId === 'a3')!;
eq('idle agent keeps last task', zed.task, 'docs');

mesh.register('a4', 'Nova - Codex', 'codex');
const nova = mesh.digest().find((d) => d.agentId === 'a4')!;
eq('never-reported agent gets placeholder', nova.task, 'Waiting for work');
mesh.unregister('a4');

// ── Observers fire ──
let statusEvents = 0, messageEvents = 0;
mesh.onStatusChange = () => { statusEvents++; };
mesh.onMessage = () => { messageEvents++; };
mesh.setStatus('a1', { phase: 'done' });
mesh.send({ from: 'a2', fromName: 'Sky', to: 'a1', subject: 'ok', body: 'thanks', kind: 'answer' });
eq('status observer fired', statusEvents, 1);
eq('message observer fired', messageEvents, 1);

// ── Unregister ──
mesh.unregister('a3');
eq('agent removed', mesh.allStatuses().length, 2);

console.log(`\nagent-mesh pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
