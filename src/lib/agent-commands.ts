import { pickAgentName } from './agent-names';
import {
  shortName, narrate, narrateSpawn, narrateRemoval, pluralAgents,
  claimSpawnAnnouncement, speakList as speakNames,
} from './voice-narration';
import { LAYOUT_ENGINE_SPEC, useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useAppStore, type Agent } from '../stores/useAppStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import type { LayoutMode } from '../stores/useWorkspaceStore';

/** Upper bound on a single spawn command. Protects against a mis-parsed
 *  number ("spawn 100 agents"), not a considered request — run the
 *  command twice if you genuinely want more. */
export const MAX_SPAWN_BATCH = 12;

const AGENT_COLORS = ['#F4A261', '#4EA8DE', '#6BBF8A', '#E76F51', '#B48BC9', '#F4C97A', '#7BC9C9', '#EAF4F4'];
const AGENT_ROLES = ['Developer', 'Terminal', 'File System', 'Debugger', 'Compiler', 'Network', 'Database', 'Observer'];

export type AppCommandResult = { ok: boolean; message: string; agentId?: string; terminalId?: string };

function buildProviderEnv(provider: { envKey?: string } | undefined) {
  const settings = useSettingsStore.getState();
  const env: Record<string, string> = {};
  if (!provider?.envKey) return env;
  const key = settings.getApiKey(provider.envKey);
  if (!key) return env;
  const varName = provider.envKey === 'anthropic' ? 'ANTHROPIC_API_KEY'
    : provider.envKey === 'openai' ? 'OPENAI_API_KEY'
    : provider.envKey === 'google' ? 'GOOGLE_API_KEY'
    : `${provider.envKey.toUpperCase()}_API_KEY`;
  env[varName] = key;
  return env;
}

export function findAgentByQuery(query: string, agents: Agent[] = useAppStore.getState().agents) {
  const lower = query.trim().toLowerCase();
  if (!lower) return undefined;
  const ordinals: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, last: -1, the: 0 };
  const ordMatch = lower.match(/(first|second|third|fourth|last|the)\s+(\S+)/);
  if (ordMatch) {
    const idx = ordinals[ordMatch[1]];
    const type = ordMatch[2].toLowerCase();
    const filtered = agents.filter((a) => a.name.toLowerCase().includes(type) || (a.provider || '').toLowerCase().includes(type) || a.role.toLowerCase().includes(type));
    return idx === -1 ? filtered[filtered.length - 1] : filtered[idx];
  }
  if (/(busy|active|idle|sleeping|error)\s+one/.test(lower)) {
    const statusMatch = lower.match(/(busy|active|idle|sleeping|error)\s+one/);
    if (statusMatch) return agents.find((a) => a.status === statusMatch[1]);
  }
  return agents.find((a) => a.name.toLowerCase().includes(lower) || (a.provider || '').toLowerCase().includes(lower) || a.role.toLowerCase().includes(lower));
}

