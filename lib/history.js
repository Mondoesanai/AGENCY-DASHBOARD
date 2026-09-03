// Month-over-month snapshots, so the reports can say "SEO 74 -> 89" and
// "+31 points since launch".
import { store } from './store.js';

const HKEY = (slug) => `history:${slug}`;
const BKEY = (slug) => `baseline:${slug}`;
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7); // YYYY-MM

export async function getHistory(slug) {
  const raw = await store.get(HKEY(slug)).catch(() => null);
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function getBaseline(slug) {
  const raw = await store.get(BKEY(slug)).catch(() => null);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// upsert this month's row; set baseline once
export async function snapshot(slug, data) {
  const month = monthKey();
  const row = {
    month,
    at: Date.now(),
    seo: data.seo ?? null,
    perf: data.perf ?? null,
    a11y: data.a11y ?? null,
    grade: data.grade ?? null,
    visitors: data.visitors ?? 0,
    conversions: data.conversions ?? 0,
    pageviews: data.pageviews ?? 0,
  };

  const hist = await getHistory(slug);
  const idx = hist.findIndex((h) => h.month === month);
  if (idx >= 0) hist[idx] = row;
  else hist.push(row);
  hist.sort((a, b) => a.month.localeCompare(b.month));
  while (hist.length > 24) hist.shift();
  await store.set(HKEY(slug), JSON.stringify(hist));

  if (!(await getBaseline(slug))) {
    await store.set(BKEY(slug), JSON.stringify(row));
  }
  return row;
}

// helper: previous month's row (not this month)
export function prevRow(hist) {
  if (!hist || hist.length < 2) return null;
  const thisMonth = monthKey();
  const past = hist.filter((h) => h.month !== thisMonth);
  return past.length ? past[past.length - 1] : null;
}

export function delta(now, before) {
  if (before == null || now == null) return null;
  return Math.round(now - before);
}
export function pctDelta(now, before) {
  if (!before) return now ? 100 : 0;
  return Math.round(((now - before) / before) * 100);
}
