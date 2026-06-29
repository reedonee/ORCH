Sorry about that! Here's the full enhancement guide in plain text:

---

# ORCH Layout Engine — Enhancement Guide

---

## § CRITICAL: The No-Stacking Bug (Fix This First)

There are **three distinct root causes** for panels stacking on each other. All three need fixing — patching one will mask the others.

---

### Root Cause A — `overlapSweep()` gap enforcement missing

**The single most impactful fix. Likely one line of code.**

The sweep pushes panels apart just enough to stop overlapping (touching edges), but the `+ gap` term is missing. Panels end up flush at 0px instead of the required 32px gap.

```ts
// CURRENT (wrong) — panels end up touching
const push = overlapX;

// FIXED — panels end up with proper 32px gap between them
const push = overlapX + gap;
```

Apply this same fix to both X and Y axis separation in `overlapSweep()` inside `layout-engine.ts`.

---

### Root Cause B — `commitLayout()` race condition

When two lifecycle triggers fire within the debounce window (e.g. agent spawns AND browser opens), both call `resolveLayout()` and both call `commitLayout()`. The second commit writes stale positions computed before the first commit's state was visible — panels snap back to overlapping positions.

**Fix — add a generation counter:**

```ts
// In useWorkspaceStore:
let layoutGeneration = 0;

async function autoArrange() {
  const gen = ++layoutGeneration;
  const result = resolveLayout(ctx);
  if (gen !== layoutGeneration) return; // stale — discard
  commitLayout(result);
}
```

---

### Root Cause C — `findSpawnSlot()` ignores locked panels

`findSpawnSlot()` checks against `getArrangablePanels()` — but locked panels that haven't moved may not be in that snapshot. New panels get placed at the safe region center, which is exactly where a default-positioned locked panel already sits.

**Fix:** Change `findSpawnSlot()` to use `getVisiblePanels()` instead of `getArrangablePanels()` for the existing-panels list. Locked panels must be treated as hard obstacles at spawn time, not just during the sweep.

Also change the overlap test from:
```ts
rectsOverlap(candidate, existing)
```
to:
```ts
rectsOverlapWithPadding(candidate, existing, gap)
```

So spawned panels never land within `gap` pixels of any existing panel.

---

### Additional sweep hardening

**Increase max passes from 10 → 20.** With 5+ panels and locked obstacles, 10 passes is not enough to converge.

**Add index-based jitter on stall.** When two same-sized panels are pushed symmetrically, the separation vector cancels and they stick. If a pair's overlap changed by less than `0.1px` between passes, inject a deterministic tie-break:

```ts
const jitter = (indexA - indexB) * grid; // e.g. 32px
// Apply jitter on the secondary axis before next pass
```

This breaks symmetry without randomness.

**Add post-sweep validation.** After all passes, do a final O(n²) scan. If any pair still overlaps by more than `2px`, do one emergency separation on the Y axis — push the lower-indexed panel up by the full overlap amount. Log a warning so you can track convergence failures.

**Clamp to region after every pass** — not just at the end. Without this, panel A pushes panel B outside the safe region, then B pushes C, and so on (cascade drift).

---

## § HIGH: Safe Region Accuracy

**Problem:** `computeSafeRegion()` uses hardcoded chrome dimensions. When the pill bar height changes or a notification banner appears, panels can spawn under chrome.

**Fix:** Add a `ChromeInsets` parameter to `computeSafeRegion()` and inject it from the workspace store. The store measures actual insets at mount and on resize using `element.getBoundingClientRect()` on the pill bar and chat bar roots:

```ts
interface ChromeInsets {
  topBarBottom: number;
  bottomBarTop: number;
  leftReserved: number;
  rightReserved: number;
}

function computeSafeRegion(vw, vh, grid, chrome: ChromeInsets): SafeRegion {
  return {
    top:    chrome.topBarBottom + grid,
    bottom: chrome.bottomBarTop - grid,
    left:   chrome.leftReserved + grid,
    right:  vw - chrome.rightReserved - grid,
  };
}
```

**Also add a minimum region guard.** If the safe region collapses (e.g. tiny screen), assert `width > 2 * minCellW` and `height > 2 * minCellH`. If not, return a clamped minimum and warn. Never return a region with zero or negative dimensions — this produces NaN positions downstream.

---

## § HIGH: Spawn Slot Hardening

Four fixes for `findSpawnSlot()` in `layout-engine.ts`:

1. **Pan+zoom correction.** The center candidate must be computed as `viewportCenter → canvas space` using current pan and zoom from `useAppStore`. Without this, every spawn clusters at the canvas origin when zoomed out.

