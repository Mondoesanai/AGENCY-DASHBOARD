// Rolls up what the automation actually costs — Compass chat + the SEO agent —
// from the spend counters those features write (coach:spend:<month>,
// agent:spend:<month>). Surfaced as a real expense line in Company stats,
// Lifetime sales and Receipts so the books always reflect the true number.
import { store } from './store.js';

export const MONTH_NOW = () => new Date().toISOString().slice(0, 7);

async function num(key) {
  const v = await store.get(key).catch(() => null);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// note a month has AI spend so allAiCost() can find it later
export async function markAiMonth(month) {
  await store.sadd('ai:spend:months', month || MONTH_NOW()).catch(() => {});
}

export async function aiCostForMonth(month) {
  const m = month || MONTH_NOW();
  const [coach, agent] = await Promise.all([num(`coach:spend:${m}`), num(`agent:spend:${m}`)]);
  return { month: m, coach: +coach.toFixed(2), agent: +agent.toFixed(2), total: +(coach + agent).toFixed(2) };
}

// every month we've recorded any AI spend for, oldest first, plus the total
export async function allAiCost() {
  let months = [];
  try {
    months = (await store.smembers('ai:spend:months')) || [];
  } catch {
    months = [];
  }
  const now = MONTH_NOW();
  if (!months.includes(now)) months.push(now);
  months = [...new Set(months)].sort();
  const rows = await Promise.all(months.map((m) => aiCostForMonth(m)));
  const total = +rows.reduce((t, r) => t + r.total, 0).toFixed(2);
  return { rows: rows.filter((r) => r.total > 0 || r.month === now), total };
}
