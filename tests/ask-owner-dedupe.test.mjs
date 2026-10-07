// One unresolved problem must not become forty emails.
//
// R21.7. `askOwner` had no dedupe. Every call minted a new question and, with no
// SMS provider configured, fell through to email. The revision sweep runs every
// ten minutes and re-asks about any ticket it is holding, so a single held
// ticket produced six identical emails an hour — about forty in a working day,
// all about the same unresolved thing.
//
// That is not a cosmetic problem. An alert channel that repeats itself is one
// the owner learns to filter, and then the next real alert is filtered too.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { askOwner, pendingIds } from '../lib/sms.js';

const sweepAsk = (ticketId, at) => askOwner({
  kind: 'blocked-revision',
  text: `Client Site: a fix shipped for "update the services page" but the live site does not look right.`,
  payload: { ticketId },
  choices: 'Reply DONE if it is fine, RETRY to redo it, SKIP to drop it',
  now: at,
});

// ---------------------------------------------------------------------------
section('D1  the same question, asked by six sweeps in an hour');
const T = `tkt_dedupe_${Date.now()}`;
const t0 = Date.now();
const results = [];
for (let i = 0; i < 6; i++) results.push(await sweepAsk(T, t0 + i * 10 * 60 * 1000));

const asked = results.filter((r) => !r.suppressed);
const quiet = results.filter((r) => r.suppressed);
check('it is asked exactly once', asked.length === 1, `asked ${asked.length} of 6`);
check('the other five are suppressed', quiet.length === 5, `suppressed ${quiet.length}`);
check('and they say why', /already asked/.test(quiet[0]?.reason || ''), quiet[0]?.reason);
check('every suppressed call points at the original question',
  quiet.every((r) => r.id === asked[0].id), 'so the owner can still find the one that was sent');

section('D1b  only ONE pending question was created');
const pending = await pendingIds();
const mine = [];
for (const id of pending) {
  const raw = await store.get(`sms:ask:${id}`).catch(() => null);
  try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; if (a?.payload?.ticketId === T) mine.push(id); } catch { /* skip */ }
}
check('one ask exists for this ticket, not six', mine.length === 1, `${mine.length} asks`);

// ---------------------------------------------------------------------------
section('D2  NEGATIVE CONTROL: a DIFFERENT problem still gets through');
// Without this the fix would just be "stop telling the owner anything".
const other = await sweepAsk(`tkt_other_${Date.now()}`, t0);
check('a different ticket is asked about', !other.suppressed, JSON.stringify(other).slice(0, 120));

const differentKind = await askOwner({
  kind: 'budget-exceeded', text: 'Spending hit the monthly cap.',
  payload: { ticketId: T }, now: t0,
});
check('a different KIND about the same ticket also gets through', !differentKind.suppressed,
  'two unrelated problems about one ticket are two questions');

section('D2b  with no subject to key on, the words are the key');
const a1 = await askOwner({ kind: 'generic', text: 'The widget is stuck.', now: t0 });
const a2 = await askOwner({ kind: 'generic', text: 'The widget is stuck.', now: t0 + 60000 });
const a3 = await askOwner({ kind: 'generic', text: 'A different thing is stuck.', now: t0 + 60000 });
check('an identical message repeats once only', !a1.suppressed && a2.suppressed === true);
check('but a different message is still sent', !a3.suppressed);

// ---------------------------------------------------------------------------
section('D3  once answered, the question can be asked again');
// Suppression must not become permanent silence on a problem that comes back.
const first = asked[0];
const raw = await store.get(`sms:ask:${first.id}`);
const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
rec.status = 'answered';
await store.set(`sms:ask:${first.id}`, JSON.stringify(rec));

const afterAnswer = await sweepAsk(T, t0 + 7 * 10 * 60 * 1000);
check('the same problem recurring after an answer IS raised again',
  !afterAnswer.suppressed, JSON.stringify(afterAnswer).slice(0, 120));
check('and it is a new question, not the old one', afterAnswer.id !== first.id);

section('D3b  and an unanswered one resurfaces after the cooldown');
const T2 = `tkt_cooldown_${Date.now()}`;
const c1 = await sweepAsk(T2, t0);
const c2 = await sweepAsk(T2, t0 + 60 * 60 * 1000);          // an hour later
const c3 = await sweepAsk(T2, t0 + 25 * 60 * 60 * 1000);     // past the 24h cooldown
check('an hour later it is still quiet', c2.suppressed === true);
check('but a day later it speaks up again', !c3.suppressed,
  'a problem nobody has touched in 24 hours is worth one more mention');
check('the first one was sent', !c1.suppressed);

// ---------------------------------------------------------------------------
section('D4  the sweep is what was calling it');
import { readFile } from 'node:fs/promises';
const rev = await readFile(new URL('../lib/revisions.js', import.meta.url), 'utf8');
check('the held-ticket branch asks the owner', /askOwner\(\{ kind: 'blocked-revision'/.test(rev));
check('and it carries the ticket id, which is what dedupes it',
  /kind: 'blocked-revision'[\s\S]{0,400}payload: \{ ticketId: t\.id \}/.test(rev),
  'without a subject it would fall back to hashing the words, which is weaker');

done();
