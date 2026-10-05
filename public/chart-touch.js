// Charts you can actually read on a phone.
//
// Every chart on the dashboard carried its detail in a `title` attribute, and
// one of them says so out loud: "Hover a band or bar for detail." There is no
// hover on a touch screen, so on a phone that detail did not exist — the
// numbers were drawn and the values behind them were unreachable. The data was
// not missing, it was unreachable, which is worse because the chart still
// looks complete.
//
// This makes the same detail available by tap, by keyboard, and to a screen
// reader, without changing a single chart's drawing code: it works off the
// `title` attributes that are already there.
//
// Deliberate choices:
//   * `title` is KEPT, so desktop hover is untouched. This adds a second route
//     to the same text rather than replacing the first.
//   * one tooltip element, reused. A tooltip per data point is how you end up
//     with forty absolutely-positioned divs fighting for the same corner.
//   * the tooltip never covers the thing you tapped, and never leaves the
//     viewport — on a 360px screen a tooltip anchored naively to a bar on the
//     right edge is half off-screen.
//   * dismissing is unconditional: tap anywhere else, scroll, press Escape, or
//     tap the same point again. A tooltip you cannot get rid of sits on top of
//     the navigation.

const TIP_ID = 'chartTip';
const SEL = 'svg [title], svg title, .rtbar[title], [data-tip]';

let tipEl = null;
let openFor = null;

/** The one tooltip element, created on first use. */
function tip(doc) {
  if (tipEl && doc.body.contains(tipEl)) return tipEl;
  tipEl = doc.createElement('div');
  tipEl.id = TIP_ID;
  tipEl.className = 'charttip';
  tipEl.setAttribute('role', 'status');
  tipEl.setAttribute('aria-live', 'polite');
  tipEl.hidden = true;
  doc.body.appendChild(tipEl);
  return tipEl;
}

/** The detail text for an element, wherever it is stored. */
export function detailOf(el) {
  if (!el) return '';
  const direct = el.getAttribute?.('data-tip') || el.getAttribute?.('title');
  if (direct) return direct;
  // SVG <title> child, which is how an accessible SVG usually carries it
  const child = el.querySelector?.('title');
  if (child?.textContent) return child.textContent;
  // or the element IS a <title>, in which case its parent is the shape
  if (el.tagName?.toLowerCase() === 'title') return el.textContent || '';
  return '';
}

/**
 * Place the tooltip near an element without covering it or leaving the screen.
 * Pure-ish: takes measurements in, returns {left, top}.
 */
export function placeTip({ rect, tipW, tipH, vw, vh, gap = 10 }) {
  // prefer above; fall back below when there is no room
  let top = rect.top - tipH - gap;
  if (top < 8) top = rect.bottom + gap;
  if (top + tipH > vh - 8) top = Math.max(8, vh - tipH - 8);
  // centre on the element, then pull back inside the viewport
  let left = rect.left + rect.width / 2 - tipW / 2;
  if (left < 8) left = 8;
  if (left + tipW > vw - 8) left = Math.max(8, vw - tipW - 8);
  return { left: Math.round(left), top: Math.round(top) };
}

function show(doc, el, text) {
  const t = tip(doc);
  t.textContent = text;
  t.hidden = false;
  const win = doc.defaultView;
  const r = el.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  const { left, top } = placeTip({
    rect: r, tipW: tr.width, tipH: tr.height,
    vw: win.innerWidth, vh: win.innerHeight,
  });
  t.style.left = left + 'px';
  t.style.top = top + 'px';
  t.classList.add('on');
  openFor = el;
}

export function hideTip(doc = document) {
  const t = doc.getElementById(TIP_ID);
  if (t) { t.classList.remove('on'); t.hidden = true; }
  openFor = null;
}

/** Is a tooltip currently open? Exposed for tests. */
export function tipOpen(doc = document) {
  const t = doc.getElementById(TIP_ID);
  return !!t && !t.hidden;
}

/**
 * Make every chart point in `root` tappable, focusable and announced.
 *
 * Returns the number of points wired, so a caller can tell "no charts on this
 * screen" from "the wiring did not run".
 */
