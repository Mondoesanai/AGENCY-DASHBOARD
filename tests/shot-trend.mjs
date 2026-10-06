// Screenshot the trend control with a reading selected by the ‹ › buttons.
import puppeteer from 'puppeteer';
const w = Number(process.argv[2] || 390);
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: w, height: w < 820 ? 844 : 900, deviceScaleFactor: 2, isMobile: w < 820, hasTouch: w < 820 });
await p.goto('http://127.0.0.1:3190', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1200));
await p.evaluate(() => document.querySelector('.tabbtn[data-view="clients"]')?.click() ?? document.querySelector('.navbtn[data-view="clients"]')?.click());
await new Promise((r) => setTimeout(r, 1200));
// step forward a few readings using the real control
await p.evaluate(() => {
  const t = document.querySelector('[id^="view-"]:not([hidden]) .trend');
  t?.scrollIntoView({ block: 'center' });
  const next = t?.querySelector('.trend-nav[data-dir="1"]');
  for (let i = 0; i < 14; i++) next?.click();
});
await new Promise((r) => setTimeout(r, 400));
await p.screenshot({ path: `../temporary screenshots/dash-trendctl-${w}.png` });
console.log('saved', await p.evaluate(() => document.querySelector('[id^="view-"]:not([hidden]) .trend .trend-read')?.textContent));
await b.close();
