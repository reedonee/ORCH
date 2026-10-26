// End-to-end check against a RUNNING ORCH: does the MCP endpoint that
// agent CLIs are pointed at actually speak MCP?
//
// This exists because the failure was invisible from inside the app. The
// server started, logged a URL, and served /sse — but Codex speaks only
// Streamable HTTP, so it connected to nothing and reported having no
// canvas tools. Nothing in the app surfaced that.
//
// Usage:  node tests/mcp-endpoint.check.mjs "<url-with-token>"
// With no argument it reads the URL from the dev log.

import fs from 'node:fs';

const PROTOCOL_VERSION = '2025-06-18';

function urlFromArgs() {
  const arg = process.argv[2];
  if (arg) return arg;
  const log = process.argv[3];
  if (log && fs.existsSync(log)) {
    const text = fs.readFileSync(log, 'utf-8');
    const m = [...text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/sse\?token=([a-f0-9]+)/g)].pop();
    if (m) return `http://127.0.0.1:${m[1]}/mcp?token=${m[2]}`;
  }
  return null;
}

const base = urlFromArgs();
if (!base) {
  console.log('SKIP mcp-endpoint: no URL given and none found in the log');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

let sessionId = null;

/** One JSON-RPC call over Streamable HTTP. */
async function rpc(method, params, id) {
  const headers = {
    'Content-Type': 'application/json',
    // Streamable HTTP requires the client to accept both.
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify(id === undefined
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id, method, params }),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  const text = await res.text();
  if (!text) return { status: res.status, body: null };

  // A streamed response arrives as SSE frames; take the last data line.
  if (text.startsWith('event:') || text.includes('\ndata: ')) {
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    const last = lines[lines.length - 1];
    return { status: res.status, body: last ? JSON.parse(last.slice(6)) : null };
  }
  return { status: res.status, body: JSON.parse(text) };
}

console.log(`mcp-endpoint: ${base.replace(/token=[a-f0-9]+/, 'token=***')}`);

// ── Auth ────────────────────────────────────────────────────────
{
  const bad = base.replace(/token=[a-f0-9]+/, 'token=deadbeef');
  const res = await fetch(bad, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
  });
  ok('a wrong token is rejected', res.status === 401, `got HTTP ${res.status}`);
}
{
  // A browser probing localhost must not get in, whatever token it has.
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
  });
  ok('a request carrying an Origin is refused', res.status === 403, `got HTTP ${res.status}`);
}

{
  // Claude Code authenticates with an Authorization header rather than a
  // query token (--mcp-config carries `headers`), so both must work.
  const noToken = base.replace(/\?token=[a-f0-9]+/, '');
  const token = base.match(/token=([a-f0-9]+)/)?.[1] ?? '';
  const res = await fetch(noToken, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {},
                clientInfo: { name: 'header-auth-check', version: '1.0.0' } },
    }),
  });
  ok('a bearer header authenticates without a query token', res.status === 200,
     `got HTTP ${res.status}`);
}

// ── Handshake ───────────────────────────────────────────────────
const init = await rpc('initialize', {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'orch-endpoint-check', version: '1.0.0' },
}, 1);

ok('initialize succeeds', init.status === 200 && !!init.body?.result,
   `HTTP ${init.status} ${JSON.stringify(init.body)?.slice(0, 200)}`);
ok('server mints a session id', !!sessionId, 'no Mcp-Session-Id header');
ok('server identifies itself', !!init.body?.result?.serverInfo?.name,
   JSON.stringify(init.body?.result?.serverInfo));

await rpc('notifications/initialized', {});

// ── Tools ───────────────────────────────────────────────────────
const list = await rpc('tools/list', {}, 2);
const tools = list.body?.result?.tools ?? [];
ok('tools/list returns tools', tools.length > 0, `got ${tools.length}`);

// The tools the screenshot said Codex could not reach.
const names = new Set(tools.map((t) => t.name));
for (const required of [
  'canvas_add_file', 'canvas_add_note', 'app_action', 'list_app_actions',
  'agent_set_status', 'agent_roster', 'agent_send', 'agent_inbox',
]) {
  ok(`exposes ${required}`, names.has(required));
}

// Descriptions are the only channel that reaches a model's context, so
// an undescribed tool is effectively invisible.
const undescribed = tools.filter((t) => !t.description || t.description.length < 20);
ok('every tool carries a real description', undescribed.length === 0,
   undescribed.map((t) => t.name).join(', '));

// ── A read-only call ────────────────────────────────────────────
const call = await rpc('tools/call', { name: 'list_app_actions', arguments: {} }, 3);
ok('tools/call round-trips', !!call.body?.result && !call.body?.error,
   JSON.stringify(call.body)?.slice(0, 200));

// ── Session handling ────────────────────────────────────────────
{
  const saved = sessionId;
  sessionId = '00000000-0000-0000-0000-000000000000';
  const res = await rpc('tools/list', {}, 4);
  ok('an unknown session id is rejected, not silently accepted', res.status === 404,
     `got HTTP ${res.status}`);
  sessionId = saved;
}

console.log(`\nmcp-endpoint pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
