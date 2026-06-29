// ── ORCH Spatial Layout Engine — Panel Node Types ────────────
// The single source of truth for every movable surface.
//
// PanelSpace:
//   canvas  — lives inside the transformed canvas (affected by pan/zoom)
//   fixed   — window-space overlay (BrowserPreview, MusicPlayer)
//   chrome  — persistent UI controls (PillBar, ChatBar, Toolbar)
//   modal   — ephemeral overlays (dialogs)
//
// Participation flags control how the layout engine treats each panel.
// Every panel is tracked in the registry for z-stack awareness, but
// only those with participatesInAutoLayout=true get moved by the engine.

export type PanelSpace = 'canvas' | 'fixed' | 'chrome' | 'modal';
export type PanelType = 'agent' | 'browser' | 'music' | 'textnote' | 'image' | 'forge' | 'feedback' | 'chrome' | 'modal';

/** Unified panel descriptor — one object per movable/visible surface. */
export interface PanelNode {
  /** Unique identifier (matches agent.id for agents, 'browser' / 'music' for overlays) */
  id: string;
  /** Discriminator for rendering and behaviour */
  type: PanelType;
  /** Which coordinate space this panel lives in */
  space: PanelSpace;

  // ── Geometry (in the panel's native space) ──
  x: number;
  y: number;
  width: number;
  height: number;

  /** Hard minimums — enforced by drag/resize and layout engine */
  minWidth: number;
  minHeight: number;

  /** Default dimensions — used when resetting or first registering */
  defaultWidth: number;
  defaultHeight: number;

  // ── Layout engine participation ──
  /** Engine may reposition this panel during auto-arrange */
  participatesInAutoLayout: boolean;
  /** Engine includes this panel's bounding box when computing fit-to-screen */
  participatesInFraming: boolean;
  /** Engine treats this panel's area as an obstacle during collision resolution */
  participatesInCollision: boolean;

  // ── Interaction flags ──
  draggable: boolean;
  resizable: boolean;
  focusable: boolean;
  /** Pinned — engine will never move or resize this panel */
  locked: boolean;
  /** Set to true when the user manually drags or resizes this panel.
   *  Cleared by autoArrange() so the engine is free to reposition. */
  wasManuallyMoved?: boolean;

  // ── Z-order (runtime, computed by z-stack manager) ──
  /** The panel's resting layer (e.g. agent=10, browser=500) */
  baseZIndex: number;
  /** Current effective z-index — may be elevated during drag/focus */
  zIndex: number;

  // ── Visual state ──
  minimized: boolean;
  opacity: number;

  // ── Persistence ──
  /** Save/restore across workspace sessions */
  persistent: boolean;

  // ── Agent cross-reference (only when type='agent') ──
  /** Links back to useAppStore agent ID */
  agentRef?: string;
}

/** The minimal payload needed to create a panel registration. */
export interface PanelRegistration {
  id: string;
  type: PanelType;
  space: PanelSpace;
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  participatesInAutoLayout?: boolean;
  participatesInFraming?: boolean;
  participatesInCollision?: boolean;
  draggable?: boolean;
  resizable?: boolean;
  focusable?: boolean;
  locked?: boolean;
  baseZIndex?: number;
  minimized?: boolean;
  opacity?: number;
  persistent?: boolean;
  agentRef?: string;
}

/** Layout motion tokens — consumed by panels for CSS transitions. */
export interface LayoutMotion {
  /** 'spring' for arranged moves, 'immediate' for responsive feedback, 'none' when settled */
  mode: 'immediate' | 'spring' | 'none';
  /** Computed CSS transition string (e.g. "left 450ms cubic-bezier(...), top 450ms ...") */
  transition: string;
}

/** Layout engine lifecycle phase — components gate transitions on this. */
export type LayoutPhase = 'idle' | 'arranging' | 'settled';

/** High-level arrangement mode. */
export type LayoutMode = 'tidy' | 'grid' | 'stage' | null;

// ── Layout Snapshot System ───────────────────────────────────
// Premium UX: save/restore the full spatial composition as named
// presets. Each snapshot captures every panel's geometry + viewport
// transform + z-stack order — so the user can switch between layouts
// instantly with a single click.

/** Serialized geometry for one panel inside a snapshot. */
export interface PanelSnapshotEntry {
  id: string;
  type: PanelType;
  space: PanelSpace;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
}

/** A frozen spatial composition — the complete layout at a point in time. */
export interface LayoutSnapshot {
  /** Unique key (auto-generated if not provided) */
  id: string;
  /** Human-readable label shown in the UI */
  label: string;
  /** ISO timestamp of when this snapshot was taken */
  createdAt: string;
  /** Viewport transform at capture time */
  viewportPan: { x: number; y: number };
  viewportZoom: number;
  /** Front-to-back z-stack order */
  zStack: string[];
  /** All panel geometries at capture time */
  panels: PanelSnapshotEntry[];
}

/** Named preset — a snapshot the user explicitly saved and labelled. */
export interface LayoutPreset extends LayoutSnapshot {
  /** 'auto' = auto-saved per workspace, 'manual' = user-created */
  kind: 'auto' | 'manual';
}
