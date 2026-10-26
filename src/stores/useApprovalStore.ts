// ── ORCH Approval Store ─────────────────────────────────────────
// Mirrors the main process's per-agent permission prompts (see
// electron/agent-approvals.ts) and holds each agent's Auto/Manual mode.
//
// Modes are persisted per agent id so a restored workspace keeps them;
// agents with no entry use the default from Settings.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '../lib/electron-api';

export type ApprovalMode = 'auto' | 'manual';
export type ApprovalDecision = 'approve' | 'deny';

export interface PendingApproval {
  agentId: string;
  name: string;
  providerId: string;
  kind: 'tool' | 'trust';
  question: string;
  detail: string;
  since: number;
}

interface ApprovalState {
  pending: Record<string, PendingApproval>;
  modes: Record<string, ApprovalMode>;
  setPending: (agentId: string, pending: PendingApproval | null) => void;
  setMode: (agentId: string, mode: ApprovalMode) => Promise<void>;
  respond: (agentId: string, decision: ApprovalDecision) => Promise<boolean>;
  /** Re-sync after a renderer reload, which would otherwise lose prompts
   *  that are still open in the main process. */
  load: () => Promise<void>;
}

export const useApprovalStore = create<ApprovalState>()(
  persist(
    (set) => ({
      pending: {},
      modes: {},

      setPending: (agentId, pending) => set((s) => {
        if (pending) return { pending: { ...s.pending, [agentId]: pending } };
        if (!(agentId in s.pending)) return s;
        const { [agentId]: _drop, ...rest } = s.pending;
        return { pending: rest };
      }),

      setMode: async (agentId, mode) => {
        set((s) => ({ modes: { ...s.modes, [agentId]: mode } }));
        await invoke('approval_set_mode', { agentId, mode }).catch(() => {});
      },

      respond: async (agentId, decision) => {
        const res = await invoke<{ success: boolean }>('approval_respond', { agentId, decision })
          .catch(() => ({ success: false }));
        return res.success;
      },

      load: async () => {
        const list = await invoke<PendingApproval[]>('approval_list').catch(() => []);
        set({ pending: Object.fromEntries((list ?? []).map((p) => [p.agentId, p])) });
      },
    }),
    {
      name: 'orch-approvals',
      partialize: (s) => ({ modes: s.modes }),
    },
  ),
);
