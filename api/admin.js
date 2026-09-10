// One admin function that routes to the smaller admin handlers, so we stay
// under Vercel Hobby's 12-function-per-deployment limit.
//   /api/admin?do=coach     (POST)  -> Compass chat
//   /api/admin?do=receipts          -> ledger / receipts / tax (?one=, ?format=csv)
//   /api/admin?do=repos             -> GitHub repo list + match (?match=<url>)
import { coachHandler } from '../lib/coach.js';
import { receiptsHandler } from '../lib/receipts.js';
import { reposHandler } from '../lib/repos.js';

function authed(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${s}` || req.query.secret === s;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad password' });
  switch (req.query.do) {
    case 'coach':
      return coachHandler(req, res);
    case 'receipts':
      return receiptsHandler(req, res);
    case 'repos':
      return reposHandler(req, res);
    default:
      return res.status(400).json({ ok: false, error: 'unknown admin action' });
  }
}