2. **Include mid-drag panels.** Use `getVisiblePanels()`, not `getArrangablePanels()`. A panel being dragged is still occupying space.

3. **Gap-aware collision.** Use `rectsOverlapWithPadding(candidate, existing, gap)` for the slot check, not bare overlap.

4. **Increase search radius from 20 → 40.** With 10+ agents, radius 20 exhausts without finding a valid slot and falls back silently to a bad position.

---

## § HIGH: Shelf-Pack Robustness

**Row overflow:** When panel count is high, the last row's bottom can exceed `region.bottom`. Fix: after packing, check if any panel overflows. If so, recompute with reduced cell height: `newCellH = (region.height - (rows-1)*gap) / rows`. If even at minimum cell height panels don't fit, add an extra column.

**Wrap point bug:** Snap item width to grid *before* the overflow check, not after placement. The wrap condition must use snapped width:

```ts
if (rowX + snappedW > region.right) { /* wrap */ }
```

**Single-item row centering:** When a row has exactly one panel, center it horizontally:
```ts
panel.x = region.left + (region.width - panelW) / 2; // grid-snap this
```

---

## § MED: Stage Layout Fixes

**Browser minimum width not enforced.** On narrow viewports, half the safe region can be less than 480px (browser minimum). Fix:

```ts
const browserW = Math.max(BROWSER_MIN_W, region.width * 0.5);
// If browserW would take > 75% of region, fall through to shelf-pack instead
if (browserW >= region.width * 0.75) return shelfPackMode(ctx);
```

**Agent panels drifting into browser column.** When `overlapSweep` pushes a panel left, it's clamped to the full safe region — not the right sub-region. In stage mode, pass the right sub-region as the clamp boundary for non-browser panels. The browser's right edge should be a hard wall.

---

## § MED: Hero Layout Guard

**Pixel cap on ultrawide.** On 2560px displays, 65% = 1500px — way too wide for a single agent card. Add an absolute cap:

```ts
const HERO_MAX_WIDTH = 880;
const heroW = Math.min(region.width * 0.65, HERO_MAX_WIDTH);
```

**Hero mode fires incorrectly with music/forge visible.** Hero mode should only activate when the sole `participatesInAutoLayout` panel is an agent AND no other auto-layout panels exist. If music or forge are present alongside a single agent, fall through to `shelfPack()` with 1-column layout.

---

## § MED: Framing Accuracy

**Closing panels inflate the bounding box.** When an agent closes, its geometry still inflates `frameViewport()`'s bounding box during the close animation. Add `isClosing: boolean` to the panel type. Set it at the start of the close animation. Exclude `isClosing: true` panels from `getFramablePanels()`.

**Zoom transitions are jarring.** Apply the same `cubic-bezier(0.34, 1.56, 0.64, 1)` spring to zoom changes. Tween to the new zoom over ~300ms using `requestAnimationFrame` in `InfiniteCanvas` instead of snapping in one frame.

---

## § OPTIONAL: UX Polish

**Layout motion token — clear on `transitionend`, not a 500ms timer.** If a user starts dragging within that 500ms window, the drag gets the spring transition applied, making it feel elastic. Listen to `transitionend` on panel elements and clear the motion token on the final one.

**Snapshot system missing viewport.** `captureSnapshot()` doesn't save `pan` and `zoom`. After restoring a snapshot, the user has to manually zoom to find the panels. Add pan and zoom to the snapshot type and restore them with `requestViewportFrame()`.

**Eliminate the position flash on commit.** Wrap `batchUpdatePanels()` in `ReactDOM.flushSync()` so all position writes reach the DOM in the same paint frame before the spring transition starts.

---

## Implementation Order for Your Agent

| Step | What | Why first |
|------|------|-----------|
| 1 | Add `+ gap` to overlapSweep separation push | Fixes ~60% of stacking. One-line change. |
| 2 | Increase max passes to 20 + post-sweep validation scan | Catches cases the gap fix misses |
| 3 | Fix `findSpawnSlot` → `getVisiblePanels` + gap-aware check | Prevents stacking at spawn time |
| 4 | Add layout generation counter | Fixes race condition before real user traffic |
| 5 | Add index-based jitter on stall | Handles symmetric-push degenerate case |
| 6 | Safe region + shelf-pack fixes (§2, §4) | Run in parallel — different functions |
| 7 | Stage layout + hero guard (§5, §6) | Validate manually with edge-case panel combos |
| 8 | UX polish (§7, §8) | Non-blocking — after core bugs confirmed fixed |

---

Start with step 1 — it's a one-line change in `overlapSweep()` and it will immediately reduce most of the stacking you're seeing. Each subsequent step builds on the previous.