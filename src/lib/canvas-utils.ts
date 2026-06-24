// Canvas layout utilities

export const CARD_W = 520;
export const CARD_H = 360;
export const GRID_SNAP = 20;
export const GRID_PAD_X = 56;
export const GRID_PAD_Y = 40;
export const START_X = 80;
export const START_Y = 80; // below the top pill bar (~70px) + padding

// Snap a value to the nearest grid increment
export function snapToGrid(val: number, grid: number = GRID_SNAP): number {
  return Math.round(val / grid) * grid;
}

// Read real DOM dimensions for a card, falling back to defaults
export function getCardDimensions(id: string): { w: number; h: number } {
  if (typeof document === 'undefined') return { w: CARD_W, h: CARD_H };
  const el = document.getElementById(`agent-card-${id}`);
  if (!el) return { w: CARD_W, h: CARD_H };
  const w = Math.ceil(el.offsetWidth / GRID_SNAP) * GRID_SNAP;
  const h = Math.ceil(el.offsetHeight / GRID_SNAP) * GRID_SNAP;
  return { w: Math.max(w, 200), h: Math.max(h, 160) };
}

// Find the next free grid slot that doesn't overlap existing agents
export interface AgentSlot {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export function findNextPosition(
  agents: AgentSlot[],
  cols: number = 3,
  padX: number = GRID_PAD_X,
  padY: number = GRID_PAD_Y,
  startX: number = START_X,
  startY: number = START_Y,
): { x: number; y: number } {
  if (agents.length === 0) {
    return { x: startX, y: startY };
  }

  const positions = autoLayout(agents, cols, padX, padY, startX, startY);
  const lastPosition = positions[positions.length - 1];
  const lastAgent = agents[agents.length - 1];
  const lastWidth = lastAgent.width || CARD_W;
  return { x: lastPosition.x + lastWidth + padX, y: lastPosition.y };
}

// Place a new agent within the user's current viewport
export function findViewportPosition(
  agents: AgentSlot[],
  viewportPan: { x: number; y: number },
  viewportZoom: number,
  winSize: { w: number; h: number },
): { x: number; y: number } {
  const PAD = 40;

  // Viewport center in canvas coordinates
  const vpLeft = -viewportPan.x / viewportZoom;
  const vpTop = -viewportPan.y / viewportZoom;
  const cx = vpLeft + (winSize.w / viewportZoom) / 2;
  const cy = vpTop + (winSize.h / viewportZoom) / 2;

  // Try center first, then offset positions
  const candidates = [
    { x: cx - CARD_W / 2, y: cy - CARD_H / 2 },
    { x: cx - CARD_W / 2 + CARD_W + PAD, y: cy - CARD_H / 2 },
    { x: cx - CARD_W / 2 - CARD_W - PAD, y: cy - CARD_H / 2 },
    { x: cx - CARD_W / 2, y: cy - CARD_H / 2 + CARD_H + PAD },
    { x: cx - CARD_W / 2, y: cy - CARD_H / 2 - CARD_H - PAD },
  ];

  for (const pos of candidates) {
    const overlap = agents.some((a) => {
      const aw = a.width || CARD_W;
      const ah = a.height || CARD_H;
      return !(pos.x + CARD_W <= a.x || pos.x >= a.x + aw || pos.y + CARD_H <= a.y || pos.y >= a.y + ah);
    });
    if (!overlap) return { x: Math.round(pos.x), y: Math.round(pos.y) };
  }

  // If viewport is full, place below everything
  const maxY = agents.length > 0 ? Math.max(...agents.map((a) => a.y + (a.height || CARD_H)), 0) : cy;
  return { x: Math.round(cx - CARD_W / 2), y: Math.round(maxY + PAD) };
}

// Fluid grid wrap: arranges cards in rows that fit the viewport width
// Dynamically reads DOM dimensions, falls back to defaults
export function autoLayout(
  agents: AgentSlot[],
  _cols: number = 3,
  _padX: number = GRID_SNAP,
  _padY: number = GRID_SNAP,
  startX: number = START_X,
  startY: number = START_Y,
): Array<{ id: string; x: number; y: number }> {
  if (agents.length === 0) return [];

  // Sort by current visual position so spatial order is preserved
  const sorted = [...agents].sort((a, b) => {
    const ay = a.y ?? 0;
    const by = b.y ?? 0;
    if (Math.abs(ay - by) > 10) return ay - by;
    return (a.x ?? 0) - (b.x ?? 0);
  });

  // Compute container width from viewport (80% of screen, capped)
  const containerWidth = Math.min(window.innerWidth * 0.85, 1600);
  const spacing = GRID_SNAP;

  const positions: Array<{ id: string; x: number; y: number }> = [];
  let currentX = startX;
  let currentY = startY;
  let maxRowH = 0;

  for (const agent of sorted) {
    const { w, h } = getCardDimensions(agent.id);

    // Wrap to next row if card doesn't fit
    if (currentX + w > startX + containerWidth && currentX > startX) {
      currentX = startX;
      currentY += maxRowH + spacing;
      maxRowH = 0;
    }

    positions.push({ id: agent.id, x: currentX, y: currentY });

    currentX += w + spacing;
    if (h > maxRowH) maxRowH = h;
  }

  return positions;
}

// Compute bounding box of all agent cards
export function computeBoundingBox(
  positions: Array<{ id: string; x: number; y: number }>,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (positions.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions) {
    const { w, h } = getCardDimensions(p.id);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + w > maxX) maxX = p.x + w;
    if (p.y + h > maxY) maxY = p.y + h;
  }
  return { minX, minY, maxX, maxY };
}

// Calculate pan/zoom to frame a bounding box in the viewport
export function fitToBoundingBox(
  bb: { minX: number; minY: number; maxX: number; maxY: number },
  winW: number,
  winH: number,
  padding: number = 40,
): { zoom: number; pan: { x: number; y: number } } {
  const contentW = bb.maxX - bb.minX + padding;
  const contentH = bb.maxY - bb.minY + padding;
  const zoom = Math.min(1, Math.min((winW - padding * 2) / contentW, (winH - padding * 2) / contentH));
  const centerX = (bb.minX + bb.maxX) / 2 * zoom;
  const centerY = (bb.minY + bb.maxY) / 2 * zoom;
  return {
    zoom: Math.max(0.25, zoom),
    pan: {
      x: winW / 2 - centerX,
      y: winH / 2 - centerY,
    },
  };
}
