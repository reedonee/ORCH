// Checks for the CLI flags that point a spawned agent at ORCH's MCP
// server.
//
// Every assertion here corresponds to something verified against the
// real binary (codex 0.149.1, claude 2.x) while fixing the bug where
// Codex reported it "can't access the image-generation/canvas tool":
//
//   - Codex was not handled at all — no config, no registration.
//   - Codex speaks Streamable HTTP; ORCH served only legacy /sse.
//   - With the URL alone, Codex discovered the tools and then refused
//     every call: "MCP tool call requires approval, but approval policy
//     is never". `default_tools_approval_mode="approve"` is what makes
//     the call go through, and "approve" is one of exactly four values
//     Codex accepts (auto | prompt | approve | writes).
//
// These flags are load-bearing and silently degrade — a wrong one leaves
// the agent looking like it simply has no tools.

import {
  mcpLaunchArgs, mcpLaunchEnv, agentMcpUrl, CLI_REGISTERED_PROVIDERS, HERMES_ORCH_ENTRY,
} from '../electron/mcp-agent-config.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) pass++;
  else { fail++; console.log(`FAIL ${l}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const ok = (l: string, c: boolean, detail?: string) => {
  if (c) pass++; else { fail++; console.log(`FAIL ${l}${detail ? `\n  ${detail}` : ''}`); }
};

const URL_ = 'http://127.0.0.1:54321/mcp';
const TOKEN = 'abc123def456';

// ── Codex ───────────────────────────────────────────────────────
{
  const args = mcpLaunchArgs('codex', URL_, TOKEN);
  ok('codex gets configured at all', args.length > 0);

  // Codex parses each -c value as TOML, so the URL must be quoted.
  const pairs: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    eq('codex config flags come in -c pairs', args[i], '-c');
    const [k, ...rest] = args[i + 1].split('=');
    pairs[k] = rest.join('=');
  }

  eq('points at the streamable endpoint', pairs['mcp_servers.orch.url'], `"${URL_}"`);
  ok('the URL is a TOML string, not bare',
    pairs['mcp_servers.orch.url'].startsWith('"') && pairs['mcp_servers.orch.url'].endsWith('"'));

  eq('reads the token from the environment',
    pairs['mcp_servers.orch.bearer_token_env_var'], '"ORCH_MCP_TOKEN"');

  // The one that turns "I can't access that tool" into a working call.
  eq('auto-approves this server’s tools',
    pairs['mcp_servers.orch.default_tools_approval_mode'], '"approve"');

  ok('approval mode is one codex actually accepts',
    ['"auto"', '"prompt"', '"approve"', '"writes"']
      .includes(pairs['mcp_servers.orch.default_tools_approval_mode']));

  // The credential must not be visible in a process listing.
  ok('no token appears in codex argv', !args.some((a) => a.includes(TOKEN)),
    args.join(' '));

  // Scoped to this server only — never a global approval override.
  ok('does not touch the global approval policy',
    !args.some((a) => /^approval_policy=/.test(a) || a === '--dangerously-bypass-approvals-and-sandbox'));
  ok('does not touch the sandbox', !args.some((a) => a.includes('sandbox')));
}

// ── Claude Code ─────────────────────────────────────────────────
{
  const args = mcpLaunchArgs('claude-code', URL_, TOKEN);
  eq('uses --mcp-config', args[0], '--mcp-config');
  eq('passes exactly one JSON payload', args.length, 2);

  const cfg = JSON.parse(args[1]);
  eq('registers under the name orch', Object.keys(cfg.mcpServers).join(','), 'orch');
  eq('declares the http transport', cfg.mcpServers.orch.type, 'http');
  eq('points at the streamable endpoint', cfg.mcpServers.orch.url, URL_);
  eq('authenticates with a bearer header',
    cfg.mcpServers.orch.headers.Authorization, `Bearer ${TOKEN}`);
  ok('the URL carries no query token', !cfg.mcpServers.orch.url.includes('token='));

  // --strict-mcp-config would disable every MCP server the user
  // configured themselves.
  ok('does not suppress the user’s own MCP servers',
    !args.includes('--strict-mcp-config'));
}

// ── Identity ────────────────────────────────────────────────────
// Every launch carries the agent's id, so the server knows who is
// calling and no tool has to ask the model for an id it cannot know.
{
  const AGENT = 'agent-1234';
  eq('identity rides in the query', agentMcpUrl(URL_, AGENT), `${URL_}?agent=${AGENT}`);
  eq('ids are URL-encoded', agentMcpUrl(URL_, 'a b&c'), `${URL_}?agent=a%20b%26c`);
  eq('no id, plain URL', agentMcpUrl(URL_, ''), URL_);

  const codex = mcpLaunchArgs('codex', URL_, TOKEN, AGENT);
  ok('codex URL carries the agent id', codex.includes(`mcp_servers.orch.url="${URL_}?agent=${AGENT}"`), codex.join(' '));

  const claude = JSON.parse(mcpLaunchArgs('claude-code', URL_, TOKEN, AGENT)[1]).mcpServers.orch;
  eq('claude URL carries the agent id', claude.url, `${URL_}?agent=${AGENT}`);
  eq('claude also sends it as a header', claude.headers['X-Orch-Agent-Id'], AGENT);
}

// ── OpenCode: inline config through the environment ─────────────
// Replaces `opencode mcp add`, which wrote a stale URL into the user's
// global config (and failed when opencode was not on PATH).
{
  const AGENT = 'agent-oc';
  eq('opencode takes no launch args', mcpLaunchArgs('opencode', URL_, TOKEN, AGENT).length, 0);
  const env = mcpLaunchEnv('opencode', URL_, TOKEN, AGENT);
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  eq('opencode: remote server named orch', cfg.mcp.orch.type, 'remote');
  eq('opencode: per-agent URL', cfg.mcp.orch.url, `${URL_}?agent=${AGENT}`);
  eq('opencode: enabled', cfg.mcp.orch.enabled, true);
  eq('opencode: bearer header', cfg.mcp.orch.headers.Authorization, `Bearer ${TOKEN}`);
  ok('opencode config only adds a server', Object.keys(cfg).every((k) => k === 'mcp' || k === '$schema'));
  ok('opencode is not CLI-registered any more', !CLI_REGISTERED_PROVIDERS.includes('opencode'));
  eq('every agent gets its own HTTP URL', mcpLaunchEnv('codex', URL_, TOKEN, 'x').ORCH_MCP_HTTP_URL, `${URL_}?agent=x`);
  eq('only opencode gets inline config', mcpLaunchEnv('codex', URL_, TOKEN, 'x').OPENCODE_CONFIG_CONTENT, undefined);
}

// ── Hermes: one stable entry of ${ENV} placeholders ──────────────
// `hermes mcp add` is interactive and never registered anything. The
// entry written instead must hold nothing that changes between runs.
{
  ok('hermes is configured once via its CLI', CLI_REGISTERED_PROVIDERS.includes('hermes'));
  eq('hermes takes no launch args', mcpLaunchArgs('hermes', URL_, TOKEN, 'x').length, 0);
  const flat = JSON.stringify(HERMES_ORCH_ENTRY);
  eq('hermes URL comes from the agent env', HERMES_ORCH_ENTRY.url, '${ORCH_MCP_HTTP_URL}');
  eq('hermes token comes from the env', HERMES_ORCH_ENTRY.headers.Authorization, 'Bearer ${ORCH_MCP_TOKEN}');
  eq('hermes identity comes from the env', HERMES_ORCH_ENTRY.headers['X-Orch-Agent-Id'], '${ORCH_AGENT_ID}');
  ok('hermes entry holds no port or token', !/127\.0\.0\.1|:\d{4,5}\/|[a-f0-9]{32}/.test(flat), flat);
  ok('codex is NOT in the CLI-registration list', !CLI_REGISTERED_PROVIDERS.includes('codex'));
  ok('claude-code is NOT in the CLI-registration list', !CLI_REGISTERED_PROVIDERS.includes('claude-code'));
  eq('an unknown provider takes no launch args', mcpLaunchArgs('cursor', URL_, TOKEN).length, 0);
}

// ── No server, no flags ─────────────────────────────────────────
{
  // If the MCP server failed to start, an agent must launch cleanly
  // rather than pointing at an empty URL and erroring on every call.
  eq('codex gets nothing without a URL', mcpLaunchArgs('codex', '', TOKEN).length, 0);
  eq('claude-code gets nothing without a URL', mcpLaunchArgs('claude-code', '', TOKEN).length, 0);
  eq('no env without a URL', Object.keys(mcpLaunchEnv('opencode', '', TOKEN, 'x')).length, 0);
}

console.log(`\nmcp-agent-config pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
