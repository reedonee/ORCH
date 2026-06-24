// ── Workspace File Sync Hook ────────────────────────────────────────
// Automatically starts/stops VPS file sync when a workspace is
// opened or closed. Mirrors the useWorkspaceAutoSave pattern.
//
// The VPS URL is read from VITE_SERVER_URL so the sync engine
// connects to the same agent-core server as the rest of the app.

import { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import {
  fileSyncStart,
  fileSyncStop,
} from '../lib/electron-api';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';

/**
 * Call once at the app root alongside useWorkspaceAutoSave.
 * Monitors the current workspace path and syncs the project folder
 * with the VPS so agents can access and modify local files.
 */
export function useWorkspaceFileSync() {
  const prevPathRef = useRef<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const unsub = useWorkspaceStore.subscribe((state) => {
      const current = state.currentWorkspacePath;

      // No change — skip
      if (current === prevPathRef.current) return;
      prevPathRef.current = current;

      if (current) {
        // Workspace opened — start file sync
        const folderName = current.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace';
        const workspaceId = folderName
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          || `ws-${Date.now()}`;

        console.log(`[FileSync] Auto-starting sync for ${current} → ${workspaceId}`);

        fileSyncStart(workspaceId, current, SERVER_URL)
          .then((result) => {
            if (result.success) {
              startedRef.current = true;
              console.log(`[FileSync] Sync started for ${workspaceId}`);
            } else {
              console.warn('[FileSync] Failed to start (IPC unavailable)');
            }
          })
          .catch((err: Error) => {
            console.warn('[FileSync] Start error (non-fatal):', err.message);
            // Non-fatal — workspace still works locally
          });
      } else if (startedRef.current) {
        // Workspace closed — stop file sync
        console.log('[FileSync] Auto-stopping sync');
        startedRef.current = false;
        fileSyncStop().catch((err: Error) =>
          console.warn('[FileSync] Stop error:', err.message),
        );
      }
    });

    return unsub;
  }, []);
}
