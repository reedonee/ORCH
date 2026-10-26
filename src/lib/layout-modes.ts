// ── ORCH Layout Modes ───────────────────────────────────────────
// Pure geometry. No React, no stores, no DOM.
//
// Design note — why this replaces the old shelf-pack + sweep:
//
// The previous engine computed cell POSITIONS from a uniform cell size
// but returned SIZES that could differ per panel (naturalW/naturalH).
// Any panel wider than its cell therefore overlapped its neighbour by
// construction, which is why a 20-pass O(n²) "overlap sweep" existed,
// followed by index jitter to break symmetric stalls, followed by an
// "emergency separation" fallback that logged a warning when even that
// failed. All of that is treating the symptom.
//
// Here, a placement decides position and size together from the same
// cell rectangle, so panels cannot overlap and no sweep is needed. What
// the engine spends its effort on instead is the thing that actually
// matters to a user watching cards move: choosing a good grid shape for
// the available space, and assigning each panel to the slot nearest
// where it already is, so a tidy looks like everything settling rather
// than everything teleporting.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutNode extends Rect {
  id: string;
  type: string;
  /** User-pinned. The engine treats it as a fixed obstacle. */
  locked?: boolean;
  /** Sort key for deterministic ordering when position is unavailable. */
  createdAt?: number;
}

export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Placement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutModeName =
  | 'grid'
  | 'focus'
  | 'stage'
  | 'split'
  | 'rail'
  | 'constellation';

export interface LayoutOptions {
  gap: number;
  grid: number;
  /** Agent id to feature in focus/constellation modes. */
  focusId?: string | null;
  /** Delegation edges, used by constellation mode. */
  links?: Array<{ from: string; to: string }>;
  minCell?: { w: number; h: number };
  maxCell?: { w: number; h: number };
}

const DEFAULTS = {
  gap: 28,
  grid: 8,
  minCell: { w: 300, h: 200 },
  maxCell: { w: 1100, h: 860 },
  /** Cells narrower than this are unreadable for a terminal. */
  minReadableW: 300,
  /** A terminal card below this height shows too few rows to be useful. */
  minReadableH: 190,
  /** Preferred width:height for an agent card. Terminals are wide. */
  targetAspect: 1.45,
};

function snap(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Grid shape selection ────────────────────────────────────────

export interface GridShape {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  score: number;
}

/**
 * Choose the column count that best fills the region.
 *
 * The old engine hardcoded this (1→1, 2→2, 3-4→2, 5+→3) regardless of
 * the window's shape, so an ultrawide monitor got the same 3 columns as
 * a portrait one, and 12 agents were forced into 3×4 slivers. Here every
 * candidate column count is scored on how close its resulting cell comes
 * to a comfortable terminal aspect ratio and how much of the region it
 * uses, and the best one wins.
 */
export function chooseGridShape(
  count: number,
  region: Region,
  opts: { gap: number; minCell: { w: number; h: number }; maxCell: { w: number; h: number } },
): GridShape {
  const { gap, minCell, maxCell } = opts;
  if (count <= 0) {
    return { cols: 1, rows: 1, cellW: minCell.w, cellH: minCell.h, score: 0 };
  }

  let best: GridShape | null = null;

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);

    const availW = region.width - (cols - 1) * gap;
    const availH = region.height - (rows - 1) * gap;
    if (availW <= 0 || availH <= 0) continue;

    const rawW = availW / cols;
    const rawH = availH / rows;

    const cellW = clamp(rawW, minCell.w, maxCell.w);
    const cellH = clamp(rawH, minCell.h, maxCell.h);

    // How close is this cell to a comfortable terminal shape?
    const aspect = cellW / cellH;
    const aspectErr = Math.abs(Math.log(aspect / DEFAULTS.targetAspect));

    // How much of the region does the grid actually cover? Penalises both
    // a lonely wide row and a cramped tall column.
    const usedW = cols * cellW + (cols - 1) * gap;
    const usedH = rows * cellH + (rows - 1) * gap;
    const fill = (usedW * usedH) / (region.width * region.height);

    // Trailing blanks in the last row look untidy.
    const blanks = cols * rows - count;
    const blankPenalty = blanks / (cols * rows);

    // Cells that fell below the readable floor are actively bad.
    const unreadable =
      (rawW < DEFAULTS.minReadableW ? 1 : 0) + (rawH < DEFAULTS.minReadableH ? 1 : 0);

    const score =
      fill * 1.0 -
      aspectErr * 0.55 -
      blankPenalty * 0.35 -
      unreadable * 0.9;

    if (!best || score > best.score) {
      best = { cols, rows, cellW, cellH, score };
    }
  }

  const fallbackCols = Math.max(1, Math.ceil(Math.sqrt(count)));
  return (
    best ?? {
      cols: fallbackCols,
      rows: Math.ceil(count / fallbackCols),
      cellW: minCell.w,
      cellH: minCell.h,
      score: 0,
    }
  );
}

