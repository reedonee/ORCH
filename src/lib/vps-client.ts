// ── VPS Cloud Client ─────────────────────────────────────────────
// HTTP/WS client for the ORCH agent-core running on the VPS.
// Uses VITE_SERVER_URL / VITE_WS_URL from .env.development.

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000';

// ── Types ──────────────────────────────────────────────────────────
export interface VpsHealth {
  status: string;
  service: string;
}

export interface VpsStatus {
  connected: boolean;
  health: VpsHealth | null;
  error: string | null;
  latency: number | null;
}

// ── Voice Brain Types ──────────────────────────────────────────────
export interface VoiceAction {
  type: 'spawn_agent' | 'remove_agent' | 'arrange_agents' | 'kill_all' | 'focus_agent';
  provider?: string;
  name?: string;
  layout?: string;
}

export interface VoiceProcessResult {
  response: string;
  action: VoiceAction | null;
}

// ── API Client ────────────────────────────────────────────────────
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${SERVER_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!res.ok) {
      throw new Error(`VPS ${res.status}: ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

export const vpsClient = {
  /** Health check */
  health: (): Promise<VpsHealth> => request<VpsHealth>('/api/health'),

  /** Ping the server and measure round-trip latency */
  ping: async (): Promise<VpsStatus> => {
    const start = performance.now();
    try {
      const health = await request<VpsHealth>('/api/health');
      const latency = Math.round(performance.now() - start);
      return { connected: true, health, error: null, latency };
    } catch (err: any) {
      return {
        connected: false,
        health: null,
        error: err?.message || String(err),
        latency: null,
      };
    }
  },

  /** Send voice transcript to VPS brain for understanding */
  processVoice: (transcript: string, context?: string): Promise<VoiceProcessResult> =>
    request<VoiceProcessResult>('/api/voice/process', {
      method: 'POST',
      body: JSON.stringify({ transcript, context: context || '' }),
    }),

  /** Correct STT transcription errors */
  correctStt: (text: string): Promise<{ corrected: string; original: string }> =>
    request<{ corrected: string; original: string }>('/api/stt/correct', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** Synthesize speech via cloud TTS */
  speak: async (text: string): Promise<{ audio: string; sample_rate: number }> =>
    request<{ audio: string; sample_rate: number }>('/api/tts', {
      method: 'POST',
      body: JSON.stringify({ text, voice: 'af_bella', speed: 1.0 }),
    }),

  /** Generic GET */
  get: <T>(path: string): Promise<T> => request<T>(path),

  /** Generic POST */
  post: <T>(path: string, body: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),

  // ── VPS Terminal Sessions (tmux) ──────────────────────────

  /** Create a terminal session for an agent. Optionally auto-start a tool. */
  createTerminal: (agentId: string, tool?: string, workspaceId?: string): Promise<{ agent_id: string; created: boolean }> => {
    const body: Record<string, string> = {};
    if (tool) body.tool = tool;
    if (workspaceId) body.workspace_id = workspaceId;
    return request(`/api/agents/${agentId}/terminal`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Get terminal buffer snapshot (last 200 lines) */
  readTerminal: (agentId: string): Promise<{
    agent_id: string; lines: string[]; content: string;
    total_lines: number; session: string;
  }> => request(`/api/agents/${agentId}/terminal`),

  /** Send input to an agent's terminal */
  writeTerminal: (agentId: string, text: string): Promise<{ sent: boolean }> =>
    request(`/api/agents/${agentId}/terminal/input`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** Resize an agent terminal */
  resizeTerminal: (agentId: string, cols: number, rows: number): Promise<{ ok: boolean; cols: number; rows: number }> =>
    request(`/api/agents/${agentId}/terminal/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }),

  /** Search workspace memories via Qdrant */
  searchMemory: (query: string, agentId?: string, limit?: number): Promise<any> =>
    request('/api/memory/search', {
      method: 'POST',
      body: JSON.stringify({ query, agent_id: agentId, limit: limit ?? 5 }),
    }),

  /** List all VPS terminal sessions */
  listTerminals: (): Promise<Array<{ agent_id: string; attached: boolean }>> =>
    request('/api/sessions'),

  /** Get the base URLs for manual fetch/WS usage */
  urls: () => ({ server: SERVER_URL, ws: WS_URL }),
};

// ── WebSocket Connection ──────────────────────────────────────────
export function createVoiceWs(): WebSocket {
  return new WebSocket(`${WS_URL}/voice-ws`);
}

export default vpsClient;
