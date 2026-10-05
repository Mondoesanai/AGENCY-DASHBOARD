// The mobile dashboard, driven the way a thumb drives it.
//
// Touch emulation in headless Chrome — NOT a physical device. That distinction
// matters and is reported honestly at the end: this proves the layout, the hit
// targets and the handlers; it does not prove how it feels on real glass, how
// iOS Safari handles the home indicator, or how a real on-screen keyboard
// resizes the viewport.
//
// Everything here is a real interaction: taps dispatched at coordinates,
// scrolling, typing into fields. Nothing is asserted from source text.
import puppeteer from 'puppeteer';

const BASE = process.argv[2] || 'http://127.0.0.1:3190';
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `  → ${d}` : ''}`); } };
const section = (s) => console.log(`\n${s}`);

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

async function phone(w = 390, h = 844) {
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1200));
  p.__errors = errors;
  return p;
}

/**
 * Tap an element by coordinates read in the page.
 *
 * Puppeteer's boundingBox() goes through DOM.getBoxModel, which returns null
 * for SVG child elements — so the chart points, which are <circle>s, cannot be
 * tapped the normal way. Reading the client rect in-page and tapping those
 * coordinates is still a real touch event at a real position.
 */
async function tapAt(page, selector) {
  // bring the first rendered match into view, then measure where it landed
  await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, selector);
  await new Promise((r) => setTimeout(r, 400));
  const box = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!box) throw new Error(`no visible, on-screen element for ${selector}`);
  await page.touchscreen.tap(box.x, box.y);
  await new Promise((r) => setTimeout(r, 350));
}

/** A real tap at the element's centre, the way a finger lands. */
async function tap(page, selector) {
  // The first DOM match may sit inside a hidden section — every view is in the
  // page at once and only one is shown. Tap something a thumb could reach.
  const handles = await page.$$(selector);
  let el = null;
  for (const h of handles) {
    const box = await h.boundingBox();
    if (box && box.width > 0 && box.height > 0) { el = h; break; }
  }
  if (!el) el = handles[0];
  if (!el) throw new Error(`no element ${selector}`);
  await el.scrollIntoView().catch(() => {});
  await new Promise((r) => setTimeout(r, 120));
  const box = await el.boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 350));
}

// ===========================================================================
section('M1  the bottom tab bar is the navigation on a phone');
let page = await phone();
let nav = await page.evaluate(() => {
  const bar = document.getElementById('tabBar');
  const top = document.getElementById('mainNav');
  const cs = bar ? getComputedStyle(bar) : null;
  const r = bar?.getBoundingClientRect();
  return {
    exists: !!bar,
    visible: cs && cs.display !== 'none',
    topHidden: top ? getComputedStyle(top).display === 'none' : null,
    fixed: cs?.position === 'fixed',
    atBottom: r ? Math.abs(r.bottom - window.innerHeight) < 2 : false,
    tabs: [...(bar?.querySelectorAll('.tabbtn') || [])].map((b) => ({
      view: b.dataset.view, label: b.textContent.trim(),
      h: Math.round(b.getBoundingClientRect().height),
      w: Math.round(b.getBoundingClientRect().width),
      current: b.getAttribute('aria-current'),
    })),
  };
});
check('the tab bar exists', nav.exists);
check('it is visible on a phone', nav.visible);
check('the wrapping top nav is hidden instead', nav.topHidden === true);
check('it is pinned to the bottom', nav.fixed && nav.atBottom, JSON.stringify({ fixed: nav.fixed, atBottom: nav.atBottom }));
check('every section is reachable', nav.tabs.length === 6, String(nav.tabs.length));
check('every tab clears a 44px target', nav.tabs.every((t) => t.h >= 44), JSON.stringify(nav.tabs.map((t) => t.h)));
check('no tab is too narrow to hit', nav.tabs.every((t) => t.w >= 44), JSON.stringify(nav.tabs.map((t) => t.w)));
check('exactly one is marked current', nav.tabs.filter((t) => t.current === 'page').length === 1);
check('and it is the section being shown', nav.tabs.find((t) => t.current === 'page')?.view === 'overview');

section('M2  tapping a tab changes section, and says so');
await tap(page, '.tabbtn[data-view="clients"]');
let after = await page.evaluate(() => ({
  shown: [...document.querySelectorAll('[id^="view-"]')].filter((s) => !s.hidden).map((s) => s.id),
  current: document.querySelector('.tabbtn[aria-current="page"]')?.dataset.view,
  hash: location.hash,
  scrollY: window.scrollY,
}));
check('the clients section is shown', after.shown.includes('view-clients'), JSON.stringify(after.shown));
check('and only that one', after.shown.length === 1, JSON.stringify(after.shown));
check('the tab bar marks it current', after.current === 'clients', after.current);
check('the URL reflects it, so it survives a reload', after.hash === '#clients', after.hash);
check('and the new section starts at the top', after.scrollY === 0, String(after.scrollY));

await tap(page, '.tabbtn[data-view="settings"]');
check('a second tap moves on', (await page.evaluate(() => document.querySelector('.tabbtn[aria-current="page"]')?.dataset.view)) === 'settings');
await tap(page, '.tabbtn[data-view="overview"]');
check('and back', (await page.evaluate(() => document.querySelector('.tabbtn[aria-current="page"]')?.dataset.view)) === 'overview');

section('M3  nothing important sits under the bar or off the edge');
const clear = await page.evaluate(() => {
  const bar = document.getElementById('tabBar').getBoundingClientRect();
  const over = [];
  for (const sel of ['.coach-bubble', '.bulkbar', '.toast']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > bar.top + 1) over.push({ sel, bottom: Math.round(r.bottom), barTop: Math.round(bar.top) });
  }
  const style = getComputedStyle(document.body);
  return {
    over,
    bodyPad: parseInt(style.paddingBottom, 10) || 0,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
  };
});
check('the assistant bubble does not cover the tab bar', clear.over.length === 0, JSON.stringify(clear.over));
check('content is padded clear of the bar', clear.bodyPad >= 56, String(clear.bodyPad));
check('no horizontal page scroll', clear.overflow === false, `${clear.scrollW} vs ${clear.innerW}`);

section('M4  the header is one scrollable row, not three stacked ones');
const head = await page.evaluate(() => {
  const ta = document.querySelector('.top-actions');
  if (!ta) return null;
  const cs = getComputedStyle(ta);
  // Items of different heights on ONE flex row have different `top` values,
  // so counting distinct tops reports two rows for a correct layout. What
  // actually means "same row" is that every item overlaps the first one
  // vertically.
  const kids = [...ta.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
  const base = kids[0];
  const sameRow = kids.every((r) => r.top < base.bottom && r.bottom > base.top);
  return {
    nowrap: cs.flexWrap === 'nowrap',
    scrolls: ta.scrollWidth > ta.clientWidth,
    rows: sameRow ? 1 : 2,
    tops: kids.map((r) => Math.round(r.top)),
    btnHeights: [...ta.querySelectorAll('.btn')].map((b) => Math.round(b.getBoundingClientRect().height)),
  };
});
check('the controls are on one row', head && head.rows === 1, JSON.stringify(head));
check('they do not wrap', head?.nowrap === true);
check('the row scrolls to reach the rest', head?.scrolls === true);
check('every header button clears 44px', head?.btnHeights.every((h) => h >= 44), JSON.stringify(head?.btnHeights));

check('no JS errors so far', page.__errors.length === 0, page.__errors.join(' | '));
await page.close();

// ===========================================================================
section('M5  charts respond to a tap, not only to a mouse');
page = await phone();
// the visitor trend sparklines live on the client cards
await tap(page, '.tabbtn[data-view="clients"]');
await new Promise((r) => setTimeout(r, 1200));

const VISIBLE_PT = '[id^="view-"]:not([hidden]) [data-tap-tip="1"]';
let chart = await page.evaluate((sel) => {
  const pts = [...document.querySelectorAll(sel)];
  return {
    wired: pts.length,
    labelled: pts.filter((p) => (p.getAttribute('aria-label') || '').length > 3).length,
    focusable: pts.filter((p) => p.getAttribute('tabindex') === '0').length,
    asButton: pts.filter((p) => p.getAttribute('role') === 'button').length,
    firstLabel: pts[0]?.getAttribute('aria-label') || '',
  };
}, VISIBLE_PT);
check('chart points are wired for tapping', chart.wired > 0, `${chart.wired} points`);
if (chart.wired > 0) {
  check('each carries its detail as an accessible label', chart.labelled === chart.wired, `${chart.labelled}/${chart.wired}`);
  check('each is keyboard focusable', chart.focusable === chart.wired, `${chart.focusable}/${chart.wired}`);
  check('and announced as something you can press', chart.asButton === chart.wired);
  check('the label carries real values, not a placeholder', /\d/.test(chart.firstLabel), chart.firstLabel.slice(0, 70));

  await tapAt(page, VISIBLE_PT);
  let t = await page.evaluate(() => {
    const el = document.getElementById('chartTip');
    if (!el || el.hidden) return { open: false };
    const r = el.getBoundingClientRect();
    return { open: true, text: el.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
  });
  check('tapping a point opens its detail', t.open === true);
  check('the detail has content', (t.text || '').length > 5, (t.text || '').slice(0, 70));
  check('the tooltip stays on screen horizontally', t.open && t.left >= 0 && t.right <= t.vw + 1, `${t.left}..${t.right} of ${t.vw}`);
  check('and vertically', t.open && t.top >= 0 && t.bottom <= t.vh + 1, `${t.top}..${t.bottom} of ${t.vh}`);

  // dismissal — a tooltip you cannot close sits on top of the navigation.
  // The tap has to land on inert space: the client cards are <button>s, so a
  // naive tap near the left edge opens a drawer and the next check then
  // measures a different screen.
  // Probe for a point that lands on nothing interactive, rather than guessing
  // a coordinate. Guessing cost a hang: a tap near the left edge hit a client
  // card (they are <button>s), the drawer opened, and its scrim then swallowed
  // the next touch event until the protocol timed out.
  const inert = await page.evaluate(() => {
    const interactive = 'button,a,input,select,textarea,[role="button"],[data-tap-tip],[onclick]';
    for (let y = 8; y < window.innerHeight - 80; y += 12) {
      for (const x of [4, window.innerWidth - 4, window.innerWidth / 2]) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (el.closest(interactive)) continue;
        return { x, y };
      }
    }
    return null;
  });
  check('there is somewhere inert to tap', !!inert, 'every probed point was interactive');
  if (inert) {
    await page.touchscreen.tap(inert.x, inert.y);
    await new Promise((r) => setTimeout(r, 250));
    check('tapping elsewhere dismisses it', (await page.evaluate(() => !!document.getElementById('chartTip')?.hidden)) === true);
    check('and that tap did not open a drawer',
      (await page.evaluate(() => !document.querySelector('.drawer.open'))) === true);
  }

  await tapAt(page, VISIBLE_PT);
  check('it reopens', (await page.evaluate(() => !document.getElementById('chartTip')?.hidden)) === true);
  await tapAt(page, VISIBLE_PT);
  check('tapping the same point again closes it', (await page.evaluate(() => !!document.getElementById('chartTip')?.hidden)) === true);

  await tapAt(page, VISIBLE_PT);
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  check('Escape closes it too', (await page.evaluate(() => !!document.getElementById('chartTip')?.hidden)) === true);

  await tapAt(page, VISIBLE_PT);
  await page.evaluate(() => window.scrollBy(0, 200));
  await new Promise((r) => setTimeout(r, 300));
  check('scrolling away closes it rather than leaving it floating',
    (await page.evaluate(() => !!document.getElementById('chartTip')?.hidden)) === true);

  check('the tooltip never blocks the tab bar',
    (await page.evaluate(() => {
      const t = document.getElementById('chartTip');
      return !t || t.hidden || getComputedStyle(t).pointerEvents === 'none';
    })) === true);
}
check('no JS errors from the chart layer', page.__errors.length === 0, page.__errors.join(' | '));
await page.close();

// ===========================================================================
section('M6  the same thing works at 360 and 430');
for (const w of [360, 430]) {
  const p = await phone(w);
  const r = await p.evaluate(() => {
    const bar = document.getElementById('tabBar');
    const tabs = [...bar.querySelectorAll('.tabbtn')];
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      minTabW: Math.min(...tabs.map((t) => t.getBoundingClientRect().width)),
      minTabH: Math.min(...tabs.map((t) => t.getBoundingClientRect().height)),
      labelsVisible: tabs.every((t) => t.querySelector('span')?.getBoundingClientRect().width > 0),
    };
  });
  check(`${w}px: no horizontal overflow`, r.overflow === false);
  check(`${w}px: tabs are still ${Math.round(r.minTabH)}px tall`, r.minTabH >= 44, String(r.minTabH));
  check(`${w}px: every tab label still renders`, r.labelsVisible === true);
  await p.close();
}

// ===========================================================================
section('M7  forms and the on-screen keyboard');
page = await phone();
await tap(page, '.tabbtn[data-view="clients"]');
const addBtn = await page.$('#addBtn');
if (addBtn) {
  await tap(page, '#addBtn');
  const form = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input:not([type=hidden])')].filter((i) => i.offsetParent !== null);
    return {
      count: inputs.length,
      // <16px font on iOS makes Safari zoom the whole page on focus
      fontSizes: inputs.map((i) => parseFloat(getComputedStyle(i).fontSize)),
      widths: inputs.map((i) => Math.round(i.getBoundingClientRect().width)),
      vw: window.innerWidth,
    };
  });
  if (form.count) {
    check('no input is small enough to trigger iOS zoom', form.fontSizes.every((f) => f >= 16), JSON.stringify(form.fontSizes));
    check('no input is wider than the screen', form.widths.every((w) => w <= form.vw), JSON.stringify(form.widths));
  } else {
    check('the add-site form opened', false, 'no visible inputs found');
  }
} else {
  console.log('  --   no add-site button on this screen, skipped');
}
check('no JS errors in the form flow', page.__errors.length === 0, page.__errors.join(' | '));
await page.close();

await browser.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
console.log('NOTE: Chrome touch emulation, not a physical device. Real-glass feel,');
console.log('      iOS Safari safe areas and real keyboard resize are NOT covered.');
process.exit(fail === 0 ? 0 : 1);
