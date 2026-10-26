// Checks for the canvas store — history grouping, batch operations and
// stroke commit.
//
// The bug this suite exists for: every mutating action snapshotted the
// element list before touching it, and a drag calls updateElement on
// every mousemove. One shape drag pushed a few hundred undo entries, so
// Ctrl+Z crawled the shape back a pixel at a time and the real previous
// state was never reachable. Deleting a multi-selection had the mirror
// problem: one entry per element.
//
// Run with the TS extension resolver, since the store imports a sibling
// module the way Vite resolves it:
//   node --experimental-strip-types --import ./tests/ts-resolve-hook.mjs

import { useCanvasStore, makeElementId } from '../src/stores/useCanvasStore.ts';
import type { CanvasElement } from '../src/stores/useCanvasStore.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) pass++;
  else { fail++; console.log(`FAIL ${l}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const ok = (l: string, c: boolean) => { if (c) pass++; else { fail++; console.log(`FAIL ${l}`); } };

const S = () => useCanvasStore.getState();
const reset = () => S().resetCanvas();

function rect(id: string, x = 0, y = 0, extra: Partial<CanvasElement> = {}): CanvasElement {
  return {
    id, type: 'shape', shapeType: 'rect',
    x, y, width: 50, height: 40,
    strokeColor: '#fff', strokeWidth: 2,
    zIndex: 0, createdAt: 0, ...extra,
  };
}
function draw(id: string, pts: Array<[number, number]>): CanvasElement {
  return {
    id, type: 'drawing', points: pts.map(([x, y]) => ({ x, y })),
    strokeColor: '#fff', strokeWidth: 2, zIndex: 0, createdAt: 0,
  };
}

// ── One gesture, one undo step ──────────────────────────────────
{
  reset();
  S().addElement(rect('a', 10, 10));
  const depthAfterAdd = S().undoStack.length;

  // Exactly what a drag does: open, patch per mousemove, close.
  S().beginInteraction();
  for (let i = 1; i <= 200; i++) S().updateElement('a', { x: 10 + i, y: 10 + i });
  S().endInteraction();

  eq('a 200-move drag adds exactly one undo entry', S().undoStack.length, depthAfterAdd + 1);
  eq('the drag landed', S().elements[0].x, 210);

  S().undo();
  eq('undo returns to the pre-drag position', S().elements[0].x, 10);
  eq('undo returns y too', S().elements[0].y, 10);

  S().redo();
  eq('redo replays the whole drag', S().elements[0].x, 210);
}

// ── Nested gestures collapse ────────────────────────────────────
{
  reset();
  S().addElement(rect('a'));
  const depth = S().undoStack.length;
  S().beginInteraction();
  S().beginInteraction();
  S().updateElement('a', { x: 5 });
  S().endInteraction();
  S().updateElement('a', { x: 9 });
  S().endInteraction();
  eq('nested interactions still yield one entry', S().undoStack.length, depth + 1);
  eq('interaction depth returns to zero', S().interactionDepth, 0);
  S().undo();
  eq('undo unwinds the whole nested gesture', S().elements[0].x, 0);
}

// ── Outside a gesture, each edit is its own step ────────────────
{
  reset();
  S().addElement(rect('a'));
  const depth = S().undoStack.length;
  S().updateElement('a', { x: 1 });
  S().updateElement('a', { x: 2 });
  eq('discrete edits stay discrete', S().undoStack.length, depth + 2);
}

// ── Quiet updates never touch history ───────────────────────────
{
  reset();
  S().addElement(rect('a'));
  S().updateElement('a', { x: 4 });
  const undoDepth = S().undoStack.length;
  S().undo();
  const redoDepth = S().redoStack.length;

  // Measurement caches (a text note's painted height, an image's
  // intrinsic aspect) are derived, not edits — they must not become
  // undo steps, and must not discard a pending redo.
  S().updateElementQuiet('a', { height: 123 });
  eq('quiet update adds no undo entry', S().undoStack.length, undoDepth - 1);
  eq('quiet update preserves redo', S().redoStack.length, redoDepth);
  eq('quiet update still applied', S().elements[0].height, 123);
}

// ── Batch delete ────────────────────────────────────────────────
{
  reset();
  S().addElements([rect('a'), rect('b'), rect('c'), rect('d')]);
  S().setSelectedElementIds(['a', 'b', 'c']);
  const depth = S().undoStack.length;

  S().removeElements(['a', 'b', 'c']);
  eq('deleting three elements is one undo entry', S().undoStack.length, depth + 1);
  eq('three elements went', S().elements.length, 1);
  eq('selection dropped the dead ids', S().selectedElementIds.length, 0);

  S().undo();
  eq('one undo brings all three back', S().elements.length, 4);
}

{
  reset();
  S().addElements([rect('a')]);
  const depth = S().undoStack.length;
  S().removeElements([]);
  eq('removing nothing is not an undo entry', S().undoStack.length, depth);
}

// ── Selection is pruned across undo/redo ────────────────────────
{
  reset();
  S().addElement(rect('a'));
  S().addElement(rect('b'));
  S().setSelectedElementIds(['a', 'b']);
  S().undo();  // 'b' no longer exists
  ok('undo drops selection of elements that no longer exist',
    !S().selectedElementIds.includes('b'));
  ok('undo keeps selection of elements that survive',
    S().selectedElementIds.includes('a'));
}

// ── An interrupted gesture cannot swallow later edits ───────────
{
  reset();
  S().addElement(rect('a'));
  S().beginInteraction();
  S().updateElement('a', { x: 50 });
  // Undo mid-gesture (Ctrl+Z while dragging) must close the group, or
  // every later edit joins it and history stops recording.
  S().undo();
  eq('undo resets the interaction depth', S().interactionDepth, 0);
  const depth = S().undoStack.length;
  S().updateElement('a', { x: 7 });
  eq('later edits record normally', S().undoStack.length, depth + 1);
}

// ── Move ────────────────────────────────────────────────────────
{
  reset();
  S().addElements([rect('a', 10, 10), draw('d', [[0, 0], [10, 10]]), rect('L', 0, 0, { locked: true })]);
  S().moveElements(['a', 'd', 'L'], 5, -3);

  const a = S().elements.find((e) => e.id === 'a')!;
  eq('shape moves by x', a.x, 15);
  eq('shape moves by y', a.y, 7);

  const d = S().elements.find((e) => e.id === 'd')!;
  // A stroke has no x/y — its geometry is its points.
  eq('stroke points move x', d.points![1].x, 15);
  eq('stroke points move y', d.points![1].y, 7);

  const l = S().elements.find((e) => e.id === 'L')!;
  eq('locked elements do not move', l.x, 0);

  const depth = S().undoStack.length;
  S().moveElements(['a'], 0, 0);
  eq('a zero move is not an undo entry', S().undoStack.length, depth);
}

// ── Duplicate ───────────────────────────────────────────────────
{
  reset();
  S().addElements([rect('a', 10, 10), draw('d', [[0, 0], [10, 10]])]);
  const ids = S().duplicateElements(['a', 'd'], 20);

  eq('two copies made', ids.length, 2);
  eq('originals still present', S().elements.length, 4);
  ok('copies get fresh ids', !ids.includes('a') && !ids.includes('d'));
  ok('the copies become the selection',
    S().selectedElementIds.length === 2 && S().selectedElementIds.every((i) => ids.includes(i)));

  const copyA = S().elements.find((e) => e.id === ids[0])!;
  eq('copy is offset', copyA.x, 30);

  const copyD = S().elements.find((e) => e.id === ids[1])!;
  eq('stroke copy offsets its points', copyD.points![0].x, 20);
  ok('stroke copy does not share the original array',
    copyD.points !== S().elements.find((e) => e.id === 'd')!.points);

  eq('duplicating nothing returns nothing', S().duplicateElements([]).length, 0);
  eq('duplicating unknown ids returns nothing', S().duplicateElements(['nope']).length, 0);
}

// ── Paint order ─────────────────────────────────────────────────
{
  reset();
  S().addElements([rect('a'), rect('b'), rect('c')]);
  S().updateElements([
    { id: 'a', patch: { zIndex: 0 } },
    { id: 'b', patch: { zIndex: 1 } },
    { id: 'c', patch: { zIndex: 2 } },
  ]);

  S().bringToFront(['a']);
  const zA = S().elements.find((e) => e.id === 'a')!.zIndex;
  ok('bringToFront lifts above everything', zA > 2);

  S().sendToBack(['c']);
  const zC = S().elements.find((e) => e.id === 'c')!.zIndex;
  const others = S().elements.filter((e) => e.id !== 'c').map((e) => e.zIndex);
  ok('sendToBack drops below everything', others.every((z) => z > zC));

  eq('nextZIndex is one past the top', S().nextZIndex(), Math.max(...S().elements.map((e) => e.zIndex)) + 1);
}

{
  reset();
  eq('nextZIndex on an empty canvas', S().nextZIndex(), 0);
}

// ── Lock ────────────────────────────────────────────────────────
{
  reset();
  S().addElements([rect('a'), rect('b')]);
  S().setSelectedElementIds(['a']);
  S().setLocked(['a'], true);
  ok('lock applies', S().elements.find((e) => e.id === 'a')!.locked === true);
  eq('locking clears the selection', S().selectedElementIds.length, 0);

  S().selectAll();
  ok('selectAll skips locked elements',
    S().selectedElementIds.length === 1 && S().selectedElementIds[0] === 'b');

  S().setLocked(['a'], false);
  S().selectAll();
  eq('unlocked elements are selectable again', S().selectedElementIds.length, 2);
}

// ── Selection toggling ──────────────────────────────────────────
{
  reset();
  S().addElements([rect('a'), rect('b')]);
  S().toggleSelection('a', false);
  eq('plain click replaces the selection', S().selectedElementIds.join(','), 'a');
  S().toggleSelection('b', true);
  eq('shift-click adds', S().selectedElementIds.join(','), 'a,b');
  S().toggleSelection('a', true);
  eq('shift-click on a selected element removes it', S().selectedElementIds.join(','), 'b');
  S().toggleSelection('a', false);
  eq('plain click collapses back to one', S().selectedElementIds.join(','), 'a');
}

// ── Stroke commit ───────────────────────────────────────────────
{
  reset();
  // A straight run of 50 samples: everything between the ends is noise.
  const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
  const widths = pts.map((_, i) => 1 + i / 10);
  S().commitStroke(pts, widths);

  eq('one stroke added', S().elements.length, 1);
  const el = S().elements[0];
  eq('stroke is a drawing', el.type, 'drawing');
  ok('collinear samples are simplified away', el.points!.length < 50);
  eq('the first sample survives', el.points![0].x, 0);
  eq('the last sample survives', el.points![el.points!.length - 1].x, 49);

  // Pressure has to follow the surviving vertices by index; keying it on
  // coordinates would collide whenever the pointer paused.
  eq('widths track the kept vertices', el.widths!.length, el.points!.length);
  eq('first width kept', el.widths![0], widths[0]);
  eq('last width kept', el.widths![el.widths!.length - 1], widths[49]);

  eq('drawing state cleared', S().isDrawing, false);
  eq('stroke buffer cleared', S().currentStroke.length, 0);
}

{
  reset();
  S().startStroke({ x: 0, y: 0 });
  S().commitStroke([{ x: 0, y: 0 }]);
  eq('a single-point stroke is discarded', S().elements.length, 0);
  eq('and the session still closes', S().isDrawing, false);
}

{
  reset();
  S().commitStroke([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
  S().commitStroke([{ x: 0, y: 0 }, { x: 6, y: 6 }]);
  ok('each stroke gets its own paint slot',
    S().elements[1].zIndex > S().elements[0].zIndex);
}

{
  reset();
  const noWidths = [{ x: 0, y: 0 }, { x: 3, y: 9 }, { x: 6, y: 0 }];
  S().commitStroke(noWidths);
  eq('a stroke with no pressure track stores none', S().elements[0].widths, undefined);

  S().cancelStroke();
  eq('cancelStroke closes the session', S().isDrawing, false);
}

// ── Ids ─────────────────────────────────────────────────────────
{
  // Date.now() alone collides inside a millisecond, which two elements
  // created in the same tick will do.
  const ids = new Set(Array.from({ length: 500 }, () => makeElementId('x')));
  eq('ids are unique within a tick', ids.size, 500);
  ok('ids carry their prefix', [...ids][0].startsWith('x_'));
}

// ── Hydration repairs legacy files ──────────────────────────────
{
  reset();
  S().hydrateFromWorkspace({
    elements: [
      // Saved by an older build that stored drag rectangles as-is.
      { ...rect('neg', 100, 100), width: -40, height: -20 },
      { ...rect('line', 10, 20), shapeType: 'line', width: -30, height: -40 },
      { ...rect('noz'), zIndex: undefined as unknown as number },
    ],
  });

  const neg = S().elements.find((e) => e.id === 'neg')!;
  eq('legacy negative extents are normalised x', neg.x, 60);
  eq('legacy negative extents are normalised width', neg.width, 40);

  // A line's sign IS its direction — normalising one reverses it.
  const line = S().elements.find((e) => e.id === 'line')!;
  eq('a line keeps its direction x', line.x, 10);
  eq('a line keeps its negative extent', line.width, -30);

  const noz = S().elements.find((e) => e.id === 'noz')!;
  ok('a missing zIndex is filled in', Number.isFinite(noz.zIndex));

  eq('hydration clears undo history', S().undoStack.length, 0);
  eq('hydration clears the selection', S().selectedElementIds.length, 0);
  eq('hydration clears the drag lock', S().dragTarget, null);
  eq('hydration closes any open gesture', S().interactionDepth, 0);
}

// ── Tool memory ─────────────────────────────────────────────────
{
  reset();
  S().setActiveTool('pen');
  S().setActiveTool('hand');
  eq('previousTool remembers what Space interrupted', S().previousTool, 'pen');
  S().setActiveTool('hand');
  eq('re-selecting the same tool does not overwrite the memory', S().previousTool, 'pen');
}

// ── History is bounded ──────────────────────────────────────────
{
  reset();
  S().addElement(rect('a'));
  for (let i = 0; i < 250; i++) S().updateElement('a', { x: i });
  ok('undo history is capped', S().undoStack.length <= 100);
}

// ── A gesture that changes nothing costs nothing ────────────────
{
  reset();
  S().addElement(rect('a'));
  const depth = S().undoStack.length;

  // Clicking an element grabs it and opens a gesture. Releasing without
  // moving must not leave an undo entry behind — snapshotting on open
  // charged one for every click that landed on something.
  S().beginInteraction();
  S().endInteraction();
  eq('an empty gesture adds no undo entry', S().undoStack.length, depth);
  eq('and leaves no dirty flag', S().interactionDirty, false);
}

// ── Cancelling a gesture leaves no trace ────────────────────────
{
  reset();
  S().addElement(rect('a', 10, 10));
  const depth = S().undoStack.length;

  S().beginInteraction();
  for (let i = 1; i <= 30; i++) S().updateElement('a', { x: 10 + i });
  eq('the gesture is mid-flight', S().elements[0].x, 40);

  S().abortInteraction();
  eq('abort restores the starting geometry', S().elements[0].x, 10);
  eq('abort drops the history entry', S().undoStack.length, depth);
  eq('abort closes the gesture', S().interactionDepth, 0);
}

{
  reset();
  S().addElement(rect('a', 10, 10));
  const depth = S().undoStack.length;
  // Aborting a gesture that never wrote anything must not eat the
  // caller's previous undo entry.
  S().beginInteraction();
  S().abortInteraction();
  eq('aborting a clean gesture keeps prior history', S().undoStack.length, depth);
  eq('and changes nothing', S().elements[0].x, 10);
}

{
  reset();
  S().addElement(rect('a'));
  const depth = S().undoStack.length;
  S().abortInteraction();
  eq('aborting with no gesture open is a no-op', S().undoStack.length, depth);
}

// ── Drawing preferences round-trip through the workspace file ───
{
  reset();
  S().setDashStyle('dotted');
  S().setSnapToGrid(true);
  S().setGridSize(32);
  S().setStrokeWidth(7);

  const data = S().toWorkspaceData();
  reset();
  eq('reset returns to the defaults', S().dashStyle, 'solid');

  S().hydrateFromWorkspace(data);
  eq('dash style survives a round-trip', S().dashStyle, 'dotted');
  eq('snap survives a round-trip', S().snapToGrid, true);
  eq('grid size survives a round-trip', S().gridSize, 32);
  eq('stroke width survives a round-trip', S().strokeWidth, 7);

  // A file written before these fields existed must still load.
  S().hydrateFromWorkspace({ elements: [], strokeColor: '#abc' });
  eq('a legacy file falls back to defaults', S().dashStyle, 'solid');
  eq('and to the default grid', S().gridSize, 20);
  eq('while keeping what it did store', S().strokeColor, '#abc');

  eq('grid size has a floor', (S().setGridSize(0), S().gridSize), 2);
}

console.log(`\ncanvas-store pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
