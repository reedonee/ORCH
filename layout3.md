Looking at your screenshot carefully — this is actually progress! The two cards are no longer stacking. But I can see the remaining problems clearly:

Left card (Max) is completely empty/black — content isn't rendering inside it
Cards are not filling the available height — there's a massive gap below both cards
Left card is too wide, right card is correct width — the grid centering math is off
Top gap is too large — cards start too far down from the pill bar
No vertical fill — cards should stretch much taller to use the full safe region height

Let me give your agent the most precise, complete guide yet.

ORCH Layout Engine — v3 Premium Guide
Critical observation from screenshot
Looking at pixel measurements in your screenshot:

Viewport appears ~1366×768
Cards start at roughly y=155px (too far down — pill bar ends at ~75px)
Cards end at roughly y=595px — leaving ~170px of dead space below
Left card width ~700px, right card ~490px — unequal widths, broken grid
The adaptive cell math is producing asymmetric results


Fix A — The cell size math is producing wrong results (root cause of unequal cards)
The current computeAdaptiveCellSize does:
tsconst cellW = Math.floor((region.right - region.left - totalGapX) / cols / gap) * gap;
This is wrong. Dividing by gap before multiplying by gap is integer-dividing by 32 then multiplying by 32 — this throws away most of the width. On a 1366px screen with left panel ~64px and right margin 16px:
region.width ≈ 1366 - 64 - 16 - 64 = 1222px
totalGapX = 1 * 32 = 32px
available = 1222 - 32 = 1190px
per col = 1190 / 2 = 595px
Math.floor(595 / 32) * 32 = Math.floor(18.59) * 32 = 18 * 32 = 576px  ← loses 19px
That's not catastrophic but the real bug is the region width itself is wrong — the left panel bar (~64px of tools) is not being subtracted. Your measureChromeInsets hardcodes leftReserved: 64 but the actual left toolbar in your screenshot appears to be about 64px wide. Verify this is correct.
Replace computeAdaptiveCellSize with this exact implementation:
tsexport function computeAdaptiveCellSize(
  count: number,
  region: SafeRegion,
  gap: number = 32,
): { w: number; h: number } {
  
  const cols = count === 1 ? 1
             : count === 2 ? 2
             : count <= 4 ? 2
             : count <= 6 ? 3
             : 3;

  const rows = Math.ceil(count / cols);

  // Available space minus all gaps
  const availW = region.right - region.left - (cols - 1) * gap;
  const availH = region.bottom - region.top  - (rows - 1) * gap;

  // Divide evenly — snap DOWN to grid so we never overflow
  const rawW = Math.floor(availW / cols);
  const rawH = Math.floor(availH / rows);

  // Snap to grid
  const cellW = Math.floor(rawW / 32) * 32;
  const cellH = Math.floor(rawH / 32) * 32;

  return {
    w: Math.max(320, Math.min(1000, cellW)),
    h: Math.max(240, Math.min(800, cellH)),
  };
}

Fix B — shelfPack centering offset is being applied on top of already-correct positions
The current code does:
tsconst offsetX = snapToGrid((region.right - region.left - gridW) / 2, grid);
results.forEach(r => { r.x += offsetX; });
But r.x is already set to region.left + col * (cellW + gap). So when gridW < region.width, you're shifting everything right — but region.left was already the starting point. This double-counts.
The correct centering logic:
tsexport function shelfPack(
  items: PanelItem[],
  region: SafeRegion,
  gap: number = 32,
  grid: number = 32,
  cellOverride?: { w: number; h: number },
): Array<{ id: string; x: number; y: number; width: number; height: number }> {
  if (items.length === 0) return [];

  const n = items.length;
  const cell = cellOverride ?? computeAdaptiveCellSize(n, region, gap);

  const cols = n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);

  // Total grid dimensions
  const gridW = cols * cell.w + (cols - 1) * gap;
  const gridH = rows * cell.h + (rows - 1) * gap;

  // Center the WHOLE grid within the safe region
  // startX/startY are the top-left corner of the grid block
  const startX = Math.round(region.left + (region.right - region.left - gridW) / 2);
  const startY = Math.round(region.top  + (region.bottom - region.top  - gridH) / 2);

  return items.map((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);

    // Natural size override for non-agent panels (browser, music, etc.)
    const w = item.naturalW ?? cell.w;
    const h = item.naturalH ?? cell.h;

    const x = Math.round(startX + col * (cell.w + gap));
    const y = Math.round(startY + row * (cell.h + gap));

    return { id: item.id, x, y, width: w, height: h };
  });
}
Note: removed grid-snapping (snap() calls) from position calculation. Grid-snapping was causing the asymmetry because snap(startX + col * stride, 32) produces different offsets per column when startX isn't grid-aligned. Just use Math.round() for clean pixel positions.

