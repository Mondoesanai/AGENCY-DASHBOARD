// Reading a 30-day trend on a phone without having to hit a 10px band.
//
// WHY. The trend chart was made tappable, and that was still not enough to
// call it operable. Thirty readings across a phone-width card leaves about ten
// pixels per reading. Ten pixels is a target you miss, and missing selects the
// wrong day silently — you get a number, it is just not the number you were
// aiming at, which is worse than getting none.
//
// So tapping is now one of three ways in, and the least precise one:
//
//   tap        — fine when the days are far apart or you only want the shape
//   ‹ ›        — 44px buttons that step one reading at a time, so the exact
//                day is always reachable without aiming at all
//   keyboard   — the same stepping, with arrow keys, once the chart has focus
//
// Whichever you use, the answer appears in one place: a live region under the
// chart that reads "Sep 14: 128 visitors". A screen reader announces it
// because it is an <output aria-live>, not because of anything chart-specific.

export const STEP_KEYS = Object.freeze(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** Parse the series a `.trend` element carries. Tolerant: bad JSON is no data. */
export function seriesOf(el) {
  const read = (attr) => {
    try {
      const v = JSON.parse(el?.getAttribute(attr) || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  };
  const values = read('data-values');
  const labels = read('data-labels');
  return { values, labels };
}

/**
 * How a reading reads out.
 *
 * "no reading" and "0" are deliberately different sentences: a day nobody
 * measured and a day nobody visited are different facts, and a chart that
 * draws both at the baseline has already blurred them once.
 */
export function readingText(values, labels, i, { unit = 'visitors' } = {}) {
  if (!Array.isArray(values) || !values.length) return 'No readings yet';
  const n = Math.max(0, Math.min(values.length - 1, i));
  const v = values[n];
  const when = labels && labels[n] ? labels[n] : `Reading ${n + 1} of ${values.length}`;
  if (v == null || !Number.isFinite(Number(v))) return `${when}: no reading recorded`;
  return `${when}: ${v} ${unit}`;
}

/** Clamp an index into the series, wrapping at neither end. */
export function stepIndex(current, dir, length) {
  if (!length) return 0;
  const next = (Number.isInteger(current) ? current : -1) + dir;
  return Math.max(0, Math.min(length - 1, next));
}

/** Which point element belongs to index i. */
const pointAt = (el, i) => el.querySelectorAll('.sparkhit')[i] || null;

/** Show reading `i` — update the readout and mark the point as selected. */
export function select(el, i, { unit = 'visitors' } = {}) {
  const { values, labels } = seriesOf(el);
  if (!values.length) return -1;
  const n = Math.max(0, Math.min(values.length - 1, i));
  const out = el.querySelector('.trend-read');
  if (out) out.textContent = readingText(values, labels, n, { unit });
  for (const p of el.querySelectorAll('.sparkhit.on')) p.classList.remove('on');
  const pt = pointAt(el, n);
  if (pt) pt.classList.add('on');
  el.dataset.selected = String(n);
  // the ‹ › buttons say when they can go no further, rather than looking live
  // and doing nothing
  for (const b of el.querySelectorAll('.trend-nav')) {
    const dir = Number(b.dataset.dir);
    b.disabled = (dir < 0 && n === 0) || (dir > 0 && n === values.length - 1);
  }
  return n;
}

/**
 * Wire every `.trend` inside `root`. Idempotent — the dashboard re-renders
 * cards constantly and a second pass must not stack listeners.
 *
 * Returns how many were wired, so "no charts here" is distinguishable from
 * "the wiring did not run".
 */
export function wireTrends(root = document, { unit = 'visitors' } = {}) {
  if (!root || !root.querySelectorAll) return 0;
  const els = root.matches?.('.trend') ? [root] : [...root.querySelectorAll('.trend')];
  let n = 0;
  for (const el of els) {
    if (el.dataset.wired === '1') continue;
    el.dataset.wired = '1';
    n++;
    const { values } = seriesOf(el);
    const svg = el.querySelector('svg');
    if (svg && values.length) {
      // the chart itself is one stop in the tab order, not thirty
      svg.setAttribute('tabindex', '0');
      svg.setAttribute('role', 'img');
    }
    if (!values.length) {
      for (const b of el.querySelectorAll('.trend-nav')) b.disabled = true;
      continue;
    }

    el.addEventListener('click', (e) => {
      const nav = e.target.closest?.('.trend-nav');
      if (nav) {
        const cur = Number(el.dataset.selected ?? -1);
        select(el, stepIndex(Number.isInteger(cur) && cur >= 0 ? cur : (Number(nav.dataset.dir) > 0 ? -1 : values.length), Number(nav.dataset.dir), values.length), { unit });
        return;
      }
      const hit = e.target.closest?.('.sparkhit');
      if (!hit) return;
      const idx = [...el.querySelectorAll('.sparkhit')].indexOf(hit);
      if (idx >= 0) select(el, idx, { unit });
    });

    el.addEventListener('keydown', (e) => {
      if (!STEP_KEYS.includes(e.key)) return;
      const cur = Number(el.dataset.selected ?? -1);
      e.preventDefault();
      if (e.key === 'Home') return void select(el, 0, { unit });
      if (e.key === 'End') return void select(el, values.length - 1, { unit });
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const from = Number.isInteger(cur) && cur >= 0 ? cur : (dir > 0 ? -1 : values.length);
      select(el, stepIndex(from, dir, values.length), { unit });
    });
  }
  return n;
}
