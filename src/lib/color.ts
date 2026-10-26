// ── Colour helpers ──────────────────────────────────────────────
// Themes express colours in whatever form suited them when written:
// some are 6-digit hex (`#0E1A14`), some already carry alpha as
// `rgba(30, 58, 58, 0.56)`. Card styling used to append a hex alpha pair
// directly (`${color}CC`), which silently produces invalid CSS —
// `rgba(30,58,58,0.56)CC` — for every theme that used the rgba form. The
// browser drops the declaration, so those themes fell back to whatever
// was underneath instead of the intended translucency.

/** Clamp to the 0–1 range CSS expects for alpha. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Return `color` with its alpha replaced.
 *
 * Accepts `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb()`, `rgba()`, and CSS
 * variable references. Anything it cannot parse is returned unchanged
 * rather than mangled — a slightly-wrong colour beats an invalid
 * declaration that removes the background entirely.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = clamp01(alpha);
  if (!color) return color;

  const trimmed = color.trim();

  // Hex, 3/4/6/8 digits.
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    const h = hex[1];
    let r: number, g: number, b: number;
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else {
      return trimmed;
    }
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // rgb() / rgba(), including the modern slash-separated form.
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(trimmed);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  }

  // A var() or named colour — compose rather than guess at components.
  // color-mix keeps the original hue and is widely supported in Chromium,
  // which is the only engine Electron runs.
  if (trimmed.startsWith('var(') || /^[a-z]+$/i.test(trimmed)) {
    return `color-mix(in srgb, ${trimmed} ${Math.round(a * 100)}%, transparent)`;
  }

  return trimmed;
}

/** Parse a colour to `r,g,b` for use inside a template rgba() string. */
export function toRgbTriplet(color: string, fallback = '244,162,97'): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const h = hex[1];
    return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (rgb) return `${rgb[1]},${rgb[2]},${rgb[3]}`;
  return fallback;
}

/** Relative luminance per WCAG 2.1. */
function luminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contrast ratio between two colours, 1–21. Used to keep text readable
 *  as card translucency changes. */
export function contrastRatio(fg: string, bg: string): number {
  const parse = (c: string): [number, number, number] => {
    const t = toRgbTriplet(c, '0,0,0').split(',').map(Number);
    return [t[0] || 0, t[1] || 0, t[2] || 0];
  };
  const [r1, g1, b1] = parse(fg);
  const [r2, g2, b2] = parse(bg);
  const l1 = luminance(r1, g1, b1);
  const l2 = luminance(r2, g2, b2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
