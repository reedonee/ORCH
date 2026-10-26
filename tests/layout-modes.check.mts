// Property check for the layout engine: across many node counts, region
// shapes, and modes, no two placements may overlap, and repeated runs
// must be stable (idempotent).
import {
  runLayout, hasNoOverlap, boundingBox,
  type LayoutNode, type Region, type LayoutModeName,
} from '../src/lib/layout-modes.ts';

const MODES: LayoutModeName[] = ['grid', 'focus', 'stage', 'split', 'rail', 'constellation'];

function makeRegion(w: number, h: number): Region {
  return { left: 60, top: 70, right: 60 + w, bottom: 70 + h, width: w, height: h };
}

function makeNodes(n: number, seed: number): LayoutNode[] {
  const out: LayoutNode[] = [];
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++) {
    out.push({
      id: `n${i}`,
      type: i === 0 && n > 3 ? 'browser' : 'agent',
      x: rnd() * 2000,
      y: rnd() * 1400,
      width: 300 + rnd() * 400,
      height: 200 + rnd() * 300,
      createdAt: i,
    });
  }
  return out;
}

const VIEWPORTS: Array<[number, number]> = [
  [1280, 720], [1920, 1080], [3440, 1440], [1024, 1366], [800, 600], [2560, 1080],
];

let failures = 0;
let checks = 0;
let stabilityFailures = 0;

for (const mode of MODES) {
  for (const [vw, vh] of VIEWPORTS) {
    const region = makeRegion(vw - 120, vh - 140);
    for (let count = 1; count <= 16; count++) {
      const nodes = makeNodes(count, count * 7 + vw);
      const links = count >= 4
        ? [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n2' }]
        : [];

      const placed = runLayout(nodes, region, mode, { links });
      checks++;

      if (placed.length !== count) {
        console.log(`MISSING  ${mode} ${vw}x${vh} n=${count}: got ${placed.length}`);
        failures++;
        continue;
      }
      if (!hasNoOverlap(placed)) {
        console.log(`OVERLAP  ${mode} ${vw}x${vh} n=${count}`);
        failures++;
      }
      for (const p of placed) {
        if (!isFinite(p.x) || !isFinite(p.y) || p.width <= 0 || p.height <= 0) {
          console.log(`INVALID  ${mode} ${vw}x${vh} n=${count}: ${JSON.stringify(p)}`);
          failures++;
          break;
        }
      }

      // Idempotence: feeding the result back in must not move anything.
      const settled: LayoutNode[] = placed.map((p) => {
        const orig = nodes.find((n) => n.id === p.id)!;
        return { ...orig, x: p.x, y: p.y, width: p.width, height: p.height };
      });
      const again = runLayout(settled, region, mode, { links });
      for (const p of again) {
        const before = placed.find((q) => q.id === p.id)!;
        if (Math.abs(before.x - p.x) > 1 || Math.abs(before.y - p.y) > 1) {
          console.log(`UNSTABLE ${mode} ${vw}x${vh} n=${count}: ${p.id} moved ${before.x},${before.y} -> ${p.x},${p.y}`);
          stabilityFailures++;
          break;
        }
      }
    }
  }
}

const bb = boundingBox(runLayout(makeNodes(6, 1), makeRegion(1800, 940), 'grid', {}));
console.log(`bbox sample: ${JSON.stringify(bb)}`);
console.log(`\nchecks=${checks} overlapOrInvalid=${failures} unstable=${stabilityFailures}`);
console.log(failures === 0 && stabilityFailures === 0 ? 'PASS' : 'FAIL');