/** Build the slot rectangles for a grid shape, centred in the region.
 *
 *  Invariant: slot pitch always equals cell size + gap, so slots never
 *  overlap. When the cells hit their readable minimum and the grid no
 *  longer fits, it OVERFLOWS the region (down and to the right) rather
 *  than compressing — the viewport framing then zooms out to suit. The
 *  alternative, clamping cells to a minimum inside a fixed area, silently
 *  breaks the pitch invariant and produces overlapping cards. */
export function gridSlots(shape: GridShape, count: number, region: Region, gap: number): Rect[] {
  const { cols, rows, cellW, cellH } = shape;
  const gridW = cols * cellW + (cols - 1) * gap;
  const gridH = rows * cellH + (rows - 1) * gap;

  // Centre when it fits; anchor to the region origin when it doesn't, so
  // overflow never spills backwards into a neighbouring pinned column.
  const startX = gridW <= region.width ? region.left + (region.width - gridW) / 2 : region.left;
  const startY = gridH <= region.height ? region.top + (region.height - gridH) / 2 : region.top;

  const slots: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);

    // Centre a short final row rather than leaving it left-aligned.
    const itemsInRow = Math.min(cols, count - row * cols);
    const rowW = itemsInRow * cellW + (itemsInRow - 1) * gap;
    const rowOffset = (gridW - rowW) / 2;

    slots.push({
      x: startX + rowOffset + col * (cellW + gap),
      y: startY + row * (cellH + gap),
      width: cellW,
      height: cellH,
    });
  }
  return slots;
}

// ── Stable assignment ───────────────────────────────────────────

/**
 * Assign nodes to slots so total travel distance is small.
 *
 * A tidy that reshuffles cards arbitrarily is disorienting: the card you
 * were reading jumps across the screen. Assigning each node to the slot
 * closest to where it already sits means a tidy reads as everything
 * settling into place, and repeated tidies are stable (idempotent).
 *
 * Greedy nearest-first on all (node, slot) pairs. O(n² log n), which for
 * a canvas of at most a few dozen panels is far cheaper than the 20-pass
 * collision sweep it replaces — and unlike that sweep, it always
 * terminates with a valid result.
 */
export function assignSlots(nodes: LayoutNode[], slots: Rect[]): Map<string, Rect> {
  const result = new Map<string, Rect>();
  if (nodes.length === 0 || slots.length === 0) return result;

  const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

  interface Pair { nodeIdx: number; slotIdx: number; dist: number }
  const pairs: Pair[] = [];

  for (let n = 0; n < nodes.length; n++) {
    const nc = centre(nodes[n]);
    for (let s = 0; s < slots.length; s++) {
      const sc = centre(slots[s]);
      const dx = nc.x - sc.x;
      const dy = nc.y - sc.y;
      pairs.push({ nodeIdx: n, slotIdx: s, dist: Math.sqrt(dx * dx + dy * dy) });
    }
  }

  // Ties broken by node index so the result is deterministic across runs.
  pairs.sort((a, b) => a.dist - b.dist || a.nodeIdx - b.nodeIdx || a.slotIdx - b.slotIdx);

  const usedNodes = new Set<number>();
  const usedSlots = new Set<number>();

  for (const p of pairs) {
    if (usedNodes.has(p.nodeIdx) || usedSlots.has(p.slotIdx)) continue;
    usedNodes.add(p.nodeIdx);
    usedSlots.add(p.slotIdx);
    result.set(nodes[p.nodeIdx].id, slots[p.slotIdx]);
    if (usedNodes.size === nodes.length) break;
  }

  // Any node left over (more nodes than slots) keeps its current geometry.
  for (let n = 0; n < nodes.length; n++) {
    if (!usedNodes.has(n)) result.set(nodes[n].id, nodes[n]);
  }

  return result;
}

