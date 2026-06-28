Plan
ORCH Layout Engine — Complete Redesign
Diagnosis (root cause)
There are two competing layout systems:

The new engine in useWorkspaceStore.ts — 32px grid, in-memory, flow→micro-tidy→frame (good bones, but buggy).
The legacy canvas-utils.ts — 20px grid, DOM-reading, still drives all spawning (PillBar:159, agent-commands:79, orch-bridge:140) and the voice arrangeAgents (agent-commands:128).
This causes a grid-unit mismatch (20 vs 32) — nodes jump the instant any arrange runs. Plus 8 independent verified bugs (wrong fitToScreen dims, getViewportCenter ignoring zoom, no re-arrange on resize, Music/Browser clamp ordering, focusOnAgent hardcoded zoom, etc.).

Strategy: one engine, replace the algorithm, delete the legacy
Keep the proven runtime coordination layer (motion tokens, registry coordination, lifecycle subscriptions, presets) but rip out the scattered math and the legacy module. Introduce one pure, testable module that is the engine.

1. NEW FILE: src/lib/layout-engine.ts (the engine — pure functions, no React/Zustand)
All layout math in one place. Exports:

computeSafeRegion(chrome, viewport, grid) → { top, bottom, left, right }. Encodes the user's exact insets:
top = pillBar.top + pillBar.height + grid (under pill by 1 grid box)
bottom = vh − chatBar.bottom − chatBar.height − grid (above chat by 1 grid box)
left = grid + leftReserved (not touching left side panel)
right = vw − grid (not touching right edge)
chrome sourced from a single CHROME constant (pillBar:{top:26,height:36}, chatBar:{bottom:28,height:44}, leftReserved:0).
computeAdaptiveCellSize(count, region, grid, spec) — single uniform cell size for agent-grid rows (1 node→1 col, 2→1 col stacked, 3–4→2 cols, 5+→3 cols), preserving aspect, clamped to [min,max], snapped to grid. Music uses the exact same cell size (no longer tall) per requirement.
shelfPack(items, region, gap, grid) — heterogeneous first-fit row packer. Per-item natural sizes (agents & music = adaptive cell; future types declare their own). Guarantees exactly gap=1 grid between every node, left→right wrap, zero overlaps. Shrinks a node only when it would overflow region width. Returns absolute snapped positions + a bounding box.
heroLayout(item, region, grid) — single-node mode: centered, full safe height, width = min(safeWidth, heroMax) so it's "wide enough but not touching left side panel or right edge." Used when exactly 1 node is visible.
stageLayout(browser, others, region, grid) — browser-open mode: browser takes left ~half width, full safe height (below pill+1grid / above chat+1grid, tall enough); other nodes (+music) shelfPack into the right half as a clean sub-grid. 1 grid gap between the two halves.
frameViewport(bbox, region, spec) — computes pan + zoom to fit a bounding box into the safe region, clamped to [0.35, 1.0], zoom-correct (fixes the ignore-zoom bug).
resolveLayout(ctx) — the orchestrator. Given panels + viewport + active overrides, picks the mode automatically:
0 nodes → no-op
1 node → heroLayout
browser visible → stageLayout
else → shelfPack over adaptive cells
always → snap + clamp every result into the safe region + run a final overlap-sweep pass as a hard guarantee ("never overlap"). Returns { positions, sizes, viewport, motion } computed entirely in memory before any commit.
findSpawnSlot(existing, region, grid, defaultCell) — expanding-perimeter search from region center; returns nearest non-overlapping grid slot. This replaces the deleted findViewportPosition.
2. REFACTOR: src/stores/useWorkspaceStore.ts
Replace the in-file math (computeFlowLayout, computeMicroTidy, computeExtraPanelPositions, buggy getViewportCenter, gatherFixedObstacles fight, clampArrangeResults) with calls to layout-engine.ts.
LAYOUT_ENGINE_SPEC becomes the single tuning source; add chrome block there.
Actions (autoArrange, arrangeTidy, arrangeGrid, arrangeStage, setLayoutMode) call resolveLayout, commit positions+sizes+viewport+motion in one batch (existing pattern), then clear motion token.
Add spawnPosition() action — single entry point used by every spawn path; calls findSpawnSlot.
Fix bug: re-arrange on panel resize — subscribe to registry width/height changes; debounce-arrange when a resized panel's new size would collide (so resizing a node reflows neighbors instead of overlapping).
Lifecycle subscription stays (count change, viewport resize, browser/music visibility) but routes through resolveLayout; the browser-visibility toggle now correctly flips to/from stage mode.
3. DELETE: src/lib/canvas-utils.ts + rewire all 4 spawn paths
Every caller switches from the legacy 20px/DOM path to useWorkspaceStore.spawnPosition():

components/PillBar.tsx (handleCreate)
components/ChatBar.tsx (fallback spawn at :232)
lib/agent-commands.ts (spawnProviderAgent)
lib/orch-bridge.ts (:140)
components/AddAgentDialog.tsx (:91) First-agent special case collapses into spawnPosition() (region center).
Fix bug: arrangeAgents() with no mode (agent-commands.ts:128) — stop calling legacy autoLayout; call useWorkspaceStore.autoArrange() so voice/chat "arrange" matches Ctrl+L exactly.

4. FIX independent bugs (verified)
InfiniteCanvas.tsx:495 fitToScreen — drop hardcoded 340×320; delegate to frameViewport / engine framer.
useAppStore.focusOnAgent — respect framer [0.35,1.0] guardrails instead of hardcoded zoom:1; use the agent's real size.
restoreSnapshot (panel-registry) — route viewport restore through the same safe-region/chrome math used at capture time.
Extra-panel clamp ordering — resolveLayout computes Music/Browser positions inside the same in-memory pass and clamps them alongside agents (no more post-commit off-screen escape).
5. Result properties (the "never/guarantee" contract)
Exactly 1 grid box (32px) gap between every node — enforced by shelf-pack + final overlap-sweep.
Zero overlaps, zero stacking — guaranteed by construction + defensive sweep.
Viewport-aware + zoom-aware — every layout derives from the live safe region and zoom-correct framer.
Extensible — new node types just declare { naturalW, naturalH } in their registry registration and shelfPack handles them.
All 5 trigger paths unified: spawn, close, keyboard (Ctrl+L), chat/voice arrangeAgents, browser/music toggle, resize → all flow through one resolveLayout.
6. Verification
npx tsc --noEmit (typecheck the whole app).
npm run build (Vite production build).
Manual run via npm run dev: spawn 1 (hero) → spawn 4 (grid, 1-grid gaps) → open browser (stage, half-width, full-height) → open music (agent-sized, in grid) → resize a node (reflow, no overlap) → Ctrl+L (tidy) → voice "arrange" → close nodes → resize window. Confirm no jumps, no overlaps, premium spring motion.
Files touched
New: src/lib/layout-engine.ts Refactored: src/stores/useWorkspaceStore.ts Rewired (spawn path + bug fixes): src/components/PillBar.tsx, src/components/ChatBar.tsx, src/components/InfiniteCanvas.tsx, src/lib/agent-commands.ts, src/lib/orch-bridge.ts, src/components/AddAgentDialog.tsx, src/stores/useAppStore.ts, src/stores/usePanelRegistry.ts Deleted: src/lib/canvas-utils.ts

This is a single-shot, architecture-level fix that makes the arranging system deterministic, unified, and world-class.


git stash apply 92e9185d4a5017b6466bf95d454e197ca7756d07