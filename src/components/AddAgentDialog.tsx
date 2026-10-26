import React, { useState } from 'react';
import { invoke } from '../lib/electron-api';
import { GlassPanel } from './GlassPanel';
import { useAppStore } from '../stores/useAppStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { PROVIDER_ICONS } from './icons/ProviderIcon';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { pickAgentName } from '../lib/agent-names';

interface AddAgentDialogProps {
  onClose: () => void;
}

const AGENT_COLORS = [
  '#7c3aed', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#06b6d4', '#a855f7', '#f97316',
];

const AGENT_ROLES = [
  'Developer', 'Terminal', 'File System', 'Debugger',
  'Compiler', 'Network', 'Database', 'Observer',
];

export const AddAgentDialog: React.FC<AddAgentDialogProps> = ({ onClose }) => {
  const { addAgent } = useAppStore();
  const { createTerminal } = useTerminalStore();
  const { providers, defaultProvider, getApiKey } = useSettingsStore();
  const [name, setName] = useState('');
  const [role, setRole] = useState(AGENT_ROLES[0]);
  const [color, setColor] = useState(AGENT_COLORS[0]);
  const [selectedProvider, setSelectedProvider] = useState(defaultProvider);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setError(null);
    const provider = providers.find((p) => p.id === selectedProvider);
    const { agents } = useAppStore.getState();
    const agentName = name.trim() || `${pickAgentName(agents.map(a => a.name))} - ${provider?.name}`;

    const env: Record<string, string> = {};
    if (provider?.envKey) {
      const key = getApiKey(provider.envKey);
      if (key) {
        const varName = provider.envKey === 'anthropic' ? 'ANTHROPIC_API_KEY'
          : provider.envKey === 'openai' ? 'OPENAI_API_KEY'
          : provider.envKey === 'google' ? 'GOOGLE_API_KEY'
          : `${provider.envKey.toUpperCase()}_API_KEY`;
        env[varName] = key;
      }
    }

    const launchMode = provider?.launchMode ?? 'embedded';
    const kind = provider?.shell === false ? 'cli' : 'shell';

    try {
      let termId: string | null = null;
      // Mint the canvas id first so the PTY session is keyed by the same
      // id the UI uses — see spawnProviderAgent() for the full rationale.
      const agentId = crypto.randomUUID();

      if (launchMode === 'embedded') {
        termId = await createTerminal(
          agentId,
          agentName,
          provider?.command,
          provider?.args,
          Object.keys(env).length > 0 ? env : undefined,
          kind,
          selectedProvider,
        );

        if (!termId) {
          throw new Error(`Failed to create ${provider?.name ?? 'agent'} terminal`);
        }
      }

      if (launchMode === 'external' && provider?.command) {
        await invoke('create_terminal', {
          agentId: `${agentName}-launcher`,
          name: `${agentName} Launcher`,
          command: provider.command,
          args: provider.args,
          env: Object.keys(env).length > 0 ? env : null,
          kind: 'external',
          providerId: null,
        });
      }

      const pos = useWorkspaceStore.getState().spawnPosition();
      const x = pos.x;
      const y = pos.y;

      await addAgent({
        id: agentId,
        name: agentName,
        role,
        status: 'idle',
        terminalId: termId || undefined,
        provider: selectedProvider,
        x,
        y,
        color,
      });

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Agent creation failed:', err);
      setError(message);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: Z_BASE_LAYERS.modal,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        animation: 'fadeIn var(--anim-normal) ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <GlassPanel
        className="animate-scale-in" accent
        style={{
          width: 440, padding: 24, borderRadius: 'var(--radius-xl)',
          display: 'flex', flexDirection: 'column', gap: 14,
          boxShadow: 'var(--shadow-xl)',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>Spawn Agent</div>

        {/* Name */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Agent Name
          </label>
          <input className="glass-input" value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Code-Worker-1" autoFocus />
        </div>

        {/* Provider */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Terminal Provider
          </label>
          <select
            className="glass-input"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
            style={{ cursor: 'pointer' }}
          >
            {providers.map((p) => {
                const ProviderSvg = PROVIDER_ICONS[p.id];
                return (
              <option key={p.id} value={p.id}>
                {ProviderSvg ? <span style={{verticalAlign:'middle',marginRight:6,display:'inline-flex'}}><ProviderSvg size={14} /></span> : null}
                {p.name}
              </option>
                );
              })}
          </select>
        </div>

        {/* Role */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Role
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {AGENT_ROLES.map((r) => (
              <button key={r}
                className={`glass-btn ${role === r ? 'glass-accent' : ''}`}
                onClick={() => setRole(r)}
                style={{ padding: '4px 12px', fontSize: 12, borderRadius: 'var(--radius-pill)' }}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Color */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Accent Color
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            {AGENT_COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)}
                style={{
                  width: 28, height: 28, borderRadius: '50%', background: c,
                  border: color === c ? '2px solid white' : '2px solid transparent',
                  cursor: 'pointer', transition: 'all var(--anim-fast)',
                  boxShadow: color === c ? `0 0 12px ${c}80` : 'none',
                }} />
            ))}
          </div>
        </div>

        {error && (
          <div style={{
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.35)',
            color: '#fca5a5',
            fontSize: 12,
            lineHeight: 1.45,
          }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="glass-btn" onClick={onClose} style={{ padding: '8px 20px' }}>Cancel</button>
          <button className="glass-btn" onClick={handleCreate}
            style={{ padding: '8px 20px', background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)', fontWeight: 600 }}>
            Create Agent
          </button>
        </div>
      </GlassPanel>
    </div>
  );
};
