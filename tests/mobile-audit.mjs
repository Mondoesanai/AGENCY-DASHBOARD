// What the dashboard actually does at phone widths.
//
// Not a pass/fail suite — a survey. It opens each view at each width with
// touch emulation on and reports the things that make a page feel unfinished:
// horizontal overflow, text below 12px, tap targets under 44px, controls that
// run off the viewport, and anything that only responds to hover.
//
// Run: node tests/mobile-audit.mjs [baseUrl]
import puppeteer from 'puppeteer';

const BASE = process.argv[2] || 'http://127.0.0.1:3190';
const WIDTHS = [
  { w: 360, h: 740, label: '360 (small Android)' },
  { w: 390, h: 844, label: '390 (iPhone 14/15)' },
  { w: 430, h: 932, label: '430 (iPhone Pro Max)' },
  { w: 820, h: 1180, label: '820 (tablet)' },
  { w: 1440, h: 900, label: '1440 (desktop)' },
];

// the real view ids from public/nav.js — an earlier version of this file used
// invented names, which all resolved to Overview, so every row in the report
// was the same page measured five times
const VIEWS = ['overview', 'clients', 'acquisition', 'followups', 'automations', 'settings'];

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

async function audit(view, { w, h, label }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: w < 820, hasTouch: w < 820 });
  await page.goto(`${BASE}/#${view}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 900));

  const data = await page.evaluate(() => {
    const vw = window.innerWidth;
    const out = {
      scrollW: document.documentElement.scrollWidth,
      innerW: vw,
      overflow: document.documentElement.scrollWidth > vw + 1,
      tiny: [], small: [], wide: [], hoverOnly: 0, offscreen: [],
    };
    // elements wider than the viewport
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      if (r.width > vw + 2 && el.children.length < 30) {
        const tag = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '');
        if (out.wide.length < 8) out.wide.push({ el: tag, width: Math.round(r.width) });
      }
      if (r.right > vw + 2 && r.left >= vw - 2 && out.offscreen.length < 6) {
        out.offscreen.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
      }

      // text size
      const fs = parseFloat(cs.fontSize);
      const hasText = el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (hasText && fs && fs < 12 && out.tiny.length < 8) {
        out.tiny.push({ el: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''), px: +fs.toFixed(1), text: el.textContent.trim().slice(0, 28) });
      }

      // tap targets
      if (/^(button|a|input|select|summary)$/.test(el.tagName.toLowerCase()) || el.getAttribute('role') === 'button' || el.hasAttribute('data-go')) {
        if (r.height > 0 && (r.height < 44 || r.width < 44) && out.small.length < 10) {
          out.small.push({
            el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''),
            w: Math.round(r.width), h: Math.round(r.height),
            text: (el.textContent || '').trim().slice(0, 24),
          });
        }
      }
    }
    return out;
  });

  // hover-only affordances: rules that only reveal under :hover
  const hoverOnly = await page.evaluate(() => {
    let n = 0;
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules || []) {
        if (!r.selectorText || !/:hover/.test(r.selectorText)) continue;
        const t = r.style?.cssText || '';
        if (/opacity:\s*1|display:\s*(block|flex|grid)|visibility:\s*visible|max-height/.test(t)) n++;
      }
    }
    return n;
  });

  await page.close();
  return { view, label, ...data, hoverOnly, errors };
}

const rows = [];
for (const view of VIEWS) {
  for (const vp of WIDTHS) rows.push(await audit(view, vp));
}
await browser.close();

// ---- report
const bad = (r) => r.overflow || r.tiny.length || r.small.length || r.wide.length || r.errors.length;
console.log('\n=== MOBILE AUDIT ===\n');
for (const r of rows) {
  const flags = [];
  if (r.overflow) flags.push(`OVERFLOW ${r.scrollW}>${r.innerW}`);
  if (r.wide.length) flags.push(`${r.wide.length} too wide`);
  if (r.tiny.length) flags.push(`${r.tiny.length} tiny text`);
  if (r.small.length) flags.push(`${r.small.length} small taps`);
  if (r.offscreen.length) flags.push(`${r.offscreen.length} offscreen`);
  if (r.errors.length) flags.push(`${r.errors.length} JS errors`);
  console.log(`${bad(r) ? 'x' : 'ok'}  ${r.view.padEnd(12)} ${r.label.padEnd(22)} ${flags.join(' · ') || 'clean'}`);
  if (r.wide.length) for (const x of r.wide.slice(0, 4)) console.log(`        wide: ${x.el} = ${x.width}px`);
  if (r.small.length) for (const x of r.small.slice(0, 5)) console.log(`        tap:  ${x.el} ${x.w}x${x.h} "${x.text}"`);
  if (r.tiny.length) for (const x of r.tiny.slice(0, 4)) console.log(`        text: ${x.el} ${x.px}px "${x.text}"`);
  if (r.errors.length) for (const x of r.errors.slice(0, 2)) console.log(`        err:  ${x}`);
}
console.log(`\nhover-only CSS rules that reveal content: ${rows[0]?.hoverOnly ?? '?'}`);
console.log(`\n${rows.filter(bad).length} of ${rows.length} view/width combinations have issues.`);