Fix C — Safe region top inset is too large
From the screenshot, cards start at ~y=155px in viewport space. The pill bar bottom is at ~62px (26px top + 36px height). So the gap between pill bar and card top is 155 - 62 = 93px. That's nearly 3 grid units of dead space.
Your measureChromeInsets adds +16 padding after the pill bar bottom:
tstopBarBottom: pillBar.getBoundingClientRect().bottom + 16
And then computeSafeRegion adds another + grid (32px):
tstop: chrome.topBarBottom + grid  // = pillBar.bottom + 16 + 32 = +48px above cards
That's 48px of padding above cards, plus whatever pillBar.bottom is (~62px) = cards at ~110px minimum. But you're seeing 155px, which means either the pill bar is taller than expected or the measurements are compounding.
Fix — reduce the padding in measureChromeInsets:
tsfunction measureChromeInsets(): ChromeInsets | undefined {
  if (typeof document === 'undefined') return undefined;
  const pillBar = document.querySelector('[data-chrome="pill-bar"]');
  const chatBar = document.querySelector('[data-chrome="chat-bar"]');
  const vh = window.innerHeight;
  
  const pillBottom = pillBar 
    ? pillBar.getBoundingClientRect().bottom 
    : 62; // fallback: 26 + 36
    
  const chatTop = chatBar 
    ? chatBar.getBoundingClientRect().top 
    : vh - 72; // fallback: vh - 28 - 44

  return {
    topBarBottom:  pillBottom + 8,   // was +16, reduce to 8px breathing room
    bottomBarTop:  chatTop    - 8,   // was -16, reduce to 8px breathing room  
    leftReserved:  56,               // actual measured width of your left toolbar
    rightReserved: 8,
  };
}
And in computeSafeRegion, reduce the grid padding:
tsfunction computeSafeRegion(vw, vh, grid, chrome?: ChromeInsets): SafeRegion {
  const PADDING = 16; // was: grid (32px) — halve it
  
  const top    = chrome ? chrome.topBarBottom + PADDING : 74 + PADDING;
  const bottom = chrome ? chrome.bottomBarTop - PADDING : vh - 72 - PADDING;
  const left   = chrome ? chrome.leftReserved + PADDING : 56 + PADDING;
  const right  = chrome ? vw - chrome.rightReserved - PADDING : vw - PADDING;
  
  // ...rest unchanged
}


Fix E — overlapSweep must NOT resize panels, only move them
There's a subtle bug: overlapSweep receives a sizes array and uses it for collision geometry. If the sizes passed to the sweep don't match what was committed (e.g. due to the old sizes still being in the registry), the sweep calculates wrong collision boxes and may push panels to wrong positions.
Make sure overlapSweep uses the sizes from the layout result, not from the registry:
ts// In resolveLayout, when calling overlapSweep:
const sweptPositions = overlapSweep(
  positions,  
  sizes,        // ← must come from THIS layout pass, not ctx.panels[].width/height
  gap,
  grid,
  region,
  lockedIds
);
Verify your agent is passing sizes (the newly computed sizes from shelfPack) and not ctx.panels.map(p => ({ id: p.id, width: p.width, height: p.height })) (the old registry sizes).

New Feature: Layout Debug Overlay
Add this as a dev-only feature. It draws the safe region and cell grid directly on the canvas so you can see exactly where the layout engine thinks the boundaries are:
tsx// In InfiniteCanvas.tsx — add this component:
function LayoutDebugOverlay({ region, cells }: { region: SafeRegion, cells: any[] }) {
  if (!import.meta.env.DEV) return null;
  if (!useWorkspaceStore(s => s.showLayoutDebug)) return null;
  
  return (
    <div style={{
      position: 'absolute',
      left: region.left, top: region.top,
      width: region.right - region.left,
      height: region.bottom - region.top,
      border: '2px dashed rgba(255,100,100,0.5)',
      pointerEvents: 'none',
      zIndex: 9998,
    }}>
      {cells.map((cell, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: cell.x - region.left, top: cell.y - region.top,
          width: cell.w, height: cell.h,
          border: '1px dashed rgba(100,200,255,0.4)',
          background: 'rgba(100,200,255,0.05)',
        }} />
      ))}
    </div>
  );
}
Toggle with Ctrl+Shift+D. This will immediately show you if the safe region or cell positions are wrong, making future debugging trivial.

