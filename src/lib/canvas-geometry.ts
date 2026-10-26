// ── ORCH Canvas Geometry ───────────────────────────────────────
// The single source of truth for canvas maths.
//
// Every layer used to carry its own copy of "where is this element and
// did the pointer hit it", and every copy was wrong in a different way:
// the lasso treated strokes as a 40x20 box at the origin, the eraser
// sampled stroke vertices instead of segments, and text drag forgot to
// divide by zoom. Bounds and hit-testing live here now so a fix lands
// once.
//
// Nothing in this module touches the DOM or React, so it is directly
// testable — see tests/canvas-geometry.check.mts.

import type { CanvasElement, CanvasPoint } from '../stores/useCanvasStore';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Default box for a shape that has no explicit size yet. */
const DEFAULT_SHAPE = 80;
/** Fallback text box when a node has not been measured by the DOM yet. */
const FALLBACK_CHAR_W = 0.58;
const LINE_HEIGHT = 1.4;

// ── Rect helpers ───────────────────────────────────────────────

/**
 * Collapse a drag rectangle into positive width/height.
 *
 * Dragging up and to the left produces negative extents. Those used to
 * be stored as-is and normalised only at paint time, so every other
 * consumer — hit-testing, the properties panel, the lasso — saw a box
 * with negative size and silently missed it.
 */
