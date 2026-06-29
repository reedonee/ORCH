

# ORCH Layout Engine — Surgical Fix Guide v2

## What the screenshot tells us

Two cards are nearly perfectly overlapping at center screen. This means:

1. Both panels are being assigned `x,y = safeRegion center` — the shelf-pack is not running, or is running and placing both at the same slot
2. The `overlapSweep` is not separating them — likely because the gap fix was applied to the wrong variable, or the separation vector sign fix introduced a regression

---

## Fix 1 — Verify shelf-pack is actually being called

Your agent must add a `console.log` at the top of `resolveLayout()` right now to see which mode is being selected:

```ts
function resolveLayout(ctx: LayoutContext): LayoutResult {
  const panels = ctx.panels.filter(p => p.participatesInAutoLayout);
  
  console.log('[layout] resolveLayout called', {
    panelCount: panels.length,
    browserVisible: ctx.browserVisible,
    panelIds: panels.map(p => p.id),
    mode: panels.length === 0 ? 'noop'
      : panels.length === 1 && panels[0].type === 'agent' && panels.filter(p => p.participatesInAutoLayout).length === 1 ? 'hero'
      : ctx.browserVisible ? 'stage'
      : 'shelf'
  });
  // ... rest of function
}
```

**Hypothesis:** With 2 agent panels, it should enter `shelfPack`. If it's entering `hero` mode for both, that's the bug — the hero condition check is wrong after your agent's edit in §7.

---

## Fix 2 — The real hero guard condition (most likely culprit)

The guide said: *"enter hero mode only when sole participatesInAutoLayout panel is an agent AND no other auto-layout panels exist."*

Your agent likely wrote this:

```ts
// BROKEN — checks panels.length === 1 but panels array may have been
// filtered differently upstream, or the condition is evaluated before
// the second panel registers
if (panels.length === 1 && panels[0].type === 'agent') {
  return heroLayout(...)
}
```

**The correct guard:**

```ts
const autoLayoutPanels = ctx.panels.filter(p => p.participatesInAutoLayout && !p.isClosing);

if (
  autoLayoutPanels.length === 1 &&
  autoLayoutPanels[0].type === 'agent'
) {
  // hero mode — truly only one agent, nothing else
  return heroLayout(autoLayoutPanels[0], safeRegion, ctx.grid);
}

// 2+ panels — always shelf pack
return shelfPackMode(autoLayoutPanels, safeRegion, ctx);
```

---

## Fix 3 — The shelf-pack adaptive cell size (what makes cards big and intelligent)

This is the **premium UX fix**. Cards must fill the available space, not be a fixed size. Here is the exact calculation your agent must implement:

```ts
function computeAdaptiveCellSize(
  count: number,
  region: SafeRegion,
  gap: number
): { w: number; h: number } {
  
  // Column count by agent count
  const cols = count === 1 ? 1
             : count === 2 ? 2        // side by side
             : count <= 4 ? 2
             : count <= 6 ? 3
             : 3; // max 3 cols

  const rows = Math.ceil(count / cols);

  // Fill ALL available space, minus gaps between cells
  const totalGapX = (cols - 1) * gap;
  const totalGapY = (rows - 1) * gap;

  const cellW = Math.floor((region.right - region.left - totalGapX) / cols / gap) * gap;
  const cellH = Math.floor((region.bottom - region.top - totalGapY) / rows / gap) * gap;

  // Clamp to sensible min/max
  return {
    w: Math.max(320, Math.min(900, cellW)),
    h: Math.max(200, Math.min(600, cellH)),
  };
}
```

For **2 agents** on a 1920×1080 screen with a ~900px tall safe region and 32px gaps, this produces cards of roughly `920×860px` each — large, side by side, breathing room on all sides.

---

## Fix 4 — Rewrite shelfPack to use adaptive cell size

The current `shelfPack` likely uses hardcoded or minimum cell sizes. Replace the placement loop:

```ts
function shelfPack(
  panels: Panel[],
  region: SafeRegion,
  gap: number,
  grid: number
): LayoutPosition[] {
  const { w: cellW, h: cellH } = computeAdaptiveCellSize(
    panels.length, region, gap
  );

  const cols = region.width <= 0 ? 1
    : Math.max(1, Math.floor(panels.length === 2 ? 2
      : panels.length <= 4 ? 2 : 3));

  const results: LayoutPosition[] = [];
  
  panels.forEach((panel, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);

    // Use naturalW/naturalH overrides for special panel types
    const w = panel.naturalW ?? cellW;
    const h = panel.naturalH ?? cellH;

    // Snap to grid
    const x = snapToGrid(region.left + col * (cellW + gap), grid);
    const y = snapToGrid(region.top  + row * (cellH + gap), grid);

    results.push({ id: panel.id, x, y, w, h });
  });

  // CENTER the whole grid within the safe region
  if (results.length > 0) {
    const gridW = cols * cellW + (cols - 1) * gap;
    const gridH = Math.ceil(panels.length / cols) * cellH + (Math.ceil(panels.length / cols) - 1) * gap;
    
    const offsetX = snapToGrid((region.right - region.left - gridW) / 2, grid);
    const offsetY = snapToGrid((region.bottom - region.top - gridH) / 2, grid);

    results.forEach(r => {
      r.x += offsetX;
      r.y += offsetY;
    });
  }

  return results;
}
```

