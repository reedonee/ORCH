// ── Workspace metadata (used in recent-workspaces.json) ──────────
import type { LayoutPreset } from './panel';

export interface WorkspaceMeta {
  path: string;
  name: string;
  lastOpened: number;
}

// ── Serialised canvas state saved to .orch-workspace.json ─────────
export interface WorkspaceCanvasData {
  elements: any[];
  strokeColor: string;
  strokeWidth: number;
  fillEnabled: boolean;
  fillOpacity: number;
  fontSize: number;
}

// ── Serialised app/agent state saved to .orch-workspace.json ──────
export interface WorkspaceAppData {
  agents: any[];
  viewportPan: { x: number; y: number };
  viewportZoom: number;
}

// ── Per-workspace canvas style settings ──────────────────────────
export interface WorkspaceStyleData {
  themeName: string;
  showGrid: boolean;
  gridSnap: boolean;
}

// ── Named layout presets / snapshots ────────────────────────────
export interface WorkspaceLayoutData {
  presets: LayoutPreset[];
  activePresetId: string | null;
}

// ── Top-level workspace file schema ──────────────────────────────
export interface WorkspaceFile {
  version: number;
  name: string;
  lastOpened: number;
  canvas: WorkspaceCanvasData;
  agents: WorkspaceAppData;
  style?: WorkspaceStyleData;  // optional for backward compat
  layout?: WorkspaceLayoutData; // optional for backward compat
}
