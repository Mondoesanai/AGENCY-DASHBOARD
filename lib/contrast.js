// R2.7 — contrast as arithmetic, not opinion.
//
// A design system can be checked without a browser: the token values are in
// the stylesheet, the WCAG formula is fixed, and the pairs that actually get
// used together are knowable. This module is what the test suite uses to hold
// the palette to a number, so "accessible contrast" cannot quietly become
// "looked fine on my monitor".
//
// The browser audit is still the primary evidence — it measures what is
// rendered, including translucent layers this cannot see. This catches the
// other half: a token edited to an unreadable value fails the suite
// immediately, long before anyone opens a page.

/** #rgb / #rrggbb / rgb() / rgba() → {r,g,b,a}. */
export function parseColor(c) {
  const s = String(c || '').trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** Flatten a translucent colour onto what is behind it. */
export function flatten(fg, bg) {
  if (!fg || !bg) return fg;
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

export function relativeLuminance({ r, g, b }) {
  const f = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrastRatio(a, b) {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) return null;
  const fa = flatten(ca, cb);
  const l1 = relativeLuminance(fa);
  const l2 = relativeLuminance(cb);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
}

/** What a given size and weight has to reach. 18.66px bold or 24px counts as large. */
export function required(sizePx, weight = 400) {
  return sizePx >= 24 || (sizePx >= 18.66 && weight >= 700) ? 3 : 4.5;
}

/** Pull `--name: value;` declarations out of a stylesheet or an HTML file. */
export function readTokens(css) {
  const out = {};
  for (const m of String(css).matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    const v = m[2].trim();
    if (parseColor(v)) out[m[1]] = v;
  }
  return out;
}
