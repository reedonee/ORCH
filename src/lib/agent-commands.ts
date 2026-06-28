import { pickAgentName } from './agent-names';
import { LAYOUT_ENGINE_SPEC, useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useAppStore, type Agent } from '../stores/useAppStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import type { LayoutMode } from '../stores/useWorkspaceStore';

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

  for (let i = 0; i < Math.min(Math.max(count, 1), 4); i++) {
    const agents = useAppStore.getState().agents;
    const name = explicitName || `${pickAgentName(agents.map((a) => a.name))} - ${provider.name}`;
    const role = AGENT_ROLES[agents.length % AGENT_ROLES.length];
    const color = AGENT_COLORS[agents.length % AGENT_COLORS.length];
    const env = buildProviderEnv(provider);
    const kind = provider.shell === false ? 'cli' : 'shell';
    let termId: string | null = null;

    termId = await terminalStore.createTerminal(
      name, `${name} Terminal`,
      provider.command, provider.args,
      Object.keys(env).length > 0 ? env : undefined,
      kind, providerId, 0, undefined,
    );

    const current = useAppStore.getState();
    const pos = useWorkspaceStore.getState().spawnPosition(lastAgentId);

    const id = crypto.randomUUID();
    await store.addAgent({ id, name, role, status: 'idle', terminalId: termId || undefined, provider: providerId, x: pos.x, y: pos.y, color });
    lastAgentId = id;
    lastTerminalId = termId || undefined;
    spawnedNames.push(name.split(' - ')[0]);
  }

  const displayProvider = provider.name || providerId;
  const actualCount = Math.min(Math.max(count, 1), 4);
  let message: string;
  if (actualCount === 1 && spawnedNames[0]) {
    message = `${spawnedNames[0]} the ${displayProvider} agent is ready`;
  } else if (actualCount === 2 && spawnedNames.length === 2) {
    message = `${spawnedNames[0]} and ${spawnedNames[1]} are ready`;
  } else {
    const numWords = ['one', 'two', 'three', 'four'];
    message = `${numWords[actualCount - 1] || actualCount} ${displayProvider} agents spinning up`;
  }

  return { ok: true, message, agentId: lastAgentId, terminalId: lastTerminalId };
}

export async function removeAgentByQuery(query: string): Promise<AppCommandResult> {
  const store = useAppStore.getState();
  const target = findAgentByQuery(query, store.agents);
  if (!target) return { ok: false, message: `Could not find agent matching "${query}"` };
  await store.removeAgent(target.id);
  return { ok: true, message: `Removed ${target.name}`, agentId: target.id, terminalId: target.terminalId };
}

export async function removeAllAgents(): Promise<AppCommandResult> {
  const store = useAppStore.getState();
  const ids = [...store.agents.map((a) => a.id)];
  for (const id of ids) await store.removeAgent(id);
  return { ok: true, message: `Removed ${ids.length} agent(s)` };
}

export async function arrangeAgents(mode?: LayoutMode): Promise<AppCommandResult> {
  const store = useAppStore.getState();
  if (store.agents.length === 0) return { ok: true, message: 'No agents to arrange' };

  if (mode) {
    useWorkspaceStore.getState().setLayoutMode(mode);
    const labels: Record<string, string> = { tidy: 'Tidy', grid: 'Grid', stage: 'Stage' };
    return { ok: true, message: `🏛️ ${labels[mode] ?? mode} layout applied` };
  }

  useWorkspaceStore.getState().autoArrange();
  return { ok: true, message: `Arranged ${store.agents.length} agent(s)` };
}

export type AppCommand =
  | { kind: 'spawn'; providerId: string; count?: number; name?: string }
  | { kind: 'remove'; query: string }
  | { kind: 'removeAll' }
  | { kind: 'arrange'; mode?: LayoutMode }
  | { kind: 'focus'; query: string }
  | { kind: 'message'; text: string; agentName?: string }
  | { kind: 'browser'; action: 'open' | 'close'; url?: string | null }
  | { kind: 'music'; action: 'play' | 'pause' | 'next' | 'prev' | 'toggle' | 'close' | 'shuffle' | 'repeat' | 'search' | 'playUrl'; url?: string; query?: string };

export async function executeAppCommand(command: AppCommand): Promise<AppCommandResult> {
  switch (command.kind) {
    case 'spawn': {
      await spawnProviderAgent(command.providerId, command.count ?? 1, command.name);
      return { ok: true, message: `Spawn requested: ${command.providerId}` };
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
      if (!target) return { ok: false, message: `No agent matched: ${command.query}` };
      useAppStore.getState().setSelectedAgent(target.id);
      return { ok: true, message: `Focused ${target.name}` };
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
        return { ok: false, message: agent ? `${agent.name} has no terminal` : 'Select an agent first, then send a message.' };
      try {
        useTerminalStore.getState().writeToTerminal(agent.terminalId, command.text + '\r\n');
        return { ok: true, message: `Sent to ${agent.name}` };
      } catch {
        return { ok: false, message: `Failed to send to ${agent.name}` };
      }
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