export function normalizeRect(x: number, y: number, w: number, h: number): Rect {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    width: Math.abs(w),
    height: Math.abs(h),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function pointInRect(p: CanvasPoint, r: Rect, tolerance = 0): boolean {
  return (
    p.x >= r.x - tolerance &&
    p.x <= r.x + r.width + tolerance &&
    p.y >= r.y - tolerance &&
    p.y <= r.y + r.height + tolerance
  );
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

export function rectCenter(r: Rect): CanvasPoint {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Smallest rect containing all of `rects`, or null when empty. */
export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    if (r.x < x1) x1 = r.x;
    if (r.y < y1) y1 = r.y;
    if (r.x + r.width > x2) x2 = r.x + r.width;
    if (r.y + r.height > y2) y2 = r.y + r.height;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ── Rotation ───────────────────────────────────────────────────

/** Rotate `p` around `origin` by `deg` degrees (screen axes: y grows down). */
export function rotatePoint(p: CanvasPoint, origin: CanvasPoint, deg: number): CanvasPoint {
  if (!deg) return { x: p.x, y: p.y };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

/** Axis-aligned bounds of `r` after rotating it about its own centre. */
export function rotatedBounds(r: Rect, deg: number): Rect {
  if (!deg) return r;
  const c = rectCenter(r);
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ].map((p) => rotatePoint(p, c, deg));

  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x1 = Math.min(...xs), x2 = Math.max(...xs);
  const y1 = Math.min(...ys), y2 = Math.max(...ys);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ── Distance ───────────────────────────────────────────────────

/**
 * Shortest distance from `p` to the segment `a`-`b`.
 *
 * The eraser and stroke hit-testing both need this. Sampling only the
 * recorded vertices, as the old eraser did, means a fast stroke — whose
 * points can be 60 units apart — is unerasable anywhere except right on
 * a sample.
 */
export function pointSegmentDistance(p: CanvasPoint, a: CanvasPoint, b: CanvasPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(wx, wy);
  let t = (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** Shortest distance from `p` to a polyline. Infinity when empty. */
export function pointPolylineDistance(p: CanvasPoint, pts: CanvasPoint[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = pointSegmentDistance(p, pts[i - 1], pts[i]);
    if (d < best) best = d;
  }
  return best;
}

// ── Stroke simplification ──────────────────────────────────────

/**
 * Ramer-Douglas-Peucker, iterative so a 20k-point stroke cannot blow
 * the stack.
 *
 * The previous "keep every other point" decimation halved the vertex
 * count without regard for curvature — it rounded off corners and, on
 * an odd-length stroke, dropped the final point so the line visibly
 * fell short of where the pointer was released. RDP keeps both
 * endpoints by construction and spends its budget where the curve
 * actually bends.
 */
export function simplifyStrokeIndices(points: CanvasPoint[], epsilon = 0.7): number[] {
  const n = points.length;
  if (n <= 2 || epsilon <= 0) return points.map((_, i) => i);

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = pointSegmentDistance(points[i], points[start], points[end]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push(start, idx, idx, end);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Indices survive so a parallel track (per-point pressure) can follow. */
export function simplifyStroke(points: CanvasPoint[], epsilon = 0.7): CanvasPoint[] {
  return simplifyStrokeIndices(points, epsilon).map((i) => points[i]);
}

// ── Stroke smoothing ───────────────────────────────────────────

export interface QuadSegment {
  /** Control point — the recorded vertex the curve bends around. */
  cx: number;
  cy: number;
  /** End point — the midpoint between this vertex and the next. */
  x: number;
  y: number;
}

/**
 * Midpoint-quadratic smoothing.
 *
 * Each recorded vertex becomes a control point and each midpoint an
 * anchor, which turns a polyline into a C1-continuous curve without
 * needing to fit anything. Straight `lineTo` segments are why freehand
 * strokes read as visibly polygonal at high zoom.
 */
export function smoothSegments(pts: CanvasPoint[]): QuadSegment[] {
  const n = pts.length;
  if (n < 3) return [];
  const segs: QuadSegment[] = [];
  for (let i = 1; i < n - 1; i++) {
    segs.push({
      cx: pts[i].x,
      cy: pts[i].y,
      x: (pts[i].x + pts[i + 1].x) / 2,
      y: (pts[i].y + pts[i + 1].y) / 2,
    });
  }
  // Final segment lands exactly on the last recorded point.
  segs.push({ cx: pts[n - 2].x, cy: pts[n - 2].y, x: pts[n - 1].x, y: pts[n - 1].y });
  return segs;
}

/** SVG path data for a smoothed stroke. */
export function smoothPathD(pts: CanvasPoint[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (const s of smoothSegments(pts)) d += ` Q ${s.cx} ${s.cy} ${s.x} ${s.y}`;
  return d;
}

/** Trace a smoothed stroke into a 2D context. Caller owns beginPath/stroke. */
export function traceSmoothPolyline(
  ctx: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
         quadraticCurveTo(cx: number, cy: number, x: number, y: number): void },
  pts: CanvasPoint[],
): void {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) { ctx.lineTo(pts[1].x, pts[1].y); return; }
  for (const s of smoothSegments(pts)) ctx.quadraticCurveTo(s.cx, s.cy, s.x, s.y);
}

// ── Arrows ─────────────────────────────────────────────────────

/** Triangle points for an arrowhead sitting at `to`, pointing away from `from`. */
export function arrowHeadPoints(from: CanvasPoint, to: CanvasPoint, size: number): CanvasPoint[] {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: to.x, y: to.y },
    { x: to.x - size * Math.cos(ang - spread), y: to.y - size * Math.sin(ang - spread) },
    { x: to.x - size * Math.cos(ang + spread), y: to.y - size * Math.sin(ang + spread) },
  ];
}

/**
 * The two endpoints of a line/arrow element.
 *
 * Lines are stored as a rect so that one drag gesture, one set of
 * resize handles and one bounds routine serve every shape. The line
 * runs corner to corner, and a negative extent means it runs the other
 * way — which is exactly why lines must NOT be normalised on commit.
 */
export function lineEndpoints(el: CanvasElement): { from: CanvasPoint; to: CanvasPoint } {
  const x = el.x ?? 0;
  const y = el.y ?? 0;
  const w = el.width ?? 0;
  const h = el.height ?? 0;
  return { from: { x, y }, to: { x: x + w, y: y + h } };
}

// ── Text measurement ───────────────────────────────────────────

/**
 * Estimated text box, used only until the DOM reports the real one.
 *
 * The old eraser measured text with a monospace canvas font while the
 * note rendered in the inherited UI font inside a 300px wrap — so the
 * hit box never matched the pixels. Text elements now cache their
 * measured size on the element itself (see CanvasTextNotes), and this
 * is the fallback for a note that has not painted yet.
 */
export function estimateTextBox(text: string, fontSize: number, maxWidth = 300): Rect {
  const lines = (text || '').split('\n');
  let widest = 0;
  let rows = 0;
  for (const line of lines) {
    const w = line.length * fontSize * FALLBACK_CHAR_W;
    widest = Math.max(widest, Math.min(w, maxWidth));
    rows += Math.max(1, Math.ceil(w / maxWidth));
  }
  return { x: 0, y: 0, width: Math.max(widest, fontSize), height: rows * fontSize * LINE_HEIGHT };
}

// ── Element bounds ─────────────────────────────────────────────

/**
 * Axis-aligned bounds of any element, in canvas coordinates.
 *
 * Returns null only for an element with no geometry at all (an empty
 * stroke). Rotation is folded in, so callers get a box they can
 * intersect without knowing the element's angle.
 */
export function elementBounds(el: CanvasElement): Rect | null {
  switch (el.type) {
    case 'drawing': {
      const pts = el.points;
      if (!pts || pts.length === 0) return null;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const p of pts) {
        if (p.x < x1) x1 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.x > x2) x2 = p.x;
        if (p.y > y2) y2 = p.y;
      }
      // A stroke is as wide as its nib, so a perfectly straight
      // horizontal line still has height.
      const pad = Math.max(1, (el.strokeWidth || 2) / 2);
      return { x: x1 - pad, y: y1 - pad, width: x2 - x1 + pad * 2, height: y2 - y1 + pad * 2 };
    }

    case 'shape': {
      const r = normalizeRect(
        el.x ?? 0, el.y ?? 0,
        el.width ?? DEFAULT_SHAPE, el.height ?? DEFAULT_SHAPE,
      );
      return rotatedBounds(r, el.rotation ?? 0);
    }

    case 'text': {
      const box = el.width && el.height
        ? { x: 0, y: 0, width: el.width, height: el.height }
        : estimateTextBox(el.text || '', el.fontSize || 14, el.width || 300);
      const r = { x: el.x ?? 0, y: el.y ?? 0, width: box.width, height: box.height };
      return rotatedBounds(r, el.rotation ?? 0);
    }

    case 'image': {
      const r = {
        x: el.x ?? 0, y: el.y ?? 0,
        width: el.width || 320, height: el.height || 200,
      };
      return rotatedBounds(r, el.rotation ?? 0);
    }

    default:
      return null;
  }
}

/** Union of the bounds of several elements. */
export function elementsBounds(els: CanvasElement[]): Rect | null {
  const rects: Rect[] = [];
  for (const el of els) {
    const r = elementBounds(el);
    if (r) rects.push(r);
  }
  return unionRects(rects);
}

// ── Hit testing ────────────────────────────────────────────────

function ellipseHit(p: CanvasPoint, r: Rect, filled: boolean, tol: number): boolean {
  const c = rectCenter(r);
  const rx = r.width / 2;
  const ry = r.height / 2;
  if (rx <= 0 || ry <= 0) return false;

  const outerRx = rx + tol;
  const outerRy = ry + tol;
  const outer =
    ((p.x - c.x) * (p.x - c.x)) / (outerRx * outerRx) +
    ((p.y - c.y) * (p.y - c.y)) / (outerRy * outerRy);
  if (outer > 1) return false;
  if (filled) return true;

  const innerRx = Math.max(0.001, rx - tol);
  const innerRy = Math.max(0.001, ry - tol);
  const inner =
    ((p.x - c.x) * (p.x - c.x)) / (innerRx * innerRx) +
    ((p.y - c.y) * (p.y - c.y)) / (innerRy * innerRy);
  return inner >= 1;
}

function rectOutlineHit(p: CanvasPoint, r: Rect, filled: boolean, tol: number): boolean {
  if (!pointInRect(p, r, tol)) return false;
  if (filled) return true;
  // Inside the outer band but outside the inner one.
  const inner = inflate(r, -tol);
  if (inner.width <= 0 || inner.height <= 0) return true;
  return !pointInRect(p, inner);
}

function diamondHit(p: CanvasPoint, r: Rect, filled: boolean, tol: number): boolean {
  const c = rectCenter(r);
  const rx = r.width / 2;
  const ry = r.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  // |dx|/rx + |dy|/ry <= 1 describes the diamond; convert the tolerance
  // into that normalised space using the smaller half-extent.
  const band = tol / Math.min(rx, ry);
  const v = Math.abs(p.x - c.x) / rx + Math.abs(p.y - c.y) / ry;
  if (v > 1 + band) return false;
  if (filled) return true;
  return v >= 1 - band;
}

/**
 * Does `p` (canvas coords) touch `el`?
 *
 * `tolerance` is in canvas units — callers scale a screen-pixel slop by
 * 1/zoom so grabbing an outline stays equally easy at any zoom.
 */
export function hitTestElement(p: CanvasPoint, el: CanvasElement, tolerance = 6): boolean {
  const filled = !!el.fillColor && el.fillColor !== 'transparent' && el.fillColor !== 'none';

  switch (el.type) {
    case 'drawing': {
      if (!el.points || el.points.length === 0) return false;
      const reach = Math.max(tolerance, (el.strokeWidth || 2) / 2 + 2);
      return pointPolylineDistance(p, el.points) <= reach;
    }

    case 'shape': {
      const r = normalizeRect(
        el.x ?? 0, el.y ?? 0,
        el.width ?? DEFAULT_SHAPE, el.height ?? DEFAULT_SHAPE,
      );
      const tol = Math.max(tolerance, (el.strokeWidth || 2) / 2 + 2);

      // Lines and arrows are not boxes; test them before un-rotating,
      // since their geometry already carries direction.
      if (el.shapeType === 'line' || el.shapeType === 'arrow') {
        const { from, to } = lineEndpoints(el);
        const rot = el.rotation ?? 0;
        if (rot) {
          const c = rectCenter(r);
          const q = rotatePoint(p, c, -rot);
          return pointSegmentDistance(q, from, to) <= tol;
        }
        return pointSegmentDistance(p, from, to) <= tol;
      }

      // Everything else: un-rotate the probe, then test axis-aligned.
      const rot = el.rotation ?? 0;
      const q = rot ? rotatePoint(p, rectCenter(r), -rot) : p;

      switch (el.shapeType) {
        case 'ellipse': return ellipseHit(q, r, filled, tol);
        case 'diamond': return diamondHit(q, r, filled, tol);
        // A frame is a container: clicking its interior should not grab
        // it, or it swallows every click over the region it covers.
        case 'frame': return rectOutlineHit(q, r, false, Math.max(tol, 8));
        default: return rectOutlineHit(q, r, filled, tol);
      }
    }

    case 'text':
    case 'image': {
      const r = elementBounds(el);
      if (!r) return false;
      const rot = el.rotation ?? 0;
      if (!rot) return pointInRect(p, r, tolerance);
      // elementBounds already returned the rotated AABB; rebuild the
      // unrotated box to test precisely.
      const base = el.type === 'image'
        ? { x: el.x ?? 0, y: el.y ?? 0, width: el.width || 320, height: el.height || 200 }
        : { x: el.x ?? 0, y: el.y ?? 0,
            width: el.width || estimateTextBox(el.text || '', el.fontSize || 14).width,
            height: el.height || estimateTextBox(el.text || '', el.fontSize || 14).height };
      return pointInRect(rotatePoint(p, rectCenter(base), -rot), base, tolerance);
    }

    default:
      return false;
  }
}

/** Topmost element under `p`, honouring paint order. Null when none. */
export function topmostAt(
  p: CanvasPoint,
  elements: CanvasElement[],
  tolerance = 6,
): CanvasElement | null {
  const ordered = sortByPaintOrder(elements);
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hitTestElement(p, ordered[i], tolerance)) return ordered[i];
  }
  return null;
}

/** Elements whose bounds intersect the lasso rect. */
export function elementsInRect(elements: CanvasElement[], box: Rect): CanvasElement[] {
  return elements.filter((el) => {
    const b = elementBounds(el);
    return b ? rectsIntersect(b, box) : false;
  });
}

// ── Paint order ────────────────────────────────────────────────

/**
 * Stable sort by zIndex.
 *
 * zIndex was written on every element and then ignored by every
 * renderer, which paints in array order — so "bring to front" had
 * nowhere to express itself.
 */
export function sortByPaintOrder(elements: CanvasElement[]): CanvasElement[] {
  return elements
    .map((el, i) => ({ el, i }))
    .sort((a, b) => (a.el.zIndex - b.el.zIndex) || (a.i - b.i))
    .map((e) => e.el);
}

// ── Drag rectangles ────────────────────────────────────────────

export interface DragRectOptions {
  /** Shift: lock to a square (or a 45-degree line). */
  square?: boolean;
  /** Alt: treat the anchor as the centre rather than a corner. */
  fromCenter?: boolean;
  /** Snap increment in canvas units; 0 disables. */
  grid?: number;
}

function snap(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v;
}

/**
 * The rect described by dragging from `start` to `current`.
 *
 * Returned width/height may be negative — that is meaningful for lines
 * and arrows, which run from the anchor to the pointer. Box shapes call
 * `normalizeRect` when they commit.
 */
export function dragRect(
  start: CanvasPoint,
  current: CanvasPoint,
  opts: DragRectOptions = {},
): Rect {
  const grid = opts.grid ?? 0;
  const sx = snap(start.x, grid);
  const sy = snap(start.y, grid);
  let cx = snap(current.x, grid);
  let cy = snap(current.y, grid);

  if (opts.square) {
    const dx = cx - sx;
    const dy = cy - sy;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    cx = sx + (dx < 0 ? -size : size);
    cy = sy + (dy < 0 ? -size : size);
  }

  if (opts.fromCenter) {
    const dx = cx - sx;
    const dy = cy - sy;
    return { x: sx - dx, y: sy - dy, width: dx * 2, height: dy * 2 };
  }

  return { x: sx, y: sy, width: cx - sx, height: cy - sy };
}

// ── Resize ─────────────────────────────────────────────────────

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

/** The eight handle positions for a rect, in canvas coordinates. */
export function handlePositions(r: Rect): Record<Handle, CanvasPoint> {
  const mx = r.x + r.width / 2;
  const my = r.y + r.height / 2;
  return {
    nw: { x: r.x, y: r.y },
    n:  { x: mx, y: r.y },
    ne: { x: r.x + r.width, y: r.y },
    e:  { x: r.x + r.width, y: my },
    se: { x: r.x + r.width, y: r.y + r.height },
    s:  { x: mx, y: r.y + r.height },
    sw: { x: r.x, y: r.y + r.height },
    w:  { x: r.x, y: my },
  };
}

export interface ResizeOptions {
  /** Shift: keep the original aspect ratio. */
  aspect?: boolean;
  /** Alt: resize about the centre. */
  fromCenter?: boolean;
  minWidth?: number;
  minHeight?: number;
}

/**
 * Apply a resize drag to a rect.
 *
 * Dragging a north or west handle moves the origin as well as the size
 * so the opposite edge stays put — the thing every hand-rolled resize
 * in this codebase got wrong at least once.
 */
export function resizeRect(
  start: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  opts: ResizeOptions = {},
): Rect {
  const minW = opts.minWidth ?? 8;
  const minH = opts.minHeight ?? 8;

  let { x, y, width: w, height: h } = start;

  if (handle.includes('e')) w = start.width + dx;
  if (handle.includes('w')) w = start.width - dx;
  if (handle.includes('s')) h = start.height + dy;
  if (handle.includes('n')) h = start.height - dy;

  if (opts.aspect && start.width > 0 && start.height > 0) {
    const ratio = start.width / start.height;
    // Edge handles drive the one axis they own; corners take the
    // larger change so the pointer leads rather than lags.
    if (handle === 'n' || handle === 's') {
      w = h * ratio;
    } else if (handle === 'e' || handle === 'w') {
      h = w / ratio;
    } else if (Math.abs(w - start.width) > Math.abs(h - start.height)) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
  }

  w = Math.max(minW, w);
  h = Math.max(minH, h);

  if (opts.fromCenter) {
    const c = rectCenter(start);
    return { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h };
  }

  if (handle.includes('w')) x = start.x + start.width - w;
  if (handle.includes('n')) y = start.y + start.height - h;

  return { x, y, width: w, height: h };
}

// ── Bounds-to-bounds transforms ────────────────────────────────

/**
 * The patch that moves an element from occupying `from` to occupying
 * `to`.
 *
 * One routine drives single-element resize, multi-select resize and
 * nudging, so a selection of a stroke, a rectangle and an image all
 * scale together instead of each type needing its own maths. Strokes
 * carry their geometry in `points`, which is why a patch — not a plain
 * x/y/width/height write — is the right unit.
 */
export function boundsTransformPatch(
  el: CanvasElement,
  from: Rect,
  to: Rect,
): Partial<CanvasElement> {
  const sx = from.width === 0 ? 1 : to.width / from.width;
  const sy = from.height === 0 ? 1 : to.height / from.height;
  const mapX = (x: number) => to.x + (x - from.x) * sx;
  const mapY = (y: number) => to.y + (y - from.y) * sy;

  if (el.type === 'drawing') {
    if (!el.points || el.points.length === 0) return {};
    return {
      points: el.points.map((p) => ({ x: mapX(p.x), y: mapY(p.y) })),
      // Keep the nib visually proportional so a scaled-up sketch does
      // not turn into hairlines.
      strokeWidth: Math.max(0.5, (el.strokeWidth || 2) * Math.sqrt(Math.abs(sx * sy))),
      widths: el.widths?.map((w) => Math.max(0.2, w * Math.sqrt(Math.abs(sx * sy)))),
    };
  }

  const x = el.x ?? 0;
  const y = el.y ?? 0;
  const w = el.width ?? 0;
  const h = el.height ?? 0;

  const patch: Partial<CanvasElement> = {
    x: mapX(x),
    y: mapY(y),
    width: w * sx,
    height: h * sy,
  };

  // Text has no intrinsic box until it paints; scaling the glyphs is
  // what the user means by dragging its corner.
  if (el.type === 'text' && el.fontSize) {
    patch.fontSize = Math.max(6, Math.round(el.fontSize * Math.sqrt(Math.abs(sx * sy))));
  }

  return patch;
}

// ── Viewport transforms ────────────────────────────────────────

export interface Viewport {
  pan: { x: number; y: number };
  zoom: number;
}

/** Screen point (relative to the canvas element) to canvas coordinates. */
export function screenToCanvas(sx: number, sy: number, v: Viewport): CanvasPoint {
  return { x: (sx - v.pan.x) / v.zoom, y: (sy - v.pan.y) / v.zoom };
}

/** Canvas coordinates back to screen, relative to the canvas element. */
export function canvasToScreen(cx: number, cy: number, v: Viewport): CanvasPoint {
  return { x: cx * v.zoom + v.pan.x, y: cy * v.zoom + v.pan.y };
}