export async function spawnProviderAgent(providerId: string, count = 1, explicitName?: string): Promise<AppCommandResult> {
  const settings = useSettingsStore.getState();
  const terminalStore = useTerminalStore.getState();
  const store = useAppStore.getState();
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider) return { ok: false, message: `Provider not found: ${providerId}` };

  let lastAgentId: string | undefined;
  let lastTerminalId: string | undefined;
  const spawnedNames: string[] = [];

  // No arbitrary cap. The old limit of 4 per command had no basis — the
  // canvas, layout engine and MCP server all handle N agents — and it
  // silently truncated "spawn 8 claude agents" to 4 with no explanation.
  // MAX_SPAWN_BATCH exists only to stop a mis-heard voice command from
  // forking a hundred processes at once.
  const requested = Math.max(1, Math.floor(count) || 1);
  const toSpawn = Math.min(requested, MAX_SPAWN_BATCH);
  for (let i = 0; i < toSpawn; i++) {
    const agents = useAppStore.getState().agents;
    const name = explicitName || `${pickAgentName(agents.map((a) => a.name))} - ${provider.name}`;
    const role = AGENT_ROLES[agents.length % AGENT_ROLES.length];
    const color = AGENT_COLORS[agents.length % AGENT_COLORS.length];
    const env = buildProviderEnv(provider);
    const kind = provider.shell === false ? 'cli' : 'shell';

    // The canvas agent id must be minted BEFORE the PTY is created so the
    // main process keys its session by the same id the UI uses. Passing the
    // display name here instead is what broke remove/wake/status/MCP lookups.
    const id = crypto.randomUUID();

    const termId = await terminalStore.createTerminal(
      id, name,
      provider.command, provider.args,
      Object.keys(env).length > 0 ? env : undefined,
      kind, providerId, 0, undefined,
    );

    const pos = useWorkspaceStore.getState().spawnPosition(lastAgentId);

    await store.addAgent({ id, name, role, status: 'idle', terminalId: termId || undefined, provider: providerId, x: pos.x, y: pos.y, color });
    lastAgentId = id;
    lastTerminalId = termId || undefined;
    spawnedNames.push(name.split(' - ')[0]);
  }

  // The process exists but the CLI may still be booting, so this is
  // "spinning up", not "ready" — see narrateSpawn.
  // Claim the announcement so App's lifecycle watcher doesn't repeat it.
  claimSpawnAnnouncement();
  let message = narrateSpawn(spawnedNames, 'starting');
  if (requested > toSpawn) {
    message += `. I capped that at ${toSpawn} — ask again for more`;
  }
  return { ok: true, message, agentId: lastAgentId, terminalId: lastTerminalId };
}

export async function removeAgentByQuery(query: string): Promise<AppCommandResult> {
  const store = useAppStore.getState();
  const target = findAgentByQuery(query, store.agents);
  if (!target) return { ok: false, message: `I couldn't find an agent called ${query}` };
  const name = target.name;
  await store.removeAgent(target.id);
  return { ok: true, message: narrate('removed', [name]), agentId: target.id, terminalId: target.terminalId };
}

export async function removeAllAgents(): Promise<AppCommandResult> {
  const store = useAppStore.getState();
  const doomed = store.agents.map((a) => ({ id: a.id, name: a.name }));
  for (const a of doomed) await store.removeAgent(a.id);
  return { ok: true, message: narrateRemoval(doomed.map((a) => a.name)) };
}

/** Spoken confirmations. These are read aloud by TTS, so they are phrased
 *  as a person would say them rather than as UI labels. */
const LAYOUT_SPOKEN: Record<string, string> = {
  grid: 'Tidied into a grid',
  focus: 'Focus layout',
  stage: 'Stage layout',
  split: 'Split into two columns',
  rail: 'Lined up in a rail',
  constellation: 'Grouped by how they work together',
};

export async function arrangeAgents(mode?: LayoutMode): Promise<AppCommandResult> {
  const store = useAppStore.getState();
  if (store.agents.length === 0) return { ok: true, message: 'There are no agents on the canvas yet' };

  const ws = useWorkspaceStore.getState();

  if (mode) {
    ws.arrange(mode);
    return { ok: true, message: LAYOUT_SPOKEN[mode] ?? `${mode} layout applied` };
  }

  // No mode spoken — pick the one that suits the current canvas.
  // One agent has nothing to tidy against, so feature it; a handful reads
  // best as a grid; a crowd with delegation links is clearer clustered.
  const count = store.agents.length;
  const hasLinks = store.delegationLinks.some((l) => l.fromAgentId && l.toAgentId);
  const chosen: LayoutMode =
    count === 1 ? 'focus'
    : hasLinks && count >= 4 ? 'constellation'
    : 'grid';

  ws.arrange(chosen);
  return { ok: true, message: `Arranged ${pluralAgents(count)}` };
}

