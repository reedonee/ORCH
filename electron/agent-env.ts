// ── Agent environment ───────────────────────────────────────────
// What an agent inherits from the process that launched ORCH.
//
// Agents get ORCH's environment, and ORCH gets whatever launched it. Two
// things in that chain broke agents in practice:
//
//   NO_COLOR    A shell or tool that sets it (some automation shells do,
//               to keep their own logs plain) turned every agent on the
//               canvas into white-on-glass text: Claude Code honours it
//               and emits no colour at all. ORCH is a colour terminal
//               canvas, so an inherited NO_COLOR is never what the agents
//               should see. A provider's own env can still set it.
//
//   CLAUDECODE  When ORCH is started from inside a Claude Code session,
//   CLAUDE_*    that session's markers leak into every agent. Each Claude
//               agent then believed it was a nested child of that session
//               ("Transcript saving is off — inherited
//               CLAUDE_CODE_CHILD_SESSION marker") and received its
//               session id and messaging token. Those are stripped; the
//               CLAUDE_CODE_* variables a user sets as configuration are
//               kept.
//
// Pure: tests/agent-env.check.mts drives it directly.

/** CLAUDE_CODE_* variables that are user configuration, not session state. */
const CLAUDE_CONFIG_VARS = new Set([
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_SHELL', 'CLAUDE_CODE_SHELL_PREFIX', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL',
]);

/** Markers of an enclosing Claude Code / Agent SDK session. */
function isParentSessionVar(name: string): boolean {
  if (name === 'CLAUDECODE' || name === 'CLAUDE_PID' || name === 'AI_AGENT' || name === 'CLAUDE_EFFORT') return true;
  if (name.startsWith('CLAUDE_AGENT_SDK_') || name.startsWith('CLAUDE_PREVIEW_')) return true;
  return name.startsWith('CLAUDE_CODE_') && !CLAUDE_CONFIG_VARS.has(name);
}

/**
 * The environment ORCH passes on to an agent, before its own additions
 * (provider env, ORCH_* identity, MCP settings), which are layered on top
 * and so can still set anything removed here.
 */
export function inheritedAgentEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  // Only an enclosing session sets CLAUDECODE=1; without it, CLAUDE_CODE_*
  // variables are the user's own and are left alone.
  const insideClaudeSession = parent.CLAUDECODE === '1';
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (k.toUpperCase() === 'NO_COLOR') continue;
    if (insideClaudeSession && isParentSessionVar(k)) continue;
    env[k] = v;
  }
  return env;
}
