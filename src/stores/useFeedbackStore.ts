// ── ORCH Hybrid Feedback Store ──────────────────────────────────
// Local-first with cloud sync: feedbacks are written to Supabase
// for public sharing, with a local cache + offline queue fallback.
// Every mutation tries the cloud; if it fails, it queues locally
// and flushes on the next successful connection.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { listFeedbacks, insertFeedback, updateFeedbackStatus, deleteFeedbackRow } from '../lib/db';
import { spawnProviderAgent } from '../lib/agent-commands';

// ── Types ────────────────────────────────────────────────────────

export type FeedbackStatus = 'pending' | 'in_progress' | 'forge_queued' | 'resolved';
export const FEEDBACK_STATUSES: FeedbackStatus[] = ['pending', 'in_progress', 'forge_queued', 'resolved'];

export interface SystemMetadata {
  screenWidth: number;
  screenHeight: number;
  runningAgentCount: number;
  activeWorkspace: string | null;
}

export interface Feedback {
  id: string;
  title: string;
  description: string;
  screenshotPath?: string;
  status: FeedbackStatus;
  submittedAt: string;
  system: SystemMetadata;
  /** Optional: who submitted this (only when cloud-synced) */
  userId?: string;
}

export interface ForgePayload {
  id: string;
  title: string;
  description: string;
  screenshotPath?: string;
  system: SystemMetadata;
}

export type SyncStatus = 'idle' | 'syncing' | 'error';

/** A write that hasn't been pushed to the cloud yet. */
interface PendingOp {
  kind: 'insert' | 'updateStatus' | 'delete';
  id: string;
  payload?: any;        // for insert: the full feedback
  status?: string;      // for updateStatus
  timestamp: number;
}

// ── Persisted slice (local cache) ────────────────────────────────

interface PersistedFeedbackState {
  feedbacks: Feedback[];
  /** Writes that failed cloud sync — flushed on reconnect */
  pendingQueue: PendingOp[];
  /** Last successful sync timestamp */
  lastSyncAt: number;
}

// ── Store shape ──────────────────────────────────────────────────

interface FeedbackState extends PersistedFeedbackState {
  selectedIds: Record<string, true>;
  viewingId: string | null;
  isForging: boolean;
  forgeMessage: string | null;

  /** Current sync status */
  syncStatus: SyncStatus;
  syncError: string | null;
  /** Whether cloud is reachable right now */
  isOnline: boolean;

  // ── Cloud sync ─────────────────────────────────────────────
  syncFromCloud: () => Promise<void>;
  flushPendingQueue: () => Promise<void>;
  checkOnline: () => Promise<boolean>;

  // ── CRUD (hybrid: local + cloud with queue fallback) ───────
  addFeedback: (partial: { title: string; description: string; screenshotPath?: string; system?: Partial<SystemMetadata> }) => Promise<string>;
  removeFeedback: (id: string) => void;
  clearAll: () => void;
  setStatus: (id: string, status: FeedbackStatus) => void;
  batchSetStatus: (ids: string[], status: FeedbackStatus) => void;

  // ── Selection ─────────────────────────────────────────────
  toggleSelected: (id: string) => void;
  selectAll: () => void;
  deselectAll: () => void;
  getSelected: () => Feedback[];
  setViewing: (id: string | null) => void;

  // ── Forge ─────────────────────────────────────────────────
  forgeSelected: (providerId?: string) => Promise<string>;
  clearForgeMessage: () => void;

  // ── Panel visibility ────────────────────────────────────
  panelVisible: boolean;
  setPanelVisible: (v: boolean) => void;
}

// ── Helpers ──────────────────────────────────────────────────────

async function enrichSystemMeta(partial: Partial<SystemMetadata> | undefined): Promise<SystemMetadata> {
  const live: SystemMetadata = {
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
    runningAgentCount: 0,
    activeWorkspace: null,
  };
  try {
    const { useAppStore } = await import('./useAppStore');
    live.runningAgentCount = useAppStore.getState().agents.length;
  } catch { /* graceful */ }
  try {
    const { useWorkspaceStore } = await import('./useWorkspaceStore');
    live.activeWorkspace = useWorkspaceStore.getState().currentWorkspaceName;
  } catch { /* graceful */ }
  return { ...live, ...partial };
}

// ── Store ────────────────────────────────────────────────────────

const FEEDBACKS_KEY = 'orch-feedback-store';

