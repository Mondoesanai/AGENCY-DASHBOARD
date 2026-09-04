// Generates the monthly report card as an SVG, and rasterises it to PNG with
// sharp. Dark, Inspiring Websites branded. Used as the email attachment and
// the dashboard/report thumbnail. Pure string building — no browser.
import { prevRow, pctDelta } from './history.js';

const C = {
  bg: '#0f1311',
  panel: '#1a221e',
  panel2: '#232d28',
  ink: '#f6f9f6',
  muted: '#c2ccc5',
  line: '#3a463f',
  green: '#46a878',
  greenSoft: '#24402f',
  pos: '#77dbaa',
  neg: '#f0906f',
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n || 0)));

function deltaText(now, before, pct) {
  if (before == null || now == null) return { t: '', c: C.muted };
  const d = pct ? pctDelta(now, before) : Math.round(now - before);
  if (d === 0) return { t: 'no change', c: C.muted };
  const up = d > 0;
  return { t: `${up ? '▲' : '▼'} ${Math.abs(d)}${pct ? '%' : ''} vs last month`, c: up ? C.pos : C.neg };
}

function crown(cx, cy, s, fill) {
  // 3-peak line crown centred on (cx,cy), overall width ~6.8s
  const p = (n) => +(n * s).toFixed(2);
  return `<g transform="translate(${cx - p(3.4)},${cy - p(1.7)})" fill="none" stroke="${fill}" stroke-width="${p(0.18)}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M0 ${p(3.4)} L ${p(1.7)} 0 L ${p(3.4)} ${p(3.4)} L ${p(5.1)} 0 L ${p(6.8)} ${p(3.4)}"/>
    <path d="M${p(0.2)} ${p(3.9)} L ${p(6.6)} ${p(3.9)}"/>
  </g>`;
}

function statTile(x, y, w, label, value, sub, subColor) {
  return `<g transform="translate(${x},${y})">
    <rect width="${w}" height="150" rx="18" fill="${C.panel2}" stroke="${C.line}"/>
    <rect x="0" y="0" width="4" height="150" rx="2" fill="${C.green}" opacity="0.5"/>
    <text x="26" y="40" fill="${C.muted}" font-size="16" font-family="Arial, sans-serif" letter-spacing="1.6">${esc(label.toUpperCase())}</text>
    <text x="26" y="99" fill="${C.ink}" font-size="54" font-weight="700" font-family="Georgia, 'Times New Roman', serif">${esc(value)}</text>
    <text x="26" y="128" fill="${subColor || C.muted}" font-size="15.5" font-family="Arial, sans-serif">${esc(sub || '')}</text>
  </g>`;
}

// smooth (cardinal-spline) path through points
function smooth(pts) {
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function chart(x, y, w, h, history) {
  const rows = (history || []).slice(-8);
  const head = `<rect width="${w}" height="${h}" rx="18" fill="${C.panel2}" stroke="${C.line}"/>
    <text x="26" y="36" fill="${C.muted}" font-size="15" font-family="Arial, sans-serif" letter-spacing="1.6">VISITORS BY MONTH</text>`;
  if (rows.length < 2) {
    return `<g transform="translate(${x},${y})">${head}
      <text x="${w / 2}" y="${h / 2 + 8}" fill="${C.faint}" font-size="17" font-family="Arial, sans-serif" text-anchor="middle">Your trend line builds as the months roll in</text>
    </g>`;
  }
  const vals = rows.map((r) => r.visitors || 0);
  const max = Math.max(...vals, 1);
  const padX = 40;
  const top = 54;
  const bot = h - 34;
  const iw = w - padX * 2;
  const step = iw / (rows.length - 1);
  const pts = vals.map((v, i) => [padX + i * step, bot - (v / max) * (bot - top)]);
  const line = smooth(pts);
  const area = `${line} L${(padX + iw).toFixed(1)} ${bot} L${padX} ${bot} Z`;
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="${padX}" y1="${(bot - f * (bot - top)).toFixed(1)}" x2="${padX + iw}" y2="${(bot - f * (bot - top)).toFixed(1)}" stroke="${C.line}" stroke-width="1" opacity="0.5"/>`)
    .join('');
  const dots = pts
    .map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === pts.length - 1 ? 5.5 : 3.5}" fill="${i === pts.length - 1 ? C.pos : C.panel2}" stroke="${C.pos}" stroke-width="2"/>`)
    .join('');
  const labels = rows
    .map((r, i) => `<text x="${(padX + i * step).toFixed(1)}" y="${h - 12}" fill="${C.faint}" font-size="12.5" font-family="Arial, sans-serif" text-anchor="middle">${esc((r.month || '').slice(5))}</text>`)
    .join('');
  return `<g transform="translate(${x},${y})">${head}${grid}
    <path d="${area}" fill="url(#areaGrad)"/>
    <path d="${line}" fill="none" stroke="${C.pos}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)"/>
    ${dots}${labels}
  </g>`;
}