export function wireCharts(root = document, { doc = document } = {}) {
  if (!root || !root.querySelectorAll) return 0;
  let n = 0;
  for (const el of root.querySelectorAll(SEL)) {
    // an <svg><title> describes its parent shape, so wire the shape
    const target = el.tagName?.toLowerCase() === 'title' ? el.parentElement : el;
    if (!target || target.dataset.tapTip === '1') continue;
    const text = detailOf(el);
    if (!text) continue;
    target.dataset.tapTip = '1';
    target.setAttribute('tabindex', '0');
    target.setAttribute('role', 'button');
    // the detail is the label: a screen reader reads the value, not "path"
    target.setAttribute('aria-label', text);
    if (target.style) target.style.cursor = 'pointer';
    n++;
  }
  return n;
}

/**
 * Attach the one set of listeners. Delegated, so charts re-rendered later are
 * covered without re-binding — the dashboard redraws panels constantly and
 * per-element listeners would leak on every refresh.
 */
export function initChartTouch(doc = document) {
  if (!doc || doc.__chartTouch) return false;
  doc.__chartTouch = true;

  // CAPTURE phase, deliberately. The trend charts are drawn inside the client
  // cards, and a client card is itself a <button> that opens that client's
  // drawer. In the bubble phase the card's handler has already run by the time
  // this one sees the event, so tapping a data point to read its value also
  // navigated to the client — you could not look at a number without leaving
  // the page you were looking at. Capturing lets the point claim the tap and
  // stop it before the card ever sees it.
  doc.addEventListener('click', (e) => {
    const hit = e.target?.closest?.('[data-tap-tip="1"]');
    if (!hit) { if (tipOpen(doc)) hideTip(doc); return; }
    e.stopPropagation();
    e.preventDefault();
    // tapping the open point again closes it, so a tooltip is never stuck
    if (openFor === hit && tipOpen(doc)) { hideTip(doc); return; }
    const text = hit.getAttribute('aria-label') || detailOf(hit);
    if (text) show(doc, hit, text);
  }, true);

  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tipOpen(doc)) { hideTip(doc); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target?.dataset?.tapTip === '1') {
      e.preventDefault();
      const text = e.target.getAttribute('aria-label') || detailOf(e.target);
      if (text) show(doc, e.target, text);
    }
  });

  // a tooltip anchored to a point that has scrolled away is noise
  doc.defaultView?.addEventListener?.('scroll', () => { if (tipOpen(doc)) hideTip(doc); }, { passive: true });
  doc.defaultView?.addEventListener?.('resize', () => { if (tipOpen(doc)) hideTip(doc); });

  return true;
}

/**
 * A plain-text reading of a chart, for people who cannot use the picture and
 * for anyone on a screen too small to pick out a 3px band.
 *
 * Missing data and zero are deliberately different words: "no data" and "0"
 * mean different things and a chart that renders both as a flat line is lying
 * about one of them.
 */
export function describeSeries(points, { label = 'series', unit = '' } = {}) {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) return `${label}: no data recorded.`;
  const known = list.filter((p) => p && p.value != null && Number.isFinite(Number(p.value)));
  const missing = list.length - known.length;
  if (!known.length) return `${label}: ${list.length} point(s), none with a recorded value.`;
  const vals = known.map((p) => Number(p.value));
  const min = Math.min(...vals), max = Math.max(...vals);
  const first = known[0], last = known[known.length - 1];
  const dir = Number(last.value) > Number(first.value) ? 'up' : Number(last.value) < Number(first.value) ? 'down' : 'level';
  const u = unit ? unit : '';
  return (
    `${label}: ${known.length} point(s)` +
    (missing ? `, ${missing} with no data recorded (not zero)` : '') +
    `. From ${first.label ?? 'start'} ${first.value}${u} to ${last.label ?? 'end'} ${last.value}${u} — ${dir}.` +
    ` Low ${min}${u}, high ${max}${u}.`
  );
}