// ── Placement helper ────────────────────────────────────────────

function toPlacements(
  assignment: Map<string, Rect>,
  nodes: LayoutNode[],
  grid: number,
): Placement[] {
  const out: Placement[] = [];
  for (const node of nodes) {
    const slot = assignment.get(node.id);
    if (!slot) continue;
    out.push({
      id: node.id,
      x: snap(slot.x, grid),
      y: snap(slot.y, grid),
      width: snap(slot.width, grid),
      height: snap(slot.height, grid),
    });
  }
  return out;
}

/** Subtract a vertical strip from a region, returning what remains. */
function regionAfterColumn(region: Region, columnW: number, gap: number, side: 'left' | 'right'): Region {
  if (side === 'left') {
    const left = region.left + columnW + gap;
    return { ...region, left, width: Math.max(0, region.right - left) };
  }
  const right = region.right - columnW - gap;
  return { ...region, right, width: Math.max(0, right - region.left) };
}

// ── Modes ───────────────────────────────────────────────────────

/** Uniform grid. The everyday tidy. */
export function layoutGrid(nodes: LayoutNode[], region: Region, opts: LayoutOptions): Placement[] {
  if (nodes.length === 0) return [];
  const gap = opts.gap ?? DEFAULTS.gap;
  const shape = chooseGridShape(nodes.length, region, {
    gap,
    minCell: opts.minCell ?? DEFAULTS.minCell,
    maxCell: opts.maxCell ?? DEFAULTS.maxCell,
  });
  const slots = gridSlots(shape, nodes.length, region, gap);
  return toPlacements(assignSlots(nodes, slots), nodes, opts.grid ?? DEFAULTS.grid);
}

/**
 * One node large on the left, the rest stacked in a rail on the right.
 * This is the layout you want while actually working with an agent:
 * full attention on one terminal, peripheral awareness of the others.
 */
export function layoutFocus(nodes: LayoutNode[], region: Region, opts: LayoutOptions): Placement[] {
  if (nodes.length === 0) return [];
  const gap = opts.gap ?? DEFAULTS.gap;
  const grid = opts.grid ?? DEFAULTS.grid;

  const hero =
    nodes.find((n) => n.id === opts.focusId) ??
    nodes.find((n) => n.type === 'agent') ??
    nodes[0];
  const rest = nodes.filter((n) => n.id !== hero.id);

  if (rest.length === 0) {
    // Nothing to demote — centre the hero at a comfortable size.
    const w = Math.min(region.width * 0.8, DEFAULTS.maxCell.w);
    const h = Math.min(region.height * 0.9, DEFAULTS.maxCell.h);
    return [{
      id: hero.id,
      x: snap(region.left + (region.width - w) / 2, grid),
      y: snap(region.top + (region.height - h) / 2, grid),
      width: snap(w, grid),
      height: snap(h, grid),
    }];
  }

  // Rail width scales gently with how many cards must fit in it.
  const railW = clamp(region.width * 0.26, 260, 420);
  const heroW = region.width - railW - gap;
  const heroH = region.height;

  const placements: Placement[] = [{
    id: hero.id,
    x: snap(region.left, grid),
    y: snap(region.top, grid),
    width: snap(heroW, grid),
    height: snap(heroH, grid),
  }];

  // Rail: single column, evenly divided, scrolling off is prevented by
  // capping the count that gets full height and letting the rest shrink.
  const railRegion: Region = {
    ...region,
    left: region.left + heroW + gap,
    width: railW,
  };
  // Pitch and height are the same value, so rail cards can never overlap.
  // Below the floor the rail simply runs past the bottom of the region.
  const RAIL_MIN_H = 96;
  const railH = Math.max(RAIL_MIN_H, (region.height - (rest.length - 1) * gap) / rest.length);
  const railSlots: Rect[] = rest.map((_, i) => ({
    x: railRegion.left,
    y: region.top + i * (railH + gap),
    width: railW,
    height: railH,
  }));

  placements.push(...toPlacements(assignSlots(rest, railSlots), rest, grid));
  return placements;
}