The **centering step at the end** is what makes the layout feel premium — the whole grid of cards is centered in the safe region, not left-aligned.

---

## Fix 5 — Hero layout (1 agent = large centered card)

```ts
function heroLayout(
  panel: Panel,
  region: SafeRegion,
  grid: number
): LayoutPosition {
  const HERO_MAX_W = 880;
  const HERO_MAX_H = 700;

  const w = snapToGrid(
    Math.min(HERO_MAX_W, (region.right - region.left) * 0.72),
    grid
  );
  const h = snapToGrid(
    Math.min(HERO_MAX_H, (region.bottom - region.top) * 0.85),
    grid
  );

  // Centered in safe region
  const x = snapToGrid(region.left + (region.right - region.left - w) / 2, grid);
  const y = snapToGrid(region.top  + (region.bottom - region.top  - h) / 2, grid);

  return { id: panel.id, x, y, w, h };
}
```

---

## Fix 6 — Safe region must respect all three bars

This is likely why cards appear too high or too low. Your agent must measure the actual chrome. Add this to `useWorkspaceStore` or a dedicated `useChromeInsets` hook:

```ts
function measureChromeInsets(): ChromeInsets {
  const pillBar   = document.querySelector('[data-chrome="pill-bar"]');
  const chatBar   = document.querySelector('[data-chrome="chat-bar"]');
  const leftPanel = document.querySelector('[data-chrome="left-panel"]');

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  return {
    topBarBottom:   pillBar   ? pillBar.getBoundingClientRect().bottom   + 16 : 74,
    bottomBarTop:   chatBar   ? chatBar.getBoundingClientRect().top      - 16 : vh - 88,
    leftReserved:   leftPanel ? leftPanel.getBoundingClientRect().right  + 16 : 64,
    rightReserved:  16,
  };
}
```

**Your agent must add `data-chrome="pill-bar"`, `data-chrome="chat-bar"`, and `data-chrome="left-panel"` attributes to those elements in their JSX** so the measurement selectors work. If adding data attributes isn't possible right now, use the hardcoded fallback values but make sure they match the actual rendered pixel heights.

---

## Fix 7 — Confirm overlapSweep gap fix is correct

The guide said add `+ gap` to the push. Your agent may have added it incorrectly. The exact correct implementation:

```ts
// Inside the pair loop in overlapSweep:
const overlapX = (aW/2 + bW/2) - Math.abs(ax - bx);
const overlapY = (aH/2 + bH/2) - Math.abs(ay - by);

if (overlapX > 0 && overlapY > 0) {
  // Separate on the axis with LESS overlap (smallest push)
  if (overlapX < overlapY) {
    const push = (overlapX / 2) + gap / 2; // half gap each side
    const dir  = ax < bx ? -1 : 1;
    positions[i].x -= push * dir;
    positions[j].x += push * dir;
  } else {
    const push = (overlapY / 2) + gap / 2;
    const dir  = ay < by ? -1 : 1;
    positions[i].y -= push * dir;
    positions[j].y += push * dir;
  }
}
```

Note `gap / 2` on each side — both panels get half the gap each, so total separation between them equals `gap`.

---

## Exact sequence for your agent

Tell your agent to do these steps in this exact order, committing and testing after each:

**Step 1** — Add the `console.log` to `resolveLayout()` and run the app with 2 agents. Paste the console output. This tells us definitively which mode is being selected.

**Step 2** — Fix the hero guard condition (Fix 2 above) so 2 agents always goes to shelf-pack.

**Step 3** — Replace `computeAdaptiveCellSize()` with Fix 3. This is what makes cards fill the screen intelligently.

**Step 4** — Replace `shelfPack()` placement loop with Fix 4, including the centering offset at the end.

**Step 5** — Replace `heroLayout()` with Fix 5.

**Step 6** — Add `data-chrome` attributes and implement `measureChromeInsets()`.

**Step 7** — Fix the gap math in `overlapSweep()` using Fix 7's exact formula.

**Step 8** — Remove the `console.log` from Step 1.

---

The screenshot shows the core issue is that 2 panels are going to the same slot — not a sweep failure. Fix 2 + Fix 3 + Fix 4 will resolve what you're seeing. The rest makes it premium.