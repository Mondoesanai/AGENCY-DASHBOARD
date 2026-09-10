// Admin-only. Builds the full money ledger — one receipt per client payment
// (setup + each month) and per expense — with sequential numbers, dates,
// categories and a tax summary. JSON by default; ?format=csv for the year
// export; ?one=<id> for a single printable HTML receipt.
import { listSites } from '../lib/registry.js';
import { store } from '../lib/store.js';

const ORG = { name: 'Inspiring Websites LLC', addr: '2200 Driskell Drive, Corinth, TX 76210' };

function authed(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${s}` || req.query.secret === s;
}
async function readArr(key) {
  const raw = await store.get(key).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const ymKey = (d) => d.getFullYear() * 12 + d.getMonth();
const money = (n) => '$' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

// crude expense categoriser → IRS Schedule C buckets
function categorise(label) {
  const s = String(label || '').toLowerCase();
  if (/anthropic|openai|claude|api|dataforseo|serp|software|saas|figma|vercel|hosting|domain|namecheap|resend|subscription/.test(s))
    return 'Software & subscriptions';
  if (/chamber|dues|membership|association|bni|network/.test(s)) return 'Dues & memberships';
  if (/ad|ads|google ads|facebook|meta|marketing|sponsor|flyer|print/.test(s)) return 'Advertising';
  if (/lunch|dinner|coffee|meal|restaurant/.test(s)) return 'Meals';
  if (/contractor|freelanc|writer|design|va |assistant/.test(s)) return 'Contract labor';
  if (/mile|gas|fuel|travel|hotel|flight/.test(s)) return 'Travel';
  return 'Other expenses';
}

async function buildLedger() {
  const sites = await listSites();
  const income = [];
  let invN = 0;
  const now = new Date();

  for (const s of sites) {
    if (!s.startedAt) continue;
    const start = new Date(s.startedAt);
    const paidFrom = s.trialEnds && s.trialEnds > s.startedAt ? new Date(s.trialEnds) : start;
    const label = s.name || s.slug;

    if (s.setupFee > 0) {
      income.push({
        id: `INV-${iso(s.startedAt).replace(/-/g, '')}-${++invN}`,
        type: 'income',
        date: iso(s.startedAt),
        time: start.toTimeString().slice(0, 5),
        counterparty: label,
        client: s.client || '',
        description: `Website setup & onboarding — ${label}`,
        category: 'Website services',
        amount: s.setupFee,
      });
    }
    if (s.priceMonthly > 0) {
      let m = ymKey(paidFrom);
      const end = ymKey(now);
      let guard = 0;
      while (m <= end && guard++ < 120) {
        const y = Math.floor(m / 12);
        const mo = m % 12;
        const bday = Math.min(28, s.billingDay || 1);
        const when = new Date(y, mo, bday, 9, 0);
        if (when <= now) {
          income.push({
            id: `INV-${y}${String(mo + 1).padStart(2, '0')}-${s.slug}`,
            type: 'income',
            date: iso(when),
            time: '09:00',
            counterparty: label,
            client: s.client || '',
            description: `Monthly website & SEO management — ${when.toLocaleString('en-US', { month: 'long', year: 'numeric' })}`,
            category: 'Recurring services',
            amount: s.priceMonthly,
          });
        }
        m++;
      }
    }
  }

  // expenses — per-site + business overhead
  const expenses = [];
  let expN = 0;
  const push = (e, source) => {
    const amt = Number(e.amount) || 0;
    if (!amt) return;
    const d = e.date && !Number.isNaN(Date.parse(e.date)) ? new Date(e.date) : new Date();
    expenses.push({
      id: `EXP-${iso(d).replace(/-/g, '')}-${++expN}`,
      type: 'expense',
      date: iso(d),
      time: e.time || '—',
      counterparty: e.label || e.vendor || 'expense',
      description: (e.label || 'expense') + (source ? ` (${source})` : '') + (e.recurring ? ' — recurring/monthly' : ''),
      category: e.category || categorise(e.label),
      amount: amt,
    });
  };
  for (const s of sites) (await readArr(`expenses:${s.slug}`)).forEach((e) => push(e, s.name || s.slug));
  (await readArr('expenses:_business')).forEach((e) => push(e, 'business overhead'));

  income.sort((a, b) => a.date.localeCompare(b.date));
  expenses.sort((a, b) => a.date.localeCompare(b.date));

  // this-year tax summary
  const yr = now.getFullYear();
  const inYear = (r) => r.date.slice(0, 4) === String(yr);
  const grossIncome = income.filter(inYear).reduce((t, r) => t + r.amount, 0);
  const byCategory = {};
  for (const e of expenses.filter(inYear)) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  const totalExpenses = Object.values(byCategory).reduce((t, v) => t + v, 0);
  const netProfit = grossIncome - totalExpenses;
  // rough self-employed set-aside: SE tax ~15.3% of 92.35% of net + ~12% fed income → ~25-30% of profit
  const estTax = Math.max(0, netProfit) * 0.27;
  const reservedIfTwentyPctRevenue = grossIncome * 0.2;

  const qDue = [
    `${yr}-04-15`,
    `${yr}-06-16`,
    `${yr}-09-15`,
    `${yr + 1}-01-15`,
  ];

  return {
    org: ORG,
    income,
    expenses,
    summary: {
      year: yr,
      grossIncome,
      byCategory,
      totalExpenses,
      netProfit,
      estTaxOnProfit: Math.round(estTax),
      reservedIfTwentyPctRevenue: Math.round(reservedIfTwentyPctRevenue),
      cushion: Math.round(reservedIfTwentyPctRevenue - estTax),
      quarterlyDue: qDue,
    },
  };
}

function csv(led) {
  const rows = [['id', 'type', 'date', 'time', 'counterparty', 'description', 'category', 'amount']];
  for (const r of [...led.income, ...led.expenses].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([r.id, r.type, r.date, r.time, r.counterparty, r.description, r.category, r.amount.toFixed(2)]);
  }
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function receiptHTML(r) {
  const kind = r.type === 'income' ? 'RECEIPT' : 'EXPENSE RECORD';
  return `<!doctype html><meta charset="utf-8"><title>${r.id}</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#12160f;max-width:640px;margin:40px auto;padding:0 24px}
h1{font-size:15px;letter-spacing:.14em;color:#6b7280;margin:0 0 4px}.org{font-size:20px;font-weight:700}.muted{color:#6b7280}
table{width:100%;border-collapse:collapse;margin:22px 0}td{padding:9px 0;border-bottom:1px solid #e5e7eb;vertical-align:top}
td:last-child{text-align:right}.tot td{border-top:2px solid #12160f;border-bottom:0;font-weight:700;font-size:18px;padding-top:14px}
.no{margin-top:26px;font-size:12px;color:#9ca3af}@media print{body{margin:0}}</style>
<h1>${kind}</h1><div class="org">${r._org?.name || ''}</div><div class="muted">${r._org?.addr || ''}</div>
<table>
<tr><td class="muted">Number</td><td>${r.id}</td></tr>
<tr><td class="muted">Date</td><td>${r.date}${r.time && r.time !== '—' ? ' · ' + r.time : ''}</td></tr>
<tr><td class="muted">${r.type === 'income' ? 'Client' : 'Paid to'}</td><td>${r.counterparty}${r.client ? ' (' + r.client + ')' : ''}</td></tr>
<tr><td class="muted">Description</td><td>${r.description}</td></tr>
<tr><td class="muted">Category</td><td>${r.category}</td></tr>
<tr class="tot"><td>${r.type === 'income' ? 'Amount received' : 'Amount paid'}</td><td>${money(r.amount)}</td></tr>
</table>
<div class="no">Generated by the Inspiring Websites dashboard. Keep for your records. Use your browser's Print → Save as PDF.</div>`;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad password' });
  const led = await buildLedger();

  if (req.query.one) {
    const all = [...led.income, ...led.expenses].map((r) => ({ ...r, _org: led.org }));
    const r = all.find((x) => x.id === req.query.one);
    if (!r) return res.status(404).send('receipt not found');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(receiptHTML(r));
  }
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inspiring-websites-ledger-${led.summary.year}.csv"`);
    return res.status(200).send(csv(led));
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ...led });
}