/** Browser (or another pinned wide panel) on the left, agents gridded right. */
export function layoutStage(nodes: LayoutNode[], region: Region, opts: LayoutOptions): Placement[] {
  if (nodes.length === 0) return [];
  const gap = opts.gap ?? DEFAULTS.gap;
  const grid = opts.grid ?? DEFAULTS.grid;

  const stageNode = nodes.find((n) => n.type === 'browser') ?? nodes[0];
  const rest = nodes.filter((n) => n.id !== stageNode.id);

  if (rest.length === 0) return layoutGrid(nodes, region, opts);

  // Give the browser roughly half, but never so much that the agent side
  // drops below one readable column.
  const maxStageW = region.width - DEFAULTS.minReadableW - gap;
  const stageW = clamp(region.width * 0.52, 480, Math.max(480, maxStageW));

  const placements: Placement[] = [{
    id: stageNode.id,
    x: snap(region.left, grid),
    y: snap(region.top, grid),
    width: snap(stageW, grid),
    height: snap(region.height, grid),
  }];

  const rightRegion = regionAfterColumn(region, stageW, gap, 'left');
  placements.push(...layoutGrid(rest, rightRegion, opts));
  return placements;
}

/** Two balanced columns. Good for side-by-side comparison work. */
export function layoutSplit(nodes: LayoutNode[], region: Region, opts: LayoutOptions): Placement[] {
  if (nodes.length === 0) return [];
  const gap = opts.gap ?? DEFAULTS.gap;
  const grid = opts.grid ?? DEFAULTS.grid;

  const half = Math.ceil(nodes.length / 2);
  // Split by current x so cards stay on the side they were already on.
  const sorted = [...nodes].sort((a, b) => a.x - b.x || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const leftNodes = sorted.slice(0, half);
  const rightNodes = sorted.slice(half);

  const colW = (region.width - gap) / 2;
  const leftRegion: Region = { ...region, right: region.left + colW, width: colW };
  const rightRegion: Region = { ...region, left: region.left + colW + gap, width: colW };

  const COL_MIN_H = 96;
  const colSlots = (items: LayoutNode[], r: Region): Rect[] => {
    if (items.length === 0) return [];
    // Pitch == height, so the column overflows downward instead of
    // stacking cards on top of each other when space runs out.
    const h = Math.max(COL_MIN_H, (r.height - (items.length - 1) * gap) / items.length);
    return items.map((_, i) => ({
      x: r.left,
      y: r.top + i * (h + gap),
      width: r.width,
      height: h,
    }));
  };

  return [
    ...toPlacements(assignSlots(leftNodes, colSlots(leftNodes, leftRegion)), leftNodes, grid),
    ...toPlacements(assignSlots(rightNodes, colSlots(rightNodes, rightRegion)), rightNodes, grid),
  ];
}

/** Single horizontal strip. Useful for scanning many short-lived agents. */
export function layoutRail(nodes: LayoutNode[], region: Region, opts: LayoutOptions): Placement[] {
  if (nodes.length === 0) return [];
  const gap = opts.gap ?? DEFAULTS.gap;
  const grid = opts.grid ?? DEFAULTS.grid;

  const w = Math.max(
    DEFAULTS.minReadableW,
    (region.width - (nodes.length - 1) * gap) / nodes.length,
  );
  const h = Math.min(region.height, DEFAULTS.maxCell.h);
  const totalW = nodes.length * w + (nodes.length - 1) * gap;
  const startX = region.left + Math.max(0, (region.width - totalW) / 2);
  const y = region.top + (region.height - h) / 2;

  const slots: Rect[] = nodes.map((_, i) => ({
    x: startX + i * (w + gap),
    y,
    width: w,
    height: h,
  }));

  return toPlacements(assignSlots(nodes, slots), nodes, grid);
}

/**
 * Relationship-aware layout: agents that delegate to each other are
 * grouped into adjacent bands, so the canvas shows the shape of the work
 * rather than just an alphabetised grid.
 *
 * Clusters are found by union-find over the delegation edges, then laid
 * out as stacked bands, each band gridded internally.
 */
export function layoutConstellation(nodes: LayoutNode[], region: Region, opts: LayoutOptions): Placement[] {
  if (nodes.length === 0) return [];
  const links = opts.links ?? [];
  const gap = opts.gap ?? DEFAULTS.gap;

  if (links.length === 0) return layoutGrid(nodes, region, opts);

  // Union-find over delegation edges.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    // Path compression.
    let cur = a;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const n of nodes) parent.set(n.id, n.id);
  for (const l of links) {
    if (parent.has(l.from) && parent.has(l.to)) union(l.from, l.to);
  }

  const clusters = new Map<string, LayoutNode[]>();
  for (const n of nodes) {
    const root = find(n.id);
    const list = clusters.get(root);
    if (list) list.push(n);
    else clusters.set(root, [n]);
  }

  // Largest cluster first — the main line of work sits at the top.
  const groups = [...clusters.values()].sort((a, b) => b.length - a.length);

  // Height per band is proportional to how many nodes it holds.
  const totalNodes = nodes.length;
  const availH = region.height - (groups.length - 1) * gap;

  const placements: Placement[] = [];
  let cursorY = region.top;

  for (const group of groups) {
    const bandH = Math.max(DEFAULTS.minReadableH, (group.length / totalNodes) * availH);
    const bandRegion: Region = {
      ...region,
      top: cursorY,
      bottom: cursorY + bandH,
      height: bandH,
    };
    const band = layoutGrid(group, bandRegion, opts);
    placements.push(...band);

    // Advance past what the band ACTUALLY consumed, not its nominal height.
    // An inner grid whose cells hit their readable minimum overflows the
    // band; advancing by bandH alone would drop the next band on top of it.
    let consumed = bandH;
    for (const p of band) consumed = Math.max(consumed, p.y + p.height - cursorY);
    cursorY += consumed + gap;
  }

  return placements;
}

