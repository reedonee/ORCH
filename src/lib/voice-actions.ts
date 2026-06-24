// ── Voice Action Executor ────────────────────────────────────────
// Executes actions returned by the VPS brain (spawn, kill, arrange, focus)
import type { VoiceAction } from './vps-client';
import { spawnProviderAgent, removeAgentByQuery, removeAllAgents, arrangeAgents, findAgentByQuery } from './agent-commands';
import { useAppStore } from '../stores/useAppStore';

const AGENT_COLORS = ['#F4A261', '#4EA8DE', '#6BBF8A', '#E76F51', '#B48BC9', '#F4C97A', '#7BC9C9', '#EAF4F4'];
const AGENT_ROLES = ['Developer', 'Terminal', 'File System', 'Debugger', 'Compiler', 'Network', 'Database', 'Observer'];

export async function executeVoiceAction(action: VoiceAction): Promise<string> {
  switch (action.type) {
    case 'spawn_agent': {
      const result = await spawnProviderAgent(action.provider || 'hermes', 1, action.name);
      return result.message;
    }
    case 'remove_agent': {
      const result = await removeAgentByQuery(action.name || '');
      return result.message;
    }
    case 'kill_all': {
      const result = await removeAllAgents();
      return result.message;
    }
    case 'arrange_agents':
      return (await arrangeAgents()).message;
    case 'focus_agent':
      return focusAgent(action);
    default:
      return `Unknown action: ${(action as any).type}`;
  }
}

async function focusAgent(action: VoiceAction): Promise<string> {
  const { agents, focusOnAgent } = useAppStore.getState();
  const name = action.name?.toLowerCase() || '';
  const target = agents.find(a => a.name.toLowerCase().includes(name))
    || agents.find(a => a.role.toLowerCase().includes(name));
  if (!target) return `Could not find agent matching "${action.name}"`;
  focusOnAgent(target);
  return `Focusing on ${target.name}`;
}
