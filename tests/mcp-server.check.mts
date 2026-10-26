// End-to-end checks of ORCH's MCP server, driven by the real MCP SDK
// client over Streamable HTTP — the same path Claude Code, Codex, Hermes
// and OpenCode take.
//
// This exists because "connected" was never the problem. A real Claude
// Code session had all 33 tools and still could not use them: every tool
// demanded a sourceAgentId it had no way to know (it guessed its display
// name), nothing told it what ORCH was, and it tried to message an agent
// called "ORCH" that did not exist. These checks pin the fixes:
// identity from the connection, instructions, name resolution, errors
// that say what to do, controller routing, and real-time sync.
//
// Run: node --experimental-strip-types --import ./tests/ts-resolve-hook.mjs tests/mcp-server.check.mts

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { OrchMcpServer, TOOLS } from '../electron/mcp-server.ts';
import { SyncJournal, resolveAgentRef, identityFromRequest } from '../electron/mcp-sync.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: unknown, detail?: unknown) => {
  if (cond) pass++;
  else { fail++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const textOf = (r: any): string => (r.content ?? []).map((c: any) => c.text ?? '').join('\n');

// ── Pure pieces ─────────────────────────────────────────────────
{
  const agents = [
    { agentId: 'a-max', name: 'Max - Claude Code' },
    { agentId: 'a-sky', name: 'Sky - Codex' },
    { agentId: 'a-sam', name: 'Sam - Hermes' },
  ];
  const r = (q: string, me?: string) => {
    const x = resolveAgentRef(q, agents, me);
    return x.kind === 'agent' ? x.agent.agentId : x.kind;
  };
  ok('ref: exact id', r('a-sky') === 'a-sky');
  ok('ref: full name, any case', r('max - claude code') === 'a-max');
  ok('ref: short name', r('Sky') === 'a-sky');
  ok('ref: @mention', r('@sky') === 'a-sky');
  ok('ref: "me" is the caller', r('me', 'a-sam') === 'a-sam');
  ok('ref: "orch" is ORCH itself', r('ORCH') === 'orch');
  ok('ref: "controller" is ORCH itself', r('controller') === 'orch');
  ok('ref: ambiguous prefix is refused, not guessed', r('s') === 'unknown' && r('sa') === 'a-sam');
  ok('ref: unknown', r('zed') === 'unknown');

  const u = new URL('http://x/mcp?agent=a-max');
  ok('identity from query', identityFromRequest({}, u) === 'a-max');
  ok('identity: header wins', identityFromRequest({ 'x-orch-agent-id': 'a-sky' }, u) === 'a-sky');
  ok('identity: unresolved ${placeholder} is ignored',
    identityFromRequest({ 'x-orch-agent-id': '${ORCH_AGENT_ID}' }, new URL('http://x/mcp')) === undefined);

  const j = new SyncJournal(5);
  for (let i = 0; i < 8; i++) j.append({ type: 't', summary: `e${i}` });
  const b = j.since(1);
  ok('journal keeps the newest', b.events.length === 5 && b.events[0].summary === 'e3');
  ok('journal reports a gap after overflow', b.missed === true);
  ok('journal: no gap from the head', j.since(j.cursor).missed === false && j.since(j.cursor).events.length === 0);
}

// ── Schema conventions ──────────────────────────────────────────
{
  const requiresSelf = TOOLS.filter((t) => (t.inputSchema.required ?? []).some((f) => f === 'sourceAgentId' || f === 'claimantAgentId'));
  ok('no tool requires the caller to know its own id', requiresSelf.length === 0, requiresSelf.map((t) => t.name));
  for (const n of ['orch_whoami', 'orch_snapshot', 'orch_wait_for_events']) ok(`tool ${n} exists`, TOOLS.some((t) => t.name === n));
  ok('every tool carries annotations', TOOLS.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
  ok('remove is marked destructive', TOOLS.find((t) => t.name === 'canvas_remove_agent')?.annotations?.destructiveHint === true);
}

// ── Live server ─────────────────────────────────────────────────
const server = new OrchMcpServer(new Map());
const typed: Array<{ id: string; text: string }> = [];
const userMessages: string[] = [];
const connections: string[] = [];
server.sendToAgent = async (id, t) => { typed.push({ id, text: t }); return { ok: true }; };
server.readAgentOutput = async () => 'line one\nline two';
server.onUserMessage = (m) => { userMessages.push(m.subject); };
server.onAgentConnection = (id, info) => { connections.push(`${id}:${info.connected}`); };
server.getAgentRuntime = () => [
  { agentId: 'a-max', name: 'Max - Claude Code', providerId: 'claude-code', terminal: 'running', idleMs: 1000, approval: null },
  { agentId: 'a-sky', name: 'Sky - Codex', providerId: 'codex', terminal: 'running', idleMs: 2000,
    approval: { kind: 'tool', detail: 'npm test' } },
];
server.mesh.register('a-max', 'Max - Claude Code', 'claude-code');
server.mesh.register('a-sky', 'Sky - Codex', 'codex');
await server.start();
const base = server.streamUrlNoToken;

async function connect(agent: string | null, opts: { header?: boolean } = {}) {
  const url = new URL(agent ? `${base}?agent=${agent}` : base);
  const headers: Record<string, string> = { Authorization: `Bearer ${server.token}` };
  if (agent && opts.header) headers['X-Orch-Agent-Id'] = agent;
  const client = new Client({ name: `check-${agent ?? 'anon'}`, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });

try {
  // ── Auth ───────────────────────────────────────────────────
  {
    const health = await (await fetch(base.replace('/mcp', '/health'))).json();
    ok('health names the server', health.name === 'orch-mcp' && health.status === 'ok');
    const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    const body = await res.json().catch(() => null);
    ok('no token → 401 with a reason', res.status === 401 && /token/i.test(body?.error?.message ?? ''), body);
    const stale = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${server.token}`, 'Mcp-Session-Id': 'gone' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    ok('unknown session → 404 (client re-initialises)', stale.status === 404);
  }

  // ── Identity and instructions ───────────────────────────────
  const max = await connect('a-max', { header: true });
  const sky = await connect('a-sky');          // query only, as Codex sends it
  const instructions = max.getInstructions() ?? '';
  ok('instructions name the agent and its id', instructions.includes('"Max - Claude Code"') && instructions.includes('a-max'), instructions.slice(0, 200));
  ok('instructions explain what ORCH is', /shared canvas/.test(instructions));
  ok('instructions say how to reach ORCH', instructions.includes('to: "orch"'));
  ok('connections are journalled', connections.includes('a-max:true') && connections.includes('a-sky:true'), connections);

  const who = textOf(await call(max, 'orch_whoami'));
  ok('whoami: identity', who.includes('You are Max - Claude Code') && who.includes('a-max'), who);

  // ── The exact failure from the real Claude Code run ─────────
  const st = await call(max, 'agent_set_status', { phase: 'working', task: 'probe task' });
  ok('set_status works with no id at all', !st.isError && server.mesh.getStatus('a-max')?.phase === 'working', textOf(st));
  await call(max, 'agent_set_status', { sourceAgentId: 'Probe - Claude Code', phase: 'working', task: 'guessed id' });
  ok('a guessed id cannot misdirect the call', server.mesh.getStatus('a-max')?.task === 'guessed id');
  await call(max, 'agent_set_status', { sourceAgentId: 'a-sky', phase: 'failed', task: 'impersonated' });
  ok('a connection cannot act as another agent', server.mesh.getStatus('a-sky')?.phase !== 'failed');

  const toOrch = await call(max, 'agent_send', { to: 'ORCH', subject: 'Now working on probe task', body: 'hello' });
  ok('to: "ORCH" reaches the user when there is no controller', !toOrch.isError && userMessages.includes('Now working on probe task'), textOf(toOrch));

  const byName = await call(max, 'agent_send', { to: 'sky', subject: 'hi', body: 'b' });
  ok('agent_send by short name', !byName.isError && server.mesh.inbox('a-sky').length === 1, textOf(byName));

  // ── Errors that say what to do ──────────────────────────────
  const nobody = await call(max, 'canvas_send_message', { agentId: 'zed', message: 'x' });
  ok('unknown agent → error listing real agents', nobody.isError && textOf(nobody).includes('Sky - Codex (id a-sky)'), textOf(nobody));
  const missing = await call(max, 'agent_send', { to: 'sky', subject: 's' });
  ok('missing argument is named', missing.isError && textOf(missing).includes('Missing required argument "body"'), textOf(missing));
  const unknownTool = await call(max, 'agent_status', {});
  ok('unknown tool suggests the right one', unknownTool.isError && textOf(unknownTool).includes('agent_set_status'), textOf(unknownTool));
  const self = await call(max, 'canvas_send_message', { agentId: 'me', message: 'x' });
  ok('typing into yourself is refused', self.isError);

  const sent = await call(max, 'canvas_send_message', { agentId: 'Sky', message: 'run the tests' });
  ok('canvas_send_message resolves the name', !sent.isError && typed.at(-1)?.id === 'a-sky');
  const out = await call(max, 'canvas_read_output', { agentId: 'sky', lines: '5' });
  ok('string numbers are coerced', !out.isError && textOf(out).includes('line two'));

  // ── Snapshot ────────────────────────────────────────────────
  const snap = textOf(await call(max, 'orch_snapshot'));
  ok('snapshot lists ids', snap.includes('a-sky') && snap.includes('a-max'));
  ok('snapshot marks the caller', snap.includes('Max - Claude Code (you)'));
  ok('snapshot shows approvals waiting on the user', snap.includes('Waiting for the user') && snap.includes('npm test'));
  ok('snapshot shows who is connected', /\| a-sky \| codex \|[^\n]*\| yes \|/.test(snap), snap);
  ok('snapshot hands out a cursor', /orch_wait_for_events \{ "cursor": \d+ \}/.test(snap));

  // ── Controller routing and the sync footer ──────────────────
  server.setController('a-max');
  const report = await call(sky, 'agent_send', { to: 'orch', subject: 'tests pass', body: 'all green' });
  ok('to: "orch" reaches the controller once there is one', !report.isError && server.mesh.inbox('a-max', { unreadOnly: true }).some((m) => m.subject === 'tests pass'), textOf(report));
  const roster = textOf(await call(max, 'agent_roster'));
  ok('footer tells the controller its new role', roster.includes('the user made you the CONTROLLER'), roster);
  ok('footer reports unread messages', roster.includes('unread message'), roster);
  ok('footer carries what changed', roster.includes('Since your last ORCH call') && roster.includes('tests pass'), roster);
  const again = textOf(await call(max, 'agent_roster'));
  ok('footer does not repeat events already shown', !again.includes('tests pass'), again);
  const skyRoster = textOf(await call(sky, 'agent_roster'));
  ok('workers do not get the controller event feed', !skyRoster.includes('Since your last ORCH call'), skyRoster);

  // ── Real time: long-poll wakes on the event, not on the timeout ─
  {
    const cursor = server.journal.cursor;
    const t0 = Date.now();
    const waiting = call(max, 'orch_wait_for_events', { cursor, timeoutSeconds: 20 });
    setTimeout(() => { void call(sky, 'agent_set_status', { phase: 'done', task: 'tests' }); }, 300);
    const r = textOf(await waiting);
    const ms = Date.now() - t0;
    ok(`wait_for_events returns on the event (${ms}ms)`, ms < 3000 && r.includes('Sky - Codex finished'), r);
    const next = Number(/cursor: (\d+)/.exec(r)?.[1]);
    ok('wait_for_events returns the next cursor', next > cursor);
    ok('what the controller saw is tracked (no duplicate nudges)', server.seenCursor('a-max') >= next, server.seenCursor('a-max'));
    const quiet = textOf(await call(max, 'orch_wait_for_events', { cursor: next, timeoutSeconds: 1 }));
    ok('nothing new → empty result at the timeout', quiet.includes('No changes'), quiet);
    server.recordApproval('a-sky', { kind: 'tool', detail: 'rm -rf build' });
    const filtered = textOf(await call(max, 'orch_wait_for_events', { cursor: next, types: ['approval_pending'], timeoutSeconds: 1 }));
    ok('wait_for_events filters by type', filtered.includes('approve: rm -rf build') && !filtered.includes('finished'), filtered);
  }

  // ── Real time: resource subscriptions push ──────────────────
  {
    let pushed = '';
    max.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { pushed = n.params.uri; });
    await max.subscribeResource({ uri: 'orch://events' });
    const read = await max.readResource({ uri: 'orch://events' });
    ok('orch://events is readable', JSON.stringify(read).includes('cursor'));
    await call(sky, 'agent_set_status', { phase: 'blocked', task: 'need review' });
    const t0 = Date.now();
    while (!pushed && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    ok('subscribed client is pushed resources/updated', pushed === 'orch://events', pushed);
  }

  // ── Unlinked clients still work ─────────────────────────────
  {
    const anon = await connect(null);
    ok('unlinked instructions say so', /not linked/.test(anon.getInstructions() ?? ''));
    const r = await call(anon, 'agent_set_status', { sourceAgentId: 'Max', phase: 'idle' });
    ok('unlinked caller may name itself by agent name', !r.isError && server.mesh.getStatus('a-max')?.phase === 'idle', textOf(r));
    await anon.close();
  }

  // A client that ends its session properly (DELETE) is disconnected.
  await (sky.transport as StreamableHTTPClientTransport).terminateSession();
  await sky.close();
  await new Promise((r) => setTimeout(r, 200));
  ok('a terminated session is journalled as disconnected', connections.includes('a-sky:false'), connections);
  // A CLI that just exits sends no DELETE; its terminal exiting is the signal.
  server.recordAgentExit('a-max', 0);
  ok('an agent whose terminal exits is disconnected', connections.includes('a-max:false'), connections);
  const tail = server.journal.since(server.journal.cursor - 3).events.map((e) => e.type);
  ok('exit and disconnect are both journalled', tail.includes('agent_exited') && tail.includes('mcp_disconnected'), tail);
  await max.close();
} catch (err) {
  fail++;
  console.log('FAIL threw:', err);
} finally {
  await server.stop();
}

console.log(`\nmcp-server pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