export const useFeedbackStore = create<FeedbackState>()(
  persist(
    (set, get) => ({
      feedbacks: [],
      pendingQueue: [],
      lastSyncAt: 0,
      selectedIds: {},
      viewingId: null,
      isForging: false,
      forgeMessage: null,
      syncStatus: 'idle',
      syncError: null,
      isOnline: false,
      panelVisible: false,

      // ── Cloud sync ────────────────────────────────────────────

      checkOnline: async () => {
        try {
          await listFeedbacks();
          set({ isOnline: true, syncError: null });
          return true;
        } catch {
          set({ isOnline: false });
          return false;
        }
      },

      syncFromCloud: async () => {
        set({ syncStatus: 'syncing', syncError: null });
        try {
          const rows = await listFeedbacks();
          if (rows.length === 0) {
            // Table might not exist yet — stay local only
            set({ syncStatus: 'idle', isOnline: true, lastSyncAt: Date.now() });
            return;
          }

          // Merge cloud rows into local feedbacks
          const cloudMap = new Map<string, Feedback>();
          for (const r of rows) {
            const sys = (r.system || {}) as SystemMetadata;
            cloudMap.set(r.id, {
              id: r.id,
              title: r.title,
              description: r.description,
              screenshotPath: r.screenshot_path ?? undefined,
              status: r.status as FeedbackStatus,
              submittedAt: r.submitted_at,
              system: {
                screenWidth: sys.screenWidth ?? 0,
                screenHeight: sys.screenHeight ?? 0,
                runningAgentCount: sys.runningAgentCount ?? 0,
                activeWorkspace: sys.activeWorkspace ?? null,
              },
              userId: r.user_id,
            });
          }

          // Merge: cloud entries win for existing IDs, new entries appended
          const existingIds = new Set(get().feedbacks.map((f) => f.id));
          const merged = [...get().feedbacks];

          for (const [id, cf] of cloudMap) {
            if (existingIds.has(id)) {
              const idx = merged.findIndex((f) => f.id === id);
              if (idx !== -1) merged[idx] = cf;
            } else {
              merged.push(cf);
            }
          }

          // Re-sort: newest first
          merged.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

          set({ feedbacks: merged, syncStatus: 'idle', isOnline: true, lastSyncAt: Date.now(), syncError: null });
        } catch (err: any) {
          set({ syncStatus: 'error', syncError: err?.message || 'Sync failed', isOnline: false });
        }
      },

      flushPendingQueue: async () => {
        const queue = get().pendingQueue;
        if (queue.length === 0) return;

        const remaining: PendingOp[] = [];
        for (const op of queue) {
          try {
            if (op.kind === 'insert' && op.payload) {
              await insertFeedback(op.payload);
            } else if (op.kind === 'updateStatus' && op.status) {
              await updateFeedbackStatus(op.id, op.status);
            } else if (op.kind === 'delete') {
              await deleteFeedbackRow(op.id);
            }
          } catch {
            remaining.push(op); // keep for next flush
          }
        }
        set({ pendingQueue: remaining });
      },

      // ── CRUD (hybrid) ────────────────────────────────────────

      addFeedback: async (partial) => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const system = await enrichSystemMeta(partial.system);
        const entry: Feedback = {
          id,
          title: partial.title,
          description: partial.description,
          screenshotPath: partial.screenshotPath,
          status: 'pending',
          submittedAt: now,
          system,
        };

        // Local write first (instant)
        set((state) => ({
          feedbacks: [entry, ...state.feedbacks],
          selectedIds: { ...state.selectedIds, [id]: true },
          viewingId: id,
        }));

        // Cloud write (best-effort)
        const ok = await insertFeedback({
          id,
          title: entry.title,
          description: entry.description,
          screenshot_path: entry.screenshotPath,
          status: entry.status,
          system: entry.system as any,
        });

        if (!ok) {
          // Queue for later sync
          set((state) => ({
            pendingQueue: [...state.pendingQueue, {
              kind: 'insert' as const,
              id,
              payload: {
                id,
                title: entry.title,
                description: entry.description,
                screenshot_path: entry.screenshotPath,
                status: entry.status,
                system: entry.system as any,
              },
              timestamp: Date.now(),
            }],
          }));
        }

        return id;
      },

      removeFeedback: (id) => {
        set((state) => {
          const { [id]: _drop, ...rest } = state.selectedIds;
          return {
            feedbacks: state.feedbacks.filter((f) => f.id !== id),
            selectedIds: rest,
            viewingId: state.viewingId === id ? null : state.viewingId,
          };
        });

        // Cloud delete (best-effort)
        deleteFeedbackRow(id).then((ok) => {
          if (!ok) {
            set((state) => ({
              pendingQueue: [...state.pendingQueue, { kind: 'delete' as const, id, timestamp: Date.now() }],
            }));
          }
        });
      },

      clearAll: () => {
        const ids = get().feedbacks.map((f) => f.id);
        set({ feedbacks: [], selectedIds: {}, viewingId: null });
        // Batch-delete from cloud
        for (const id of ids) {
          deleteFeedbackRow(id).then((ok) => {
            if (!ok) {
              set((state) => ({
                pendingQueue: [...state.pendingQueue, { kind: 'delete' as const, id, timestamp: Date.now() }],
              }));
            }
          });
        }
      },

      setStatus: (id, status) => {
        set((state) => ({
          feedbacks: state.feedbacks.map((f) => f.id === id ? { ...f, status } : f),
        }));
        updateFeedbackStatus(id, status).then((ok) => {
          if (!ok) {
            set((state) => ({
              pendingQueue: [...state.pendingQueue, { kind: 'updateStatus' as const, id, status, timestamp: Date.now() }],
            }));
          }
        });
      },

      batchSetStatus: (ids, status) => {
        const idSet = new Set(ids);
        set((state) => ({
          feedbacks: state.feedbacks.map((f) => idSet.has(f.id) ? { ...f, status } : f),
        }));
        for (const id of ids) {
          updateFeedbackStatus(id, status).then((ok) => {
            if (!ok) {
              set((state) => ({
                pendingQueue: [...state.pendingQueue, { kind: 'updateStatus' as const, id, status, timestamp: Date.now() }],
              }));
            }
          });
        }
      },

      // ── Selection ────────────────────────────────────────────

      toggleSelected: (id) => {
        set((state) => {
          const next = { ...state.selectedIds };
          if (next[id]) delete next[id];
          else next[id] = true;
          return { selectedIds: next };
        });
      },

      selectAll: () => {
        const ids: Record<string, true> = {};
        for (const f of get().feedbacks) ids[f.id] = true;
        set({ selectedIds: ids });
      },

      deselectAll: () => set({ selectedIds: {} }),

      getSelected: () => {
        const sel = get().selectedIds;
        return get().feedbacks.filter((f) => sel[f.id]);
      },

      setViewing: (id) => set({ viewingId: id }),

      // ── Forge ────────────────────────────────────────────────

      forgeSelected: async (providerId = 'hermes') => {
        const selected = get().getSelected();
        if (selected.length === 0) {
          const msg = 'No feedbacks selected — check some items first.';
          set({ forgeMessage: msg });
          return msg;
        }

        set({ isForging: true, forgeMessage: null });

        try {
          const ids = selected.map((f) => f.id);
          get().batchSetStatus(ids, 'forge_queued');

          const payloads: ForgePayload[] = selected.map((f) => ({
            id: f.id,
            title: f.title,
            description: f.description,
            screenshotPath: f.screenshotPath,
            system: f.system,
          }));

          let spawned = 0;
          const terminalStoreMod = await import('./useTerminalStore');
          const terminalStore = terminalStoreMod.useTerminalStore.getState();

          for (const p of payloads) {
            const taskText = [
              `📋 FORGE TASK: ${p.title}`,
              ``,
              p.description,
              p.screenshotPath ? `\n[Screenshot: ${p.screenshotPath}]` : '',
              `\n--- system context ---`,
              `Agents running: ${p.system.runningAgentCount}`,
              `Workspace: ${p.system.activeWorkspace ?? 'N/A'}`,
              `Screen: ${p.system.screenWidth}x${p.system.screenHeight}`,
            ].join('\n');

            const result = await spawnProviderAgent(providerId, 1, `🔨 Forge: ${p.title}`);
            if (result.ok && result.terminalId) {
              terminalStore.writeToTerminal(result.terminalId, taskText + '\r\n');
            }
            if (result.ok) spawned++;
          }

          const msg = `🔨 Forged ${spawned}/${payloads.length} task(s) into ${providerId} agents.`;
          set({ isForging: false, forgeMessage: msg });
          return msg;
        } catch (err: any) {
          const msg = `Forge failed: ${err?.message || 'Unknown error'}`;
          set({ isForging: false, forgeMessage: msg });
          return msg;
        }
      },

      clearForgeMessage: () => set({ forgeMessage: null }),
      setPanelVisible: (v) => set({ panelVisible: v }),
    }),
    {
      name: FEEDBACKS_KEY,
      partialize: (state) => ({
        feedbacks: state.feedbacks,
        pendingQueue: state.pendingQueue,
        lastSyncAt: state.lastSyncAt,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...((persisted as PersistedFeedbackState) || {}),
      }),
    },
  ),
);