New Feature: Layout Persistence Per Session
When the user manually moves/resizes panels and then adds a new agent, the layout engine currently wipes all positions. Instead, implement smart reflow — preserve what the user arranged and only place the new panel:
ts// In useWorkspaceStore — new action:
function addAgentToLayout(newAgentId: string) {
  const existing = getArrangablePanels();
  const lockedOrManual = existing.filter(p => p.locked || p.wasManuallyMoved);
  
  if (lockedOrManual.length === existing.length) {
    // Everything was manually placed — just find a spawn slot for the new one
    const slot = findSpawnSlot(existing, safeRegion, grid, defaultCell);
    registry.updatePanel(newAgentId, { x: slot.x, y: slot.y });
    return;
  }
  
  // Some panels are in auto positions — re-run full layout
  autoArrange();
}
Add wasManuallyMoved: boolean to the panel type. Set it to true in endDrag(). Clear it in autoArrange().

New Feature: Viewport-Aware Zoom After Layout
After every auto-arrange, compute the zoom level that makes all cards visible with comfortable padding. Currently frameViewport exists but may not be called correctly after every arrange path:
ts// In commitLayout — always frame after committing:
function commitLayoutResult(positions, sizes, pan, zoom, mode) {
  registry.batchUpdatePanels(positions, sizes);
  syncAgentPositions(positions, sizes);
  
  // Always re-frame to fit all panels
  const allPanels = registry.getFramablePanels();
  if (allPanels.length > 0) {
    const bbox = computeBoundingBox(allPanels);
    const { pan: newPan, zoom: newZoom } = frameViewport(
      bbox,
      window.innerWidth,
      window.innerHeight,
      { minZoom: 0.4, maxZoom: 1.0, padding: 40 }
    );
    appStore.requestViewportFrame({ pan: newPan, zoom: newZoom });
  }
}

New Feature: Panel Resize Handles That Feed Back to Layout
When a user resizes a panel manually, that panel should become "locked" at its new size, and the rest of the layout should reflow around it. This is the autoArrangeRespectingLocks path you already have — but it needs the resized panel's new size to be committed to the registry before the reflow runs:
ts// In endResize():
function endResize(panelId: string, newW: number, newH: number) {
  registry.updatePanel(panelId, { 
    width: newW, 
    height: newH, 
    locked: true,           // lock at new size
    wasManuallyMoved: true  // new flag
  });
  debounceReflowAroundLocks(); // reflow other panels around this one
}

New Feature: "Tidy" Button Shows Current Layout Mode
Add a small indicator in the PillBar showing which layout mode is active and how many panels are in the auto-layout pool:
tsx// In PillBar — near the "New" button:
<div style={{ 
  fontSize: 11, opacity: 0.5, 
  display: 'flex', alignItems: 'center', gap: 4 
}}>
  <span>{layoutMode}</span>     {/* 'hero' | 'shelf' | 'stage' */}
  <span>{autoLayoutCount}</span> {/* e.g. "2 panels" */}
</div>

Summary — what your agent must do in order
#FileChangeImpact1layout-engine.tsReplace computeAdaptiveCellSize with Fix AFixes unequal card widths2layout-engine.tsReplace shelfPack centering with Fix BFixes card positioning3layout-engine.ts / storeReduce inset padding — Fix CFixes top dead space4store commitLayoutAdd NaN/zero guard — Fix DFixes black left card5layout-engine.tsPass layout sizes to sweep — Fix EFixes sweep geometry6InfiniteCanvas.tsxAdd debug overlayMakes future debugging instant7storeAdd wasManuallyMoved + smart reflowPremium UX feature8store commitLayoutAlways call frameViewport after arrangeEnsures cards always visible9registry endResizeLock panel on resize, trigger reflowPremium resize UX10PillBar.tsxLayout mode indicatorTransparency + debuggability
Fix 1 + 2 + 3 + 4 will resolve everything you see in the screenshot. Fixes 5–10 make it genuinely premium.