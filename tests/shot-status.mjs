// Screenshot the contact-permissions panel. node tests/shot-status.mjs <width>
import puppeteer from 'puppeteer';
const w = Number(process.argv[2] || 390);
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: w, height: w < 800 ? 900 : 1000, deviceScaleFactor: 2, isMobile: w < 800, hasTouch: w < 800 });
await p.goto('http://127.0.0.1:3190', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1200));
await p.evaluate(() => (document.querySelector('.tabbtn[data-view="followups"]') || document.querySelector('.navbtn[data-view="followups"]'))?.click());
await new Promise((r) => setTimeout(r, 1800));
await p.evaluate(() => document.querySelector('#csSummary')?.scrollIntoView({ block: 'start' }));
await new Promise((r) => setTimeout(r, 400));
await p.screenshot({ path: `../temporary screenshots/dash-status-${w}.png` });
console.log('saved dash-status-' + w + '.png');
await b.close();
