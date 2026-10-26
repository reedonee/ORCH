// ── MCP Agent Config Injection ────────────────────────────────
//
// Agents are told about ORCH's MCP server per launch, never through a
// config that outlives the run:
//
//   - The endpoint changes every run. The port is ephemeral and the
//     bearer token is regenerated at boot, so anything written into a
//     user's global config is stale the moment ORCH restarts — and
//     leaves a dead server erroring in their CLI when they use it
//     outside ORCH.
//   - It leaves the user's own MCP servers and settings untouched.
//
// Every launch also carries the agent's IDENTITY, as `?agent=<id>` on the
// URL (every client passes a URL through untouched) and, where the
// client supports headers, as X-Orch-Agent-Id. Without it every tool had
// to ask the model for a `sourceAgentId` it had no way to know: a real
// Claude Code session guessed its display name, called the wrong tool,
// and concluded ORCH "had no agent called ORCH".
//
// Per provider:
//   claude-code  --mcp-config <inline JSON>            (verified, 2.1.310)
//   codex        -c mcp_servers.orch.* overrides        (verified, 0.149)
//   opencode     OPENCODE_CONFIG_CONTENT env, merged    (per opencode.ai docs)
//   hermes       one stable config.yaml entry whose values are ${ENV}
//                placeholders, resolved per launch      (verified, 0.21)
//
// See tests/mcp-agent-config.check.mts.

/** Providers configured once per ORCH run via their own CLI, before the
 *  first spawn. Hermes has no per-launch flag or config path. */
export const CLI_REGISTERED_PROVIDERS = ['hermes'];

/** The streamable endpoint for one agent: identity rides in the query. */
export function agentMcpUrl(streamUrl: string, agentId: string): string {
  if (!streamUrl) return '';
  if (!agentId) return streamUrl;
  return `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}agent=${encodeURIComponent(agentId)}`;
}

/**
 * Extra CLI arguments that point a provider at the ORCH MCP server.
 *
 * `streamUrl` must be the Streamable HTTP endpoint with NO token in it —
 * the credential travels separately, as a header or an env var, so it
 * never lands in a process listing (Claude Code is the exception: its
 * only per-launch channel is the inline JSON).
 *
 * Returns [] for providers configured another way.
 */
export function mcpLaunchArgs(providerId: string, streamUrl: string, token: string, agentId = ''): string[] {
  if (!streamUrl) return [];
  const url = agentMcpUrl(streamUrl, agentId);

  switch (providerId) {
    case 'claude-code':
      // --mcp-config takes inline JSON and merges with the user's own
      // servers. NOT --strict-mcp-config, which would disable theirs.
      return ['--mcp-config', JSON.stringify({
        mcpServers: {
          orch: {
            type: 'http',
            url,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(agentId ? { 'X-Orch-Agent-Id': agentId } : {}),
            },
          },
        },
      })];

    case 'codex':
      // `-c` overrides one dotted config key, parsed as TOML — the same
      // shape `codex mcp add --url` writes into config.toml, minus the
      // global side effect.
      return [
        // Codex speaks Streamable HTTP only. Serving just /sse is why it
        // connected to nothing and reported having no canvas tools.
        '-c', `mcp_servers.orch.url="${url}"`,
        // Read from the environment rather than written to config.toml,
        // so no credential is persisted to disk.
        '-c', 'mcp_servers.orch.bearer_token_env_var="ORCH_MCP_TOKEN"',
        // Without this Codex discovers the tools and then refuses every
        // call with "MCP tool call requires approval, but approval policy
        // is never" — which reads to the model as not having the tool.
        // Scoped to this one server: it does not touch Codex's approval
        // policy for shell commands or file writes.
        '-c', 'mcp_servers.orch.default_tools_approval_mode="approve"',
      ];

    default:
      return [];
  }
}

/**
 * Environment that points a provider at ORCH, for providers configured
 * through the environment.
 *
 * OpenCode merges OPENCODE_CONFIG_CONTENT over the user's own config, so
 * this adds one server for this process only. It replaces `opencode mcp
 * add`, which wrote a soon-stale URL into the user's global config.
 */
export function mcpLaunchEnv(providerId: string, streamUrl: string, token: string, agentId = ''): Record<string, string> {
  if (!streamUrl) return {};
  const url = agentMcpUrl(streamUrl, agentId);
  // Every agent gets its own URL, so tools in the agent's own shell (and
  // Hermes, whose config reads ${ORCH_MCP_HTTP_URL}) carry its identity.
  const env: Record<string, string> = { ORCH_MCP_HTTP_URL: url };
  if (providerId === 'opencode') {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        orch: {
          type: 'remote',
          url,
          enabled: true,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(agentId ? { 'X-Orch-Agent-Id': agentId } : {}),
          },
        },
      },
    });
  }
  return env;
}

/**
 * The Hermes `mcp_servers.orch` entry. Every value is an ${ENV}
 * placeholder Hermes resolves at launch from the variables ORCH sets on
 * each agent, so the entry holds no port, no token and no agent id: it
 * can never go stale, and nothing secret is written to disk.
 *
 * Replaces `hermes mcp add`, which is interactive (it blocks on a tool
 * picker even with stdin closed) and so never registered anything.
 */
export const HERMES_ORCH_ENTRY = {
  url: '${ORCH_MCP_HTTP_URL}',
  headers: {
    Authorization: 'Bearer ${ORCH_MCP_TOKEN}',
    'X-Orch-Agent-Id': '${ORCH_AGENT_ID}',
  },
  connect_timeout: 10,
  timeout: 120,
};