export type AppCommand =
  | { kind: 'spawn'; providerId: string; count?: number; name?: string }
  | { kind: 'remove'; query: string }
  | { kind: 'removeAll' }
  | { kind: 'arrange'; mode?: LayoutMode }
  | { kind: 'focus'; query: string }
  | { kind: 'message'; text: string; agentName?: string }
  | { kind: 'browser'; action: 'open' | 'close'; url?: string | null }
  | { kind: 'music'; action: 'play' | 'pause' | 'next' | 'prev' | 'toggle' | 'close' | 'shuffle' | 'repeat' | 'search' | 'playUrl'; url?: string; query?: string }
  | { kind: 'approval'; decision: 'approve' | 'deny'; query?: string; all?: boolean }
  | { kind: 'approvalMode'; mode: 'auto' | 'manual'; query?: string }
  | { kind: 'controller'; query?: string; clear?: boolean };

/** Make an agent the controller (or clear it). The controller gets a
 *  brief, a live event feed and sync nudges from the main process. */
async function setControllerCommand(command: AppCommand & { kind: 'controller' }): Promise<AppCommandResult> {
  const app = useAppStore.getState();
  if (command.clear) {
    if (!app.controllerAgentId) return { ok: true, message: 'There is no controller' };
    const was = app.agents.find((a) => a.id === app.controllerAgentId)?.name;
    await app.setController(null);
    return { ok: true, message: was ? `${shortName(was)} is no longer the controller` : 'No controller now' };
  }
  const agent = command.query ? findAgentByQuery(command.query, app.agents) : undefined;
  if (!agent) return { ok: false, message: command.query ? `I couldn't find an agent called ${command.query}` : 'Say which agent should be the controller.' };
  if (!(await app.setController(agent.id))) return { ok: false, message: `I couldn't make ${shortName(agent.name)} the controller` };
  return { ok: true, message: narrate('controllerSet', [agent.name]) };
}

/** Answer waiting agents. With no target, "approve" means the one agent
 *  that is waiting — or the selected one, if several are. */
async function answerApprovals(command: AppCommand & { kind: 'approval' }): Promise<AppCommandResult> {
  const { useApprovalStore } = await import('../stores/useApprovalStore');
  const approvals = useApprovalStore.getState();
  const app = useAppStore.getState();
  const waiting = Object.keys(approvals.pending);
  const nameOf = (id: string) => app.agents.find((a) => a.id === id)?.name ?? approvals.pending[id]?.name ?? 'the agent';

  let targets: string[];
  if (command.query) {
    const agent = findAgentByQuery(command.query, app.agents);
    if (!agent) return { ok: false, message: `I couldn't find an agent called ${command.query}` };
    if (!approvals.pending[agent.id]) return { ok: false, message: `${shortName(agent.name)} isn't waiting on anything` };
    targets = [agent.id];
  } else if (command.all) {
    targets = waiting;
  } else if (waiting.length === 1) {
    targets = waiting;
  } else if (app.selectedAgentId && approvals.pending[app.selectedAgentId]) {
    targets = [app.selectedAgentId];
  } else if (waiting.length > 1) {
    return { ok: false, message: `${speakNames(waiting.map(nameOf))} are waiting. Say which one.` };
  } else {
    targets = [];
  }
  if (targets.length === 0) return { ok: false, message: 'Nobody is waiting for approval' };

  const done: string[] = [];
  for (const id of targets) {
    if (await approvals.respond(id, command.decision)) done.push(nameOf(id));
  }
  if (done.length === 0) return { ok: false, message: `I couldn't answer ${speakNames(targets.map(nameOf))}` };
  return { ok: true, message: narrate(command.decision === 'approve' ? 'approved' : 'denied', done) };
}

async function setApprovalMode(command: AppCommand & { kind: 'approvalMode' }): Promise<AppCommandResult> {
  const { useApprovalStore } = await import('../stores/useApprovalStore');
  const app = useAppStore.getState();
  const agent = command.query
    ? findAgentByQuery(command.query, app.agents)
    : app.agents.find((a) => a.id === app.selectedAgentId);
  if (!agent) {
    return { ok: false, message: command.query ? `I couldn't find an agent called ${command.query}` : 'Pick an agent first, then say that again.' };
  }
  await useApprovalStore.getState().setMode(agent.id, command.mode);
  return { ok: true, message: narrate(command.mode === 'auto' ? 'autoApprove' : 'manualApprove', [agent.name]) };
}