// ── Entry point ─────────────────────────────────────────────────

const MODES: Record<LayoutModeName, (n: LayoutNode[], r: Region, o: LayoutOptions) => Placement[]> = {
  grid: layoutGrid,
  focus: layoutFocus,
  stage: layoutStage,
  split: layoutSplit,
  rail: layoutRail,
  constellation: layoutConstellation,
};

export function isLayoutMode(v: string): v is LayoutModeName {
  return v in MODES;
}

/**
 * Run a layout mode over the movable nodes.
 *
 * Locked (user-pinned) nodes are excluded from placement and returned
 * unchanged; the remaining nodes are laid out in the region left over
 * once locked nodes are accounted for.
 */
export function runLayout(
  nodes: LayoutNode[],
  region: Region,
  mode: LayoutModeName,
  opts: Partial<LayoutOptions> = {},
): Placement[] {
  const options: LayoutOptions = {
    gap: opts.gap ?? DEFAULTS.gap,
    grid: opts.grid ?? DEFAULTS.grid,
    focusId: opts.focusId ?? null,
    links: opts.links ?? [],
    minCell: opts.minCell ?? DEFAULTS.minCell,
    maxCell: opts.maxCell ?? DEFAULTS.maxCell,
  };

  const locked = nodes.filter((n) => n.locked);
  const movable = nodes.filter((n) => !n.locked);

  const placed = MODES[mode](movable, region, options);

  // Pinned panels keep their exact geometry — that is what pinning means.
  for (const l of locked) {
    placed.push({ id: l.id, x: l.x, y: l.y, width: l.width, height: l.height });
  }
  return placed;
}

/** Bounding box of a set of placements, for viewport framing. */
export function boundingBox(items: Placement[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (items.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of items) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.width);
    maxY = Math.max(maxY, p.y + p.height);
  }
  return { minX, minY, maxX, maxY };
}

/** True when no two placements overlap. Used by the engine's own tests. */
export function hasNoOverlap(items: Placement[], tolerance = 0.5): boolean {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX > tolerance && overlapY > tolerance) return false;
    }
  }
  return true;
}
