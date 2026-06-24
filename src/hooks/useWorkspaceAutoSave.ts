// ── Workspace Auto-Save Hook ─────────────────────────────────────
// Subscribes to useCanvasStore and useAppStore, debounces changes,
// and writes to the current workspace file via IPC.

import { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useCanvasStore } from '../stores/useCanvasStore';
import { useAppStore } from '../stores/useAppStore';

const DEBOUNCE_MS = 1500;

/**
 * Call once at the app root. Monitors canvas + app stores for changes
 * and auto-saves to the current workspace's .orch-workspace.json.
 */
export function useWorkspaceAutoSave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const wasDirtyRef = useRef(false);

  useEffect(() => {
    const unsubCanvas = useCanvasStore.subscribe((state, prev) => {
      // Ignore if only session-only fields changed (undo/redo/drawing/drag)
      const relevant =
        state.elements !== prev.elements ||
        state.strokeColor !== prev.strokeColor ||
        state.strokeWidth !== prev.strokeWidth ||
        state.fillEnabled !== prev.fillEnabled ||
        state.fillOpacity !== prev.fillOpacity ||
        state.fontSize !== prev.fontSize;

      if (relevant) scheduleSave();
    });

    const unsubApp = useAppStore.subscribe((state, prev) => {
      const relevant =
        state.agents !== prev.agents ||
        state.viewportPan !== prev.viewportPan ||
        state.viewportZoom !== prev.viewportZoom;

      if (relevant) scheduleSave();
    });

    return () => {
      unsubCanvas();
      unsubApp();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function scheduleSave() {
    const wsPath = useWorkspaceStore.getState().currentWorkspacePath;
    if (!wsPath) return;

    // Mark dirty immediately
    const store = useWorkspaceStore.getState();
    if (!store.isDirty && !wasDirtyRef.current) {
      wasDirtyRef.current = true;
      store.markDirty();
    }

    // Debounce the actual write
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (isSavingRef.current) return;
      isSavingRef.current = true;
      try {
        await useWorkspaceStore.getState().saveWorkspace();
        wasDirtyRef.current = false;
      } finally {
        isSavingRef.current = false;
      }
    }, DEBOUNCE_MS);
  }
}