// ctx: { biz, month (label e.g. "September 2026"), row, history, grade, url }
export function buildCardSVG(ctx) {
  const { biz = 'Your Business', month = '', row = {}, history = [], grade, url = '' } = ctx;
  const prev = prevRow(history);
  const W = 1200;
  const H = 630;

  const dV = deltaText(row.visitors, prev?.visitors, true);
  const dC = deltaText(row.conversions, prev?.conversions, false);
  const dS = deltaText(row.seo, prev?.seo, false);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#10161300"/>
      <stop offset="0" stop-color="${C.bg}"/>
      <stop offset="1" stop-color="#0a0d0b"/>
    </linearGradient>
    <radialGradient id="glowBg" cx="0.12" cy="0" r="0.9">
      <stop offset="0" stop-color="${C.green}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${C.green}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.pos}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="${C.pos}" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.green}"/>
      <stop offset="1" stop-color="${C.pos}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-40%" width="140%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="${C.pos}" flood-opacity="0.5"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glowBg)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="url(#bar)"/>

  <g transform="translate(58,58)">
    ${crown(24, 22, 7.2, C.ink)}
    <text x="64" y="16" fill="${C.ink}" font-size="21" font-weight="700" letter-spacing="3.4">INSPIRING WEBSITES</text>
    <text x="64" y="42" fill="${C.muted}" font-size="14.5" letter-spacing="1.2">Website Performance Report</text>
  </g>
  <text x="${W - 58}" y="82" fill="${C.muted}" font-size="18" text-anchor="end">${esc(month)}</text>
  <line x1="58" y1="112" x2="${W - 58}" y2="112" stroke="${C.line}"/>

  <text x="58" y="176" fill="${C.ink}" font-size="48" font-weight="700" font-family="Georgia, 'Times New Roman', serif">${esc(biz)}</text>
  <text x="58" y="206" fill="${C.muted}" font-size="16">${esc(url.replace(/^https?:\/\//, ''))}</text>

  ${statTile(58, 232, 350, 'Visitors · 30d', nf(row.visitors), dV.t, dV.c)}
  ${statTile(425, 232, 350, 'Enquiries', String(row.conversions ?? 0), dC.t, dC.c)}
  ${statTile(792, 232, 350, 'SEO score', row.seo != null ? `${row.seo}` : '—', dS.t, dS.c)}

  ${chart(58, 406, 700, 178, history)}

  <g transform="translate(792,406)">
    <rect width="350" height="178" rx="18" fill="${C.panel2}" stroke="${C.line}"/>
    <text x="26" y="36" fill="${C.muted}" font-size="15" letter-spacing="1.6">SITE HEALTH</text>
    <text x="26" y="132" fill="${C.ink}" font-size="92" font-weight="700" font-family="Georgia, serif">${grade ? esc(grade.letter) : '—'}</text>
    <text x="150" y="132" fill="${C.muted}" font-size="22">${grade ? esc(grade.score) + ' / 100' : ''}</text>
  </g>

  <text x="58" y="${H - 26}" fill="${C.faint}" font-size="13.5">Prepared by Inspiring Websites &#183; ${esc(
    new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  )}</text>
</svg>`;
}

export async function renderPNG(svg) {
  try {
    const { default: sharp } = await import('sharp');
    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch {
    return null;
  }
}
