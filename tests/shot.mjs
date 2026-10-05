// Screenshot the dashboard at a given width. node tests/shot.mjs <width> <label> [view]
import puppeteer from 'puppeteer';
const BASE = 'http://127.0.0.1:3190';
const w = Number(process.argv[2] || 390);
const label = process.argv[3] || 'shot';
const view = process.argv[4] || '';
const full = process.argv.includes('--full');

const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: w, height: w < 820 ? 844 : 900, deviceScaleFactor: 2, isMobile: w < 820, hasTouch: w < 820 });
await p.goto(BASE, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1200));
if (view) {
  await p.evaluate((v) => {
    const el = [...document.querySelectorAll('[data-view],[data-nav],nav a,nav button')]
      .find((e) => (e.getAttribute('data-view') || e.getAttribute('data-nav') || e.textContent || '').toLowerCase().includes(v));
    if (el) el.click();
  }, view.toLowerCase());
  await new Promise((r) => setTimeout(r, 1000));
}
await p.screenshot({ path: `../temporary screenshots/dash-${label}.png`, fullPage: full });
console.log(`saved dash-${label}.png`);
await b.close();
