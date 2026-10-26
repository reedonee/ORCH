// Checks for canvas geometry — bounds, hit-testing, simplification and
// transforms.
//
// Most of these exist because a specific bug shipped:
//   - the lasso treated every freehand stroke as a 40x20 box at the
//     origin, so it grabbed all of them or none of them;
//   - the eraser hit-tested a stroke by sampling its stored vertices,
//     which after simplification sit tens of units apart;
//   - shapes dragged up-and-left were stored with negative extents that
//     every other consumer silently failed on;
//   - stroke simplification kept every other point, which dropped the
//     final one so a line fell short of where the pen lifted;
//   - resize moved the origin and the size together on north/west
//     handles, or forgot to, depending on which copy of the code ran.

import {
  arrowHeadPoints, boundsTransformPatch, canvasToScreen, dragRect,
  elementBounds, elementsBounds, elementsInRect, estimateTextBox,
  handlePositions, hitTestElement, inflate, lineEndpoints, normalizeRect,
  pointInRect, pointPolylineDistance, pointSegmentDistance, rectCenter,
  rectsIntersect, resizeRect, rotatePoint, rotatedBounds, screenToCanvas,
  simplifyStroke, simplifyStrokeIndices, smoothPathD, smoothSegments,
  sortByPaintOrder, topmostAt, unionRects,
} from '../src/lib/canvas-geometry.ts';
import type { CanvasElement } from '../src/stores/useCanvasStore.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) pass++;
  else { fail++; console.log(`FAIL ${l}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const ok = (l: string, c: boolean) => { if (c) pass++; else { fail++; console.log(`FAIL ${l}`); } };
const near = (l: string, got: number, want: number, tol = 1e-6) => {
  if (Math.abs(got - want) <= tol) pass++;
  else { fail++; console.log(`FAIL ${l}\n  got:  ${got}\n  want: ${want} (+-${tol})`); }
};

const base = { strokeColor: '#fff', strokeWidth: 2, zIndex: 0, createdAt: 0 };

function stroke(pts: Array<[number, number]>, extra: Partial<CanvasElement> = {}): CanvasElement {
  return { ...base, id: 's', type: 'drawing', points: pts.map(([x, y]) => ({ x, y })), ...extra };
}
function shape(shapeType: CanvasElement['shapeType'], x: number, y: number, w: number, h: number,
               extra: Partial<CanvasElement> = {}): CanvasElement {
  return { ...base, id: 'sh', type: 'shape', shapeType, x, y, width: w, height: h, ...extra };
}

// ── Rect helpers ────────────────────────────────────────────────
{
  const r = normalizeRect(100, 100, -40, -20);
  eq('normalizeRect x', r.x, 60);
  eq('normalizeRect y', r.y, 80);
  eq('normalizeRect width', r.width, 40);
  eq('normalizeRect height', r.height, 20);

  const p = normalizeRect(5, 5, 10, 10);
  eq('normalizeRect leaves positive alone', JSON.stringify(p), JSON.stringify({ x: 5, y: 5, width: 10, height: 10 }));

  ok('rectsIntersect overlapping', rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }));
  ok('rectsIntersect disjoint', !rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }));
  ok('rectsIntersect touching edges is not overlap', !rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }));

  ok('pointInRect inside', pointInRect({ x: 5, y: 5 }, { x: 0, y: 0, width: 10, height: 10 }));
  ok('pointInRect outside', !pointInRect({ x: 15, y: 5 }, { x: 0, y: 0, width: 10, height: 10 }));
  ok('pointInRect tolerance', pointInRect({ x: 12, y: 5 }, { x: 0, y: 0, width: 10, height: 10 }, 3));

  const inf = inflate({ x: 10, y: 10, width: 10, height: 10 }, 2);
  eq('inflate x', inf.x, 8);
  eq('inflate width', inf.width, 14);

  const c = rectCenter({ x: 0, y: 0, width: 10, height: 20 });
  eq('rectCenter x', c.x, 5);
  eq('rectCenter y', c.y, 10);

  eq('unionRects empty', unionRects([]), null);
  const u = unionRects([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 }])!;
  eq('unionRects width', u.width, 30);
  eq('unionRects y', u.y, 0);
  eq('unionRects height', u.height, 15);
}

// ── Rotation ────────────────────────────────────────────────────
{
  const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
  near('rotatePoint 90 x', p.x, 0, 1e-9);
  near('rotatePoint 90 y', p.y, 10, 1e-9);

  const same = rotatePoint({ x: 3, y: 4 }, { x: 0, y: 0 }, 0);
  eq('rotatePoint 0 is identity', `${same.x},${same.y}`, '3,4');

  // A square rotated 45 degrees has a bounding box sqrt(2) times wider.
  const rb = rotatedBounds({ x: 0, y: 0, width: 10, height: 10 }, 45);
  near('rotatedBounds 45 width', rb.width, 10 * Math.SQRT2, 1e-9);
  near('rotatedBounds keeps centre', rectCenter(rb).x, 5, 1e-9);

  const rb90 = rotatedBounds({ x: 0, y: 0, width: 20, height: 10 }, 90);
  near('rotatedBounds 90 swaps extents', rb90.width, 10, 1e-9);
  near('rotatedBounds 90 height', rb90.height, 20, 1e-9);
}

// ── Distance ────────────────────────────────────────────────────
{
  near('pointSegmentDistance perpendicular', pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  near('pointSegmentDistance past the end clamps', pointSegmentDistance({ x: 14, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 4);
  near('pointSegmentDistance before the start clamps', pointSegmentDistance({ x: -3, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  near('pointSegmentDistance degenerate segment', pointSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);

  eq('pointPolylineDistance empty', pointPolylineDistance({ x: 0, y: 0 }, []), Infinity);
  near('pointPolylineDistance single point', pointPolylineDistance({ x: 3, y: 4 }, [{ x: 0, y: 0 }]), 5);
  near(
    'pointPolylineDistance picks the nearest segment',
    pointPolylineDistance({ x: 50, y: 2 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]),
    2,
  );
}

// ── Simplification ──────────────────────────────────────────────
{
  // Straight run: everything between the endpoints is redundant.
  const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
  const simp = simplifyStroke(line, 0.5);
  eq('collinear run collapses to its endpoints', simp.length, 2);
  eq('first point kept', simp[0].x, 0);
  eq('last point kept', simp[1].x, 49);

  // The regression: the old decimation dropped the final point on an
  // odd-length stroke, so a stroke visibly fell short of the pen lift.
  const odd = [{ x: 0, y: 0 }, { x: 5, y: 9 }, { x: 10, y: 0 }, { x: 15, y: 9 }, { x: 20, y: 0 }];
  const s2 = simplifyStroke(odd, 0.5);
  eq('endpoint survives an odd-length stroke', s2[s2.length - 1].x, 20);
  ok('corners survive', s2.length === 5);

  eq('two points pass through', simplifyStroke([{ x: 0, y: 0 }, { x: 1, y: 1 }], 5).length, 2);
  eq('one point passes through', simplifyStroke([{ x: 0, y: 0 }], 5).length, 1);
  eq('empty passes through', simplifyStroke([], 5).length, 0);
  eq('epsilon 0 keeps everything', simplifyStroke(line, 0).length, 50);

  // A larger epsilon may never keep more points than a smaller one.
  const zig = Array.from({ length: 60 }, (_, i) => ({ x: i, y: (i % 2) * 3 }));
  ok('larger epsilon is never less aggressive',
    simplifyStroke(zig, 4).length <= simplifyStroke(zig, 0.5).length);

  // Indices and points must describe the same subset — the pressure
  // track is carried through by index.
  const idx = simplifyStrokeIndices(odd, 0.5);
  const viaIdx = idx.map((i) => odd[i]);
  eq('indices agree with points', JSON.stringify(viaIdx), JSON.stringify(s2));
  ok('indices are strictly increasing', idx.every((v, i) => i === 0 || v > idx[i - 1]));

  // 20k points must not blow the stack (the reason RDP is iterative).
  const huge = Array.from({ length: 20000 }, (_, i) => ({ x: i, y: Math.sin(i / 30) * 40 }));
  ok('handles a 20k-point stroke', simplifyStroke(huge, 1).length > 2);
}

// ── Smoothing ───────────────────────────────────────────────────
{
  eq('smoothSegments needs three points', smoothSegments([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length, 0);

  const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }];
  const segs = smoothSegments(pts);
  const last = segs[segs.length - 1];
  // The curve must finish exactly where the pen did, not at a midpoint.
  eq('smoothing ends on the final point x', last.x, 30);
  eq('smoothing ends on the final point y', last.y, 10);

  eq('smoothPathD empty', smoothPathD([]), '');
  eq('smoothPathD single', smoothPathD([{ x: 1, y: 2 }]), 'M 1 2');
  eq('smoothPathD pair is a line', smoothPathD([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 'M 0 0 L 5 5');
  ok('smoothPathD uses quadratics', smoothPathD(pts).includes('Q'));
}

// ── Arrowheads ──────────────────────────────────────────────────
{
  const tri = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
  eq('arrowhead tip sits at the target', `${tri[0].x},${tri[0].y}`, '100,0');
  ok('arrowhead barbs trail behind the tip', tri[1].x < 100 && tri[2].x < 100);
  near('arrowhead is symmetric about the shaft', tri[1].y + tri[2].y, 0, 1e-9);

  const el = shape('line', 10, 20, -30, -40);
  const { from, to } = lineEndpoints(el);
  eq('line start', `${from.x},${from.y}`, '10,20');
  eq('line end follows the sign of the extents', `${to.x},${to.y}`, '-20,-20');
}

// ── Element bounds ──────────────────────────────────────────────
{
  const s = stroke([[100, 100], [140, 180], [90, 130]], { strokeWidth: 4 });
  const b = elementBounds(s)!;
  // Padded by half the nib, so a horizontal stroke still has height.
  eq('stroke bounds x', b.x, 88);
  eq('stroke bounds y', b.y, 98);
  eq('stroke bounds width', b.width, 54);
  eq('stroke bounds height', b.height, 84);

  eq('empty stroke has no bounds', elementBounds(stroke([])), null);

  const flat = elementBounds(stroke([[0, 50], [100, 50]], { strokeWidth: 6 }))!;
  eq('a flat stroke still has height', flat.height, 6);

  // Negative extents normalise before bounding.
  const neg = elementBounds(shape('rect', 100, 100, -40, -20))!;
  eq('negative shape bounds x', neg.x, 60);
  eq('negative shape bounds width', neg.width, 40);

  const rot = elementBounds(shape('rect', 0, 0, 10, 10, { rotation: 45 }))!;
  near('rotated shape bounds widen', rot.width, 10 * Math.SQRT2, 1e-9);

  const img: CanvasElement = { ...base, id: 'i', type: 'image', x: 5, y: 6, width: 100, height: 50 };
  const ib = elementBounds(img)!;
  eq('image bounds width', ib.width, 100);

  const imgDefault = elementBounds({ ...base, id: 'i2', type: 'image' })!;
  eq('image falls back to a default box', imgDefault.width, 320);

  const txt: CanvasElement = { ...base, id: 't', type: 'text', x: 0, y: 0, text: 'hello', fontSize: 20, width: 200, height: 40 };
  eq('measured text uses its cached box', elementBounds(txt)!.height, 40);

  const unmeasured: CanvasElement = { ...base, id: 't2', type: 'text', x: 0, y: 0, text: 'hello', fontSize: 20 };
  ok('unmeasured text falls back to an estimate', elementBounds(unmeasured)!.height > 0);

  const est = estimateTextBox('ab\ncd', 10, 300);
  ok('estimate grows with line count', est.height >= 2 * 10);
  ok('estimate is never zero-width', estimateTextBox('', 12).width > 0);

  eq('elementsBounds of nothing', elementsBounds([]), null);
  const many = elementsBounds([shape('rect', 0, 0, 10, 10), shape('rect', 100, 0, 10, 10)])!;
  eq('elementsBounds spans the set', many.width, 110);
}

// ── Hit testing ─────────────────────────────────────────────────
{
  // THE eraser regression: after simplification, adjacent vertices sit
  // far apart. A point on the line between two of them must register.
  const s = stroke([[0, 0], [200, 0]]);
  ok('stroke hit midway between vertices', hitTestElement({ x: 100, y: 1 }, s, 6));
  ok('stroke miss well off the line', !hitTestElement({ x: 100, y: 40 }, s, 6));
  ok('stroke hit respects tolerance', hitTestElement({ x: 100, y: 20 }, s, 25));
  ok('empty stroke is never hit', !hitTestElement({ x: 0, y: 0 }, stroke([]), 10));

  // An unfilled rect is grabbed by its outline, not its interior —
  // otherwise a big rectangle swallows every click over its area.
  const r = shape('rect', 0, 0, 100, 100);
  ok('unfilled rect hit on the edge', hitTestElement({ x: 0, y: 50 }, r, 4));
  ok('unfilled rect miss in the middle', !hitTestElement({ x: 50, y: 50 }, r, 4));

  const filled = shape('rect', 0, 0, 100, 100, { fillColor: '#ff000030' });
  ok('filled rect hit in the middle', hitTestElement({ x: 50, y: 50 }, filled, 4));

  // 'transparent' and 'none' must not read as a fill.
  ok('fillColor transparent is not filled',
    !hitTestElement({ x: 50, y: 50 }, shape('rect', 0, 0, 100, 100, { fillColor: 'transparent' }), 4));
  ok('fillColor none is not filled',
    !hitTestElement({ x: 50, y: 50 }, shape('rect', 0, 0, 100, 100, { fillColor: 'none' }), 4));

  // A frame is a container: never grabbed by its interior, even filled.
  const fr = shape('frame', 0, 0, 400, 300, { fillColor: '#00ff0040' });
  ok('frame miss in the middle', !hitTestElement({ x: 200, y: 150 }, fr, 4));
  ok('frame hit on the edge', hitTestElement({ x: 0, y: 150 }, fr, 4));

  const e = shape('ellipse', 0, 0, 100, 100);
  ok('ellipse hit on the rim', hitTestElement({ x: 100, y: 50 }, e, 4));
  ok('ellipse miss inside', !hitTestElement({ x: 50, y: 50 }, e, 4));
  // The corner of the bounding box is outside the ellipse itself.
  ok('ellipse miss at the bounding-box corner', !hitTestElement({ x: 0, y: 0 }, e, 4));

  const d = shape('diamond', 0, 0, 100, 100);
  ok('diamond hit on a vertex', hitTestElement({ x: 50, y: 0 }, d, 5));
  ok('diamond miss at the bounding-box corner', !hitTestElement({ x: 2, y: 2 }, d, 4));

  const ln = shape('line', 0, 0, 100, 100);
  ok('line hit along the diagonal', hitTestElement({ x: 50, y: 50 }, ln, 4));
  ok('line miss off the diagonal', !hitTestElement({ x: 50, y: 90 }, ln, 4));

  const ar = shape('arrow', 0, 0, 100, 0);
  ok('arrow hit along the shaft', hitTestElement({ x: 50, y: 1 }, ar, 4));

  // Rotation. The rect is 100x20 about centre (50,10); at 90 degrees
  // its west edge midpoint lands at (50,-40). The point that WAS on an
  // edge before rotating, (50,0), is now interior — and an unfilled
  // shape is grabbed by its outline only, so that one must miss.
  const rr = shape('rect', 0, 0, 100, 20, { rotation: 90 });
  ok('rotated rect hit on the rotated edge', hitTestElement({ x: 50, y: -40 }, rr, 5));
  ok('rotated rect miss where the edge used to be', !hitTestElement({ x: 50, y: 0 }, rr, 5));

  const img: CanvasElement = { ...base, id: 'i', type: 'image', x: 0, y: 0, width: 100, height: 100 };
  ok('image hit anywhere inside', hitTestElement({ x: 50, y: 50 }, img, 0));
  ok('image miss outside', !hitTestElement({ x: 150, y: 50 }, img, 0));

  const rotImg: CanvasElement = { ...img, rotation: 90 };
  ok('rotated image hit uses its own frame', hitTestElement({ x: 50, y: 50 }, rotImg, 0));
}

// ── Paint order ─────────────────────────────────────────────────
{
  const a = { ...shape('rect', 0, 0, 10, 10), id: 'a', zIndex: 5 };
  const b = { ...shape('rect', 0, 0, 10, 10), id: 'b', zIndex: 1 };
  const c = { ...shape('rect', 0, 0, 10, 10), id: 'c', zIndex: 5 };
  const order = sortByPaintOrder([a, b, c]).map((el) => el.id);
  eq('sorts by zIndex, ties keep array order', order.join(''), 'bac');

  // Topmost wins: two overlapping outlines, the higher zIndex is picked.
  const lo = { ...shape('rect', 0, 0, 100, 100, { fillColor: '#fff' }), id: 'lo', zIndex: 0 };
  const hi = { ...shape('rect', 0, 0, 100, 100, { fillColor: '#fff' }), id: 'hi', zIndex: 9 };
  eq('topmostAt honours zIndex', topmostAt({ x: 50, y: 50 }, [lo, hi], 4)?.id, 'hi');
  eq('topmostAt returns null on a miss', topmostAt({ x: 900, y: 900 }, [lo, hi], 4), null);
}

// ── Lasso ───────────────────────────────────────────────────────
{
  // THE lasso regression. A stroke has no x/y/width/height, so reading
  // those fields put every stroke in a 40x20 box at the origin.
  const far = stroke([[500, 500], [560, 540]]);
  const boxAtOrigin = { x: 0, y: 0, width: 60, height: 40 };
  eq('a distant stroke is not caught by a box at the origin',
    elementsInRect([far], boxAtOrigin).length, 0);

  const boxOverIt = { x: 480, y: 480, width: 120, height: 120 };
  eq('a stroke is caught by a box over it',
    elementsInRect([far], boxOverIt).length, 1);

  // Partial overlap counts — a lasso does not require containment.
  eq('partial overlap selects',
    elementsInRect([shape('rect', 0, 0, 100, 100)], { x: 90, y: 90, width: 50, height: 50 }).length, 1);
  eq('no overlap does not select',
    elementsInRect([shape('rect', 0, 0, 100, 100)], { x: 200, y: 200, width: 50, height: 50 }).length, 0);
  eq('elements with no geometry are skipped',
    elementsInRect([stroke([])], { x: -1000, y: -1000, width: 5000, height: 5000 }).length, 0);
}

// ── Drag rectangles ─────────────────────────────────────────────
{
  const r = dragRect({ x: 100, y: 100 }, { x: 60, y: 80 });
  eq('drag up-left keeps negative extents for direction', r.width, -40);
  eq('drag up-left height', r.height, -20);

  const sq = dragRect({ x: 0, y: 0 }, { x: 100, y: 30 }, { square: true });
  eq('shift squares off the larger extent', sq.width, 100);
  eq('shift squares height too', sq.height, 100);

  const sqNeg = dragRect({ x: 0, y: 0 }, { x: -100, y: 30 }, { square: true });
  eq('squaring preserves the drag direction', sqNeg.width, -100);
  eq('squaring preserves the other direction', sqNeg.height, 100);

  const fc = dragRect({ x: 50, y: 50 }, { x: 70, y: 60 }, { fromCenter: true });
  eq('alt centres the rect on the anchor x', fc.x, 30);
  eq('alt centres the rect on the anchor width', fc.width, 40);
  eq('alt centres the rect on the anchor height', fc.height, 20);

  const sn = dragRect({ x: 3, y: 3 }, { x: 47, y: 47 }, { grid: 10 });
  eq('grid snaps the anchor', sn.x, 0);
  eq('grid snaps the extent', sn.width, 50);
}

// ── Resize ──────────────────────────────────────────────────────
{
  const start = { x: 100, y: 100, width: 200, height: 100 };

  const east = resizeRect(start, 'e', 50, 0);
  eq('east grows width', east.width, 250);
  eq('east leaves the origin alone', east.x, 100);

  // The classic bug: dragging a west handle must move the origin AND
  // shrink the box, so the east edge does not travel.
  const west = resizeRect(start, 'w', 50, 0);
  eq('west moves the origin', west.x, 150);
  eq('west shrinks the width', west.width, 150);
  eq('west keeps the far edge put', west.x + west.width, 300);

  const north = resizeRect(start, 'n', 0, 30);
  eq('north moves the origin', north.y, 130);
  eq('north keeps the bottom put', north.y + north.height, 200);

  const nw = resizeRect(start, 'nw', 20, 10);
  eq('nw keeps the far corner x', nw.x + nw.width, 300);
  eq('nw keeps the far corner y', nw.y + nw.height, 200);

  const min = resizeRect(start, 'e', -1000, 0, { minWidth: 8 });
  eq('minimum width is enforced', min.width, 8);
  const minW = resizeRect(start, 'w', 1000, 0, { minWidth: 8 });
  eq('minimum width still pins the far edge', minW.x + minW.width, 300);

  const asp = resizeRect(start, 'se', 200, 0, { aspect: true });
  near('aspect keeps the ratio', asp.width / asp.height, 2, 1e-9);

  const aspEdge = resizeRect(start, 's', 0, 50, { aspect: true });
  near('aspect from an edge handle drives the other axis', aspEdge.width / aspEdge.height, 2, 1e-9);

  const ctr = resizeRect(start, 'e', 100, 0, { fromCenter: true });
  near('fromCenter keeps the centre', rectCenter(ctr).x, rectCenter(start).x, 1e-9);
  eq('fromCenter still grows', ctr.width, 300);

  const hp = handlePositions({ x: 0, y: 0, width: 100, height: 50 });
  eq('handle nw', `${hp.nw.x},${hp.nw.y}`, '0,0');
  eq('handle se', `${hp.se.x},${hp.se.y}`, '100,50');
  eq('handle n is centred', `${hp.n.x},${hp.n.y}`, '50,0');
  eq('handle w is centred', `${hp.w.x},${hp.w.y}`, '0,25');
  eq('eight handles', Object.keys(hp).length, 8);
}

// ── Bounds transforms ───────────────────────────────────────────
{
  const from = { x: 0, y: 0, width: 100, height: 100 };
  const to = { x: 0, y: 0, width: 200, height: 100 };

  // A stroke carries its geometry in points, so a patch — not an
  // x/y/width/height write — is the only thing that can move it.
  const s = stroke([[0, 0], [50, 50], [100, 100]]);
  const patch = boundsTransformPatch(s, from, to);
  eq('stroke points scale on x', patch.points![2].x, 200);
  eq('stroke points hold on y', patch.points![2].y, 100);
  ok('stroke nib scales with the area', (patch.strokeWidth ?? 0) > 2);

  const moved = boundsTransformPatch(s, from, { x: 30, y: 40, width: 100, height: 100 });
  eq('a pure translation moves points x', moved.points![0].x, 30);
  eq('a pure translation moves points y', moved.points![0].y, 40);

  const r = shape('rect', 10, 10, 20, 20);
  const rp = boundsTransformPatch(r, from, to);
  eq('shape x maps', rp.x, 20);
  eq('shape width scales', rp.width, 40);
  eq('shape y is untouched by an x-only scale', rp.y, 10);

  const t: CanvasElement = { ...base, id: 't', type: 'text', x: 0, y: 0, width: 100, height: 20, fontSize: 10, text: 'a' };
  const tp = boundsTransformPatch(t, from, { x: 0, y: 0, width: 200, height: 200 });
  eq('text scales its font', tp.fontSize, 20);

  const degenerate = boundsTransformPatch(r, { x: 0, y: 0, width: 0, height: 0 }, to);
  ok('a zero-size source does not produce NaN',
    Number.isFinite(degenerate.x!) && Number.isFinite(degenerate.width!));

  eq('a stroke with no points yields an empty patch',
    JSON.stringify(boundsTransformPatch(stroke([]), from, to)), '{}');
}

// ── Viewport ────────────────────────────────────────────────────
{
  const v = { pan: { x: 100, y: 50 }, zoom: 2 };
  const c = screenToCanvas(300, 150, v);
  eq('screenToCanvas x', c.x, 100);
  eq('screenToCanvas y', c.y, 50);

  const s = canvasToScreen(c.x, c.y, v);
  eq('canvasToScreen round-trips x', s.x, 300);
  eq('canvasToScreen round-trips y', s.y, 150);
}

console.log(`\ncanvas-geometry pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