export async function executeAppCommand(command: AppCommand): Promise<AppCommandResult> {
  switch (command.kind) {
    case 'spawn': {
      // Return the spawn's own result. This previously awaited it and then
      // threw it away, replacing a named confirmation ("Max is spinning
      // up") with the raw provider id ("Spawn requested: hermes") — so the
      // one place the agent's name mattered most never spoke it.
      return spawnProviderAgent(command.providerId, command.count ?? 1, command.name);
    }
    case 'remove': {
      return removeAgentByQuery(command.query);
    }
    case 'removeAll': {
      return removeAllAgents();
    }
    case 'arrange': {
      return arrangeAgents(command.mode);
    }
    case 'focus': {
      const target = findAgentByQuery(command.query);
      if (!target) return { ok: false, message: `I couldn't find an agent called ${command.query}` };
      useAppStore.getState().setSelectedAgent(target.id);
      return { ok: true, message: narrate('focused', [target.name]) };
    }
    case 'message': {
      const store = useAppStore.getState();
      const targetId = command.agentName
        ? findAgentByQuery(command.agentName, store.agents)?.id
        : undefined;
      const agent = targetId
        ? store.agents.find((a) => a.id === targetId)
        : store.agents.find((a) => a.id === store.selectedAgentId);
      if (!agent?.terminalId)
        return { ok: false, message: agent ? `${shortName(agent.name)} has no terminal open` : 'Pick an agent first, then say that again.' };
      try {
        useTerminalStore.getState().writeToTerminal(agent.terminalId, command.text + '\r\n');
        return { ok: true, message: narrate('sent', [agent.name]) };
      } catch {
        return { ok: false, message: `I couldn't reach ${shortName(agent.name)}` };
      }
    }
    case 'approval': {
      return answerApprovals(command);
    }
    case 'approvalMode': {
      return setApprovalMode(command);
    }
    case 'controller': {
      return setControllerCommand(command);
    }
    case 'browser': {
      if (command.action === 'open') {
        const store = (await import('../stores/useBrowserStore')).useBrowserStore.getState();
        store.openBrowser(command.url || undefined);
        return { ok: true, message: command.url ? `Browser opened, navigating to ${command.url}` : 'Browser opened' };
      }
      if (command.action === 'close') {
        const store = (await import('../stores/useBrowserStore')).useBrowserStore.getState();
        store.setVisible(false);
        return { ok: true, message: 'Browser closed' };
      }
      return { ok: false, message: 'Unknown browser command' };
    }
    case 'music': {
      const store = (await import('../stores/useMusicPlayerStore')).useMusicPlayerStore.getState();
      switch (command.action) {
        case 'play':
        case 'toggle':
          store.setVisible(true);
          return { ok: true, message: 'Music player opened' };
        case 'pause':
          store.pause();
          return { ok: true, message: 'Music paused' };
        case 'next':
          store.next();
          return { ok: true, message: 'Next track' };
        case 'prev':
          store.prev();
          return { ok: true, message: 'Previous track' };
        case 'close':
          store.setVisible(false);
          return { ok: true, message: 'Music player closed' };
        case 'shuffle':
          store.toggleShuffle();
          return { ok: true, message: store.shuffle ? 'Shuffle on' : 'Shuffle off' };
        case 'repeat':
          store.cycleRepeat();
          return { ok: true, message: `Repeat: ${store.repeat}` };
        case 'search':
          store.setVisible(true);
          store.setSearchQuery(command.query || '');
          return { ok: true, message: `Searching for ${command.query}` };
        case 'playUrl':
          if (command.url) {
            store.setVisible(true);
            store.playUrl(command.url);
            return { ok: true, message: `Playing ${command.url}` };
          }
          return { ok: false, message: 'No URL provided' };
        default:
          return { ok: false, message: 'Unknown music command' };
      }
    }
    default:
      return { ok: false, message: `Unknown command` };
  }
}
