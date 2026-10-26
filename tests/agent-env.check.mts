// What an agent inherits from whatever launched ORCH (electron/agent-env.ts).
//
// Found in the field: ORCH started from a shell that had NO_COLOR=1 made
// every Claude Code agent on the canvas render plain white text, and ORCH
// started from inside a Claude Code session made every agent think it was
// that session's child ("inherited CLAUDE_CODE_CHILD_SESSION marker").

import { inheritedAgentEnv } from '../electron/agent-env.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else { fail++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`); }
};

// ── Launched from an ordinary shell ─────────────────────────────
{
  const env = inheritedAgentEnv({
    PATH: 'C:\\bin', HOME: 'C:\\Users\\me', NO_COLOR: '1',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SESSION_ID: 'mine', ANTHROPIC_API_KEY: 'k',
  });
  ok('NO_COLOR is never inherited', !('NO_COLOR' in env));
  ok('ordinary variables pass through', env.PATH === 'C:\\bin' && env.HOME === 'C:\\Users\\me');
  ok('credentials the user set pass through', env.ANTHROPIC_API_KEY === 'k');
  ok('outside a Claude session, CLAUDE_CODE_* are the user\'s own and kept',
    env.CLAUDE_CODE_USE_BEDROCK === '1' && env.CLAUDE_CODE_SESSION_ID === 'mine');
}

// ── Launched from inside a Claude Code session ──────────────────
{
  const env = inheritedAgentEnv({
    PATH: 'C:\\bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_AGENT_SDK_VERSION: '0.3',
    CLAUDE_PID: '1', AI_AGENT: 'claude-code', CLAUDE_EFFORT: 'medium',
    CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe', no_color: '1',
  });
  const leaked = Object.keys(env).filter((k) => /^CLAUDE|^AI_AGENT$/.test(k) &&
    !['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_GIT_BASH_PATH'].includes(k));
  ok('the enclosing session\'s markers and tokens are stripped', leaked.length === 0, leaked);
  ok('no child-session marker', !('CLAUDE_CODE_CHILD_SESSION' in env) && !('CLAUDECODE' in env));
  ok('the messaging token does not leak to agents', !('CLAUDE_CODE_MESSAGING_TOKEN' in env));
  ok('user configuration survives', env.CLAUDE_CODE_USE_VERTEX === '1' && env.CLAUDE_CODE_GIT_BASH_PATH === 'C:\\git\\bash.exe');
  ok('NO_COLOR is dropped in any case', !('no_color' in env));
  ok('unrelated variables are untouched', env.PATH === 'C:\\bin');
}

console.log(`\nagent-env pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
