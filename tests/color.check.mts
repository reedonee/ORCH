import { withAlpha, toRgbTriplet, contrastRatio } from '../src/lib/color.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  if (got === want) pass++; else { fail++; console.log(`FAIL ${l}\n  got:  ${got}\n  want: ${want}`); }
};
const ok = (l: string, cond: boolean) => { if (cond) pass++; else { fail++; console.log(`FAIL ${l}`); } };

// The two formats actually present in theme.ts
eq('6-digit hex',  withAlpha('#0E1A14', 0.72), 'rgba(14, 26, 20, 0.72)');
eq('rgba input',   withAlpha('rgba(30, 58, 58, 0.56)', 0.72), 'rgba(30, 58, 58, 0.72)');
eq('rgb input',    withAlpha('rgb(30, 58, 58)', 0.5), 'rgba(30, 58, 58, 0.5)');
eq('3-digit hex',  withAlpha('#abc', 1), 'rgba(170, 187, 204, 1)');
eq('8-digit hex',  withAlpha('#0E1A14FF', 0.3), 'rgba(14, 26, 20, 0.3)');
eq('clamps high',  withAlpha('#000000', 5), 'rgba(0, 0, 0, 1)');
eq('clamps low',   withAlpha('#000000', -2), 'rgba(0, 0, 0, 0)');
eq('var passthru', withAlpha('var(--bg)', 0.5), 'color-mix(in srgb, var(--bg) 50%, transparent)');
eq('empty safe',   withAlpha('', 0.5), '');

// The old bug: appending a hex alpha to an rgba() string produced
// invalid CSS, so those themes lost their background entirely.
const legacy = 'rgba(30, 58, 58, 0.56)' + 'CC';
ok('legacy concat was invalid CSS', !/^rgba\([\d.,\s]+\)$/.test(legacy));
ok('withAlpha output is valid', /^rgba\(\d+, \d+, \d+, [\d.]+\)$/.test(withAlpha('rgba(30, 58, 58, 0.56)', 0.7)));

eq('triplet hex', toRgbTriplet('#F4A261'), '244,162,97');
eq('triplet rgba', toRgbTriplet('rgba(1, 2, 3, 0.4)'), '1,2,3');
eq('triplet fallback', toRgbTriplet('nonsense', '9,9,9'), '9,9,9');

ok('contrast white/black is max', Math.round(contrastRatio('#FFFFFF', '#000000')) === 21);
ok('contrast same is 1', contrastRatio('#123456', '#123456') === 1);
// The default terminal fg on the default card bg must clear WCAG AA.
ok('default fg/bg passes AA', contrastRatio('#EAF4F4', '#0E1A14') >= 4.5);

console.log(`\ncolor pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
