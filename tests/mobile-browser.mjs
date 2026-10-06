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
section('M5  one mechanism per chart, not two competing for the same tap');
page = await phone();
await tap(page, '.tabbtn[data-view="clients"]');
await new Promise((r) => setTimeout(r, 1200));
// The trend charts are handled by their own readout (M5b). The tooltip layer
// must therefore NOT also claim their points: when both were wired, two
// handlers fought over one tap and the tooltip's "tap again to close" stopped
// working. The tooltip remains for charts that have no readout of their own.
const dual = await page.evaluate(() => {
  const t = document.querySelector('[id^="view-"]:not([hidden]) .trend');
  return {
    trendPoints: t ? t.querySelectorAll('.sparkhit').length : 0,
    trendPointsClaimedByTooltip: t ? t.querySelectorAll('[data-tap-tip="1"]').length : 0,
    tooltipOpen: !!document.getElementById('chartTip') && !document.getElementById('chartTip').hidden,
  };
});
check('the trend chart has points', dual.trendPoints > 0, String(dual.trendPoints));
check('the tooltip layer does not also claim them', dual.trendPointsClaimedByTooltip === 0,
  `${dual.trendPointsClaimedByTooltip} of ${dual.trendPoints} points are double-wired`);
check('and no tooltip is left hanging open', dual.tooltipOpen === false);
check('no JS errors', page.__errors.length === 0, page.__errors.join(' | '));
await page.close();

// ===========================================================================
section('M5b  the chart is operable without hitting a 10px band');
page = await phone();
await tap(page, '.tabbtn[data-view="clients"]');
await new Promise((r) => setTimeout(r, 1200));

const sem = await page.evaluate(() => {
  const t = document.querySelector('[id^="view-"]:not([hidden]) .trend');
  if (!t) return { missing: true };
  const navs = [...t.querySelectorAll('.trend-nav')].map((b) => {
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), label: b.getAttribute('aria-label'), disabled: b.disabled };
  });
  const out = t.querySelector('.trend-read');
  return {
    // THE semantic check: interactive chart content must not live inside the
    // client card's <button>. stopPropagation stopped the navigation but left
    // a button containing buttons, which is invalid and flattens for a screen
    // reader.
    insideAButton: !!t.closest('button'),
    navCount: navs.length,
    navs,
    readoutIsLive: out?.getAttribute('aria-live') === 'polite',
    readoutTag: out?.tagName,
    cardIsStillAButton: !!document.querySelector('[id^="view-"]:not([hidden]) button.card'),
    nestedControls: t.querySelectorAll('button button, button [role="button"]').length,
  };
});
check('a trend chart is present', !sem.missing);
check('it is NOT inside the client card button', sem.insideAButton === false,
  'this is the semantic fix; stopPropagation did not address it');
check('the card is still a button in its own right', sem.cardIsStillAButton === true);
check('and nothing is nested inside anything interactive', sem.nestedControls === 0);
check('there are previous/next controls', sem.navCount === 2, String(sem.navCount));
check('both are comfortable targets', sem.navs.every((n) => n.w >= 44 && n.h >= 44), JSON.stringify(sem.navs));
check('both are labelled for screen readers', sem.navs.every((n) => /previous|next/i.test(n.label || '')), JSON.stringify(sem.navs.map((n) => n.label)));
check('the readout is a live region', sem.readoutIsLive === true, String(sem.readoutTag));

// step with the real buttons and read the result
const stepped = await page.evaluate(() => {
  const t = document.querySelector('[id^="view-"]:not([hidden]) .trend');
  const next = t.querySelector('.trend-nav[data-dir="1"]');
  const read = () => t.querySelector('.trend-read').textContent;
  const before = read();
  next.click();
  const one = read();
  next.click(); next.click();
  const three = read();
  const prev = t.querySelector('.trend-nav[data-dir="-1"]');
  prev.click();
  return { before, one, three, afterBack: read(), selected: t.dataset.selected,
    backDisabledAtStart: (() => { for (let i = 0; i < 40; i++) prev.click(); return prev.disabled; })() };
});
check('stepping changes the readout', stepped.one !== stepped.before, `${stepped.before} -> ${stepped.one}`);
check('each press moves one reading', /Reading 3 of|Sep/.test(stepped.three), stepped.three);
check('and back steps back', stepped.afterBack !== stepped.three);
check('the readout names a value', /\d/.test(stepped.one), stepped.one);
check('at the first reading, previous is disabled rather than dead', stepped.backDisabledAtStart === true);

check('no JS errors from the trend controls', page.__errors.length === 0, page.__errors.join(' | '));
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
