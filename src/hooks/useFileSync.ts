// ── useFileSync Hook ───────────────────────────────────────────────
// Subscribes to the file sync engine state in the main process and
// provides start/stop controls to the renderer.
//
// Usage:
//   const { syncState, startSync, stopSync } = useFileSync();

import { useEffect, useState, useCallback } from 'react';
import {
  fileSyncStart,
  fileSyncStop,
  fileSyncGetState,
  onFileSyncStateChanged,
} from '../lib/electron-api';
import type { SyncState } from '../lib/electron-api';

const DEFAULT_STATE: SyncState = {
  status: 'disconnected',
  workspaceId: null,
  localPath: null,
  lastSynced: null,
  error: null,
  pendingChanges: 0,
};

export function useFileSync() {
  const [syncState, setSyncState] = useState<SyncState>(DEFAULT_STATE);
  const [isLoading, setIsLoading] = useState(false);

  // Load initial state on mount
  useEffect(() => {
    fileSyncGetState().then(setSyncState).catch(console.error);
  }, []);

  // Subscribe to main process state changes
  useEffect(() => {
    const unsub = onFileSyncStateChanged((state) => {
      setSyncState(state);
    });
    return unsub;
  }, []);

  const startSync = useCallback(
    async (workspaceId: string, localPath: string, vpsUrl: string) => {
      setIsLoading(true);
      try {
        const result = await fileSyncStart(workspaceId, localPath, vpsUrl);
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const stopSync = useCallback(async () => {
    setIsLoading(true);
    try {
      await fileSyncStop();
      setSyncState(DEFAULT_STATE);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    syncState,
    isLoading,
    startSync,
    stopSync,
    /** Convenience booleans */
    isConnected: syncState.status === 'syncing',
    isUploading: syncState.status === 'uploading',
    isError: syncState.status === 'error',
    hasPendingChanges: syncState.pendingChanges > 0,
    lastSynced: syncState.lastSynced,
    errorMessage: syncState.error,
  };
}
