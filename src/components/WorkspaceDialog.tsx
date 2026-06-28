// ── Workspace Dialog ─────────────────────────────────────────────
// Modal for creating, opening, and switching folder-based workspaces.
// Shows local recent workspaces + cloud workspaces when authenticated.

import React, { useEffect, useState } from 'react';
import { FolderOpen, Plus, RotateCcw, X, HardDrive, Cloud, Globe, AlertCircle } from 'lucide-react';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useAuthStore } from '../stores/useAuthStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { listWorkspaces, getDevicePath } from '../lib/db';
import type { WorkspaceMeta } from '../types/workspace';

export interface WorkspaceDialogProps {
  onClose: () => void;
}

interface CloudWorkspace {
  id: string;
  name: string;
  last_opened: string;
  local_path: string | null;
}

const btnBase: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  transition: 'background var(--anim-fast)',
  textAlign: 'left',
};

export const WorkspaceDialog: React.FC<WorkspaceDialogProps> = ({ onClose }) => {
  const {
    currentWorkspacePath,
    currentWorkspaceName,
    recentWorkspaces,
    isBusy,
    error,
    loadRecentWorkspaces,
    createWorkspace,
    openWorkspace,
    closeWorkspace,
    clearError,
  } = useWorkspaceStore();

  const authStatus = useAuthStore((s) => s.status);
  const isAuthed = authStatus === 'authenticated';

  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>(recentWorkspaces);
  const [cloudWorkspaces, setCloudWorkspaces] = useState<CloudWorkspace[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);

  // ── Load local workspaces on mount ─────────────────────────────
  useEffect(() => {
    loadRecentWorkspaces().then(() => {
      setWorkspaces(useWorkspaceStore.getState().recentWorkspaces);
    });
  }, []);

  // ── Fetch cloud workspaces when authenticated ──────────────────
  useEffect(() => {
    if (!isAuthed) return;
    setCloudLoading(true);
    listWorkspaces()
      .then(async (rows) => {
        const enriched: CloudWorkspace[] = await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            name: row.name,
            last_opened: row.last_opened,
            local_path: await getDevicePath(row.id).catch(() => null),
          }))
        );
        setCloudWorkspaces(enriched);
      })
      .catch((err) => console.warn('[Cloud] Failed to list workspaces:', err))
      .finally(() => setCloudLoading(false));
  }, [isAuthed]);

  const refresh = async () => {
    await loadRecentWorkspaces();
    setWorkspaces(useWorkspaceStore.getState().recentWorkspaces);
    if (isAuthed) {
      try {
        const rows = await listWorkspaces();
        const enriched: CloudWorkspace[] = await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            name: row.name,
            last_opened: row.last_opened,
            local_path: await getDevicePath(row.id).catch(() => null),
          }))
        );
        setCloudWorkspaces(enriched);
      } catch {}
    }
  };

  const handleCreate = async () => {
    await createWorkspace();
    await refresh();
    onClose();
  };

  const handleOpen = async (path?: string) => {
    await openWorkspace(path);
    await refresh();
    onClose();
  };

  const handleOpenCloud = async (cw: CloudWorkspace) => {
    if (cw.local_path) {
      // Already mapped to this device — open directly
      await handleOpen(cw.local_path);
    } else {
      // No local path yet — open folder picker, then it'll sync on save
      await handleOpen();
      // The next save will associate this workspace with the chosen folder
    }
  };

  const handleClose = async () => {
    await closeWorkspace();
    await refresh();
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: Z_BASE_LAYERS.modal,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440, maxHeight: '80vh', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          borderRadius: 'var(--radius-xl)',
          background: 'var(--surface)',
          border: '1px solid var(--border-dim)',
          boxShadow: 'var(--shadow-xl)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border-dim)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HardDrive size={16} style={{ color: 'var(--brand)' }} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>Workspaces</span>
          </div>
          <button
            onClick={onClose}
            style={{ ...btnBase, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', marginBottom: 12,
              borderRadius: 'var(--radius-md)',
              background: 'rgba(231,111,81,0.12)',
              color: '#E76F51',
              fontSize: 12,
            }}>
              <AlertCircle size={14} />
              <span>{error}</span>
              <button onClick={clearError} style={{ ...btnBase, marginLeft: 'auto', color: 'inherit', fontSize: 14 }}>×</button>
            </div>
          )}

          {/* Current workspace */}
          {currentWorkspacePath && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Current Workspace
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(244,162,97,0.08)',
                border: '1px solid rgba(244,162,97,0.15)',
              }}>
                <FolderOpen size={16} style={{ color: 'var(--brand)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{currentWorkspaceName}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {currentWorkspacePath}
                  </div>
                </div>
                <button
                  onClick={handleClose}
                  style={{ ...btnBase, padding: '4px 10px', fontSize: 11, color: 'var(--text-muted)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              onClick={handleCreate}
              disabled={isBusy}
              style={{
                ...btnBase,
                flex: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '10px 14px',
                fontWeight: 600,
                background: 'rgba(244,162,97,0.1)',
                color: 'var(--brand)',
                cursor: isBusy ? 'wait' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!isBusy) e.currentTarget.style.background = 'rgba(244,162,97,0.18)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(244,162,97,0.1)'; }}
            >
              <Plus size={14} />
              New Workspace
            </button>
            <button
              onClick={() => handleOpen()}
              disabled={isBusy}
              style={{
                ...btnBase,
                flex: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '10px 14px',
                fontWeight: 600,
                cursor: isBusy ? 'wait' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!isBusy) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <FolderOpen size={14} />
              Open Folder
            </button>
          </div>

          {/* Recent local workspaces */}
          {workspaces.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Recent
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {workspaces.map((ws) => (
                  <button
                    key={ws.path}
                    onClick={() => handleOpen(ws.path)}
                    disabled={isBusy}
                    style={{
                      ...btnBase,
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px',
                      width: '100%',
                      cursor: isBusy ? 'wait' : 'pointer',
                      opacity: ws.path === currentWorkspacePath ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => { if (!isBusy) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <HardDrive size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{ws.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ws.path}
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                      {formatRelative(ws.lastOpened)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Cloud workspaces */}
          {isAuthed && cloudWorkspaces.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Cloud size={12} style={{ color: 'var(--brand)' }} />
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
                  Cloud
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {cloudWorkspaces.map((cw) => {
                  const isCurrent = cw.local_path === currentWorkspacePath;
                  return (
                    <button
                      key={cw.id}
                      onClick={() => handleOpenCloud(cw)}
                      disabled={isBusy}
                      style={{
                        ...btnBase,
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 12px',
                        width: '100%',
                        cursor: isBusy ? 'wait' : 'pointer',
                        opacity: isCurrent ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => { if (!isBusy) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {cw.local_path
                        ? <Globe size={14} style={{ color: 'var(--brand)', flexShrink: 0 }} />
                        : <Cloud size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      }
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{cw.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cw.local_path || 'Not on this device'}
                        </div>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {formatRelative(new Date(cw.last_opened).getTime())}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cloud loading */}
          {isAuthed && cloudLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--text-muted)', fontSize: 12 }}>
              <RotateCcw size={12} className="animate-spin" />
              Syncing cloud…
            </div>
          )}

          {/* Empty state */}
          {workspaces.length === 0 && cloudWorkspaces.length === 0 && !currentWorkspacePath && (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)' }}>
              <HardDrive size={32} style={{ opacity: 0.3, marginBottom: 12 }} />
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>No workspaces yet</div>
              <div style={{ fontSize: 12 }}>Create a new workspace or open an existing folder</div>
            </div>
          )}

          {/* Busy indicator */}
          {isBusy && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
              <RotateCcw size={14} className="animate-spin" />
              Loading…
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Helpers ──────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
