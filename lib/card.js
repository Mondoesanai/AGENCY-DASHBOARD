// Generates the monthly report card as an SVG, and rasterises it to PNG with
// sharp. Dark, Inspiring Websites branded. Used as the email attachment and
// the dashboard/report thumbnail. Pure string building — no browser.
import { prevRow, pctDelta } from './history.js';

const C = {
  bg: '#0c0f0e',
  panel: '#141a17',
  panel2: '#1b2420',
  ink: '#f2f5f2',
  muted: '#9aa8a0',
  line: '#26302a',
  green: '#3d9968',
  greenSoft: '#1e3329',
  pos: '#49c187',
  neg: '#e0795c',
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

function crown(x, y, s, fill) {
  // simple 3-peak line crown, scaled by s
  const p = (n) => (n * s).toFixed(1);
  return `<g transform="translate(${x},${y})" fill="none" stroke="${fill}" stroke-width="${p(0.16)}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M0 ${p(3.4)} L ${p(1.7)} 0 L ${p(3.4)} ${p(3.4)} L ${p(5.1)} 0 L ${p(6.8)} ${p(3.4)} Z"/>
  </g>`;
}

function statTile(x, y, w, label, value, sub, subColor) {
  return `<g transform="translate(${x},${y})">
    <rect width="${w}" height="150" rx="16" fill="${C.panel2}" stroke="${C.line}"/>
    <text x="24" y="40" fill="${C.muted}" font-size="17" font-family="Arial, sans-serif" letter-spacing="1.5">${esc(label.toUpperCase())}</text>
    <text x="24" y="98" fill="${C.ink}" font-size="52" font-weight="700" font-family="Georgia, 'Times New Roman', serif">${esc(value)}</text>
    <text x="24" y="128" fill="${subColor || C.muted}" font-size="16" font-family="Arial, sans-serif">${esc(sub || '')}</text>
  </g>`;
}

function chart(x, y, w, h, history) {
  const rows = (history || []).slice(-8);
  if (rows.length < 2) {
    return `<g transform="translate(${x},${y})">
      <rect width="${w}" height="${h}" rx="16" fill="${C.panel2}" stroke="${C.line}"/>
      <text x="${w / 2}" y="${h / 2}" fill="${C.muted}" font-size="18" font-family="Arial, sans-serif" text-anchor="middle">Visitor trend builds as the months roll in</text>
    </g>`;
  }
  const vals = rows.map((r) => r.visitors || 0);
  const max = Math.max(...vals, 1);
  const pad = 40;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  const step = iw / (rows.length - 1);
  const pts = vals.map((v, i) => [pad + i * step, pad + ih - (v / max) * ih]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${(pad + iw).toFixed(1)} ${(pad + ih).toFixed(1)} L${pad} ${(pad + ih).toFixed(1)} Z`;
  const dots = pts
    .map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${C.pos}"/>`)
    .join('');
  const labels = rows
    .map((r, i) => {
      const m = r.month ? r.month.slice(5) : '';
      return `<text x="${(pad + i * step).toFixed(1)}" y="${h - 12}" fill="${C.muted}" font-size="13" font-family="Arial, sans-serif" text-anchor="middle">${esc(m)}</text>`;
    })
    .join('');
  return `<g transform="translate(${x},${y})">
    <rect width="${w}" height="${h}" rx="16" fill="${C.panel2}" stroke="${C.line}"/>
    <text x="24" y="34" fill="${C.muted}" font-size="16" font-family="Arial, sans-serif" letter-spacing="1.5">VISITORS BY MONTH</text>
    <path d="${area}" fill="${C.greenSoft}" opacity="0.6"/>
    <path d="${line}" fill="none" stroke="${C.pos}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${C.green}"/>
  <g transform="translate(56,54)">
    ${crown(0, 6, 7, C.ink)}
    <text x="66" y="20" fill="${C.ink}" font-size="20" font-weight="700" letter-spacing="3" font-family="Arial, sans-serif">INSPIRING WEBSITES</text>
    <text x="66" y="44" fill="${C.muted}" font-size="15" letter-spacing="1" font-family="Arial, sans-serif">Website Performance Report</text>
  </g>
  <text x="${W - 56}" y="80" fill="${C.muted}" font-size="18" font-family="Arial, sans-serif" text-anchor="end">${esc(month)}</text>

  <text x="56" y="168" fill="${C.ink}" font-size="46" font-weight="700" font-family="Georgia, 'Times New Roman', serif">${esc(biz)}</text>
  <text x="56" y="198" fill="${C.muted}" font-size="16" font-family="Arial, sans-serif">${esc(url.replace(/^https?:\/\//, ''))}</text>

  ${statTile(56, 224, 352, 'Visitors · 30d', nf(row.visitors), dV.t, dV.c)}
  ${statTile(424, 224, 352, 'Enquiries', String(row.conversions ?? 0), dC.t, dC.c)}
  ${statTile(792, 224, 352, 'SEO score', row.seo != null ? `${row.seo}` : '—', dS.t, dS.c)}

  ${chart(56, 398, 700, 180, history)}

  <g transform="translate(792,398)">
    <rect width="352" height="180" rx="16" fill="${C.panel2}" stroke="${C.line}"/>
    <text x="24" y="34" fill="${C.muted}" font-size="16" letter-spacing="1.5" font-family="Arial, sans-serif">SITE HEALTH</text>
    <text x="24" y="118" fill="${C.ink}" font-size="78" font-weight="700" font-family="Georgia, serif">${grade ? esc(grade.letter) : '—'}</text>
    <text x="150" y="118" fill="${C.muted}" font-size="22" font-family="Arial, sans-serif">${grade ? esc(grade.score) + ' / 100' : ''}</text>
  </g>

  <text x="56" y="${H - 28}" fill="${C.muted}" font-size="14" font-family="Arial, sans-serif">Prepared by Inspiring Websites · ${esc(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}</text>
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
