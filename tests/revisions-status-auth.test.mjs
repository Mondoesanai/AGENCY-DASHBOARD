// Client names, email addresses and their requests were readable by anyone.
//
// R21.5. `?do=revisions-status` answered in full with no password. The code's
// own justification was "same trust level as the public /api/sites feed" — and
// that stopped being true in R1.8, when /api/sites was gated for exposing
// exactly this kind of data. The premise was invalidated and this endpoint was
// never revisited.
//
// Verified against production before the fix: 25 tickets, 5 distinct client
// sites, sender names, email addresses, subjects and full request summaries,
// all returned to an unauthenticated caller.
//
// The counts stay public on purpose: the collapsed Overview tile reads them
// before anyone unlocks, and "3 pending" identifies nobody.

import { check, section, done } from './world.mjs';
import { startLocalApi } from './harness/local-api.mjs';
import { store } from '../lib/store.js';

process.env.CRON_SECRET = 'rev-auth-test-secret';
const api = await startLocalApi({ port: 0 });

// A ticket that looks like a real one, so the assertions are about real fields.
await store.set('revisions:all', JSON.stringify([
  {
    id: 'tkt_auth_1', slug: 'client-site.example', siteName: 'Client Site',
    from: 'Jane Client <jane@client-site.example>',
    subject: 'Please update my pricing page',
    summary: 'Change the pricing tiers and remove the old package',
    status: 'needs attention', state: 'awaiting_review', receivedAt: Date.now(),
  },
  {
    id: 'tkt_auth_2', slug: 'other-site.example', siteName: 'Other Site',
    from: 'Sam Other <sam@other-site.example>',
    subject: 'New photos', summary: 'Swap the hero image',
    status: 'done', state: 'succeeded', receivedAt: Date.now(),
  },
]));

const PRIVATE = ['jane@client-site.example', 'Jane Client', 'sam@other-site.example',
  'Sam Other', 'client-site.example', 'other-site.example',
  'Please update my pricing page', 'Change the pricing tiers'];

// ---------------------------------------------------------------------------
section('A1  unauthenticated: no client data at all');
const open = await api.request('/api/admin?do=revisions-status');
check('it still answers 200', open.status === 200, String(open.status));
check('and says it is redacted', open.json?.redacted === true, JSON.stringify(open.json).slice(0, 140));
const openBody = JSON.stringify(open.json);
for (const secret of PRIVATE) {
  check(`"${secret.slice(0, 30)}" is NOT in the response`, !openBody.includes(secret));
}
check('the ticket array is empty', (open.json.status.tickets || []).length === 0);
check('and it tells the reader why', /Unlock the dashboard/.test(open.json.note || ''), open.json.note);

section('A1b  but the Overview tile still works');
check('counts are present', !!open.json.status.counts, JSON.stringify(open.json.status).slice(0, 130));
check('total is right', open.json.status.counts.total === 2, String(open.json.status.counts.total));
check('open count is right', open.json.status.counts.open === 1, String(open.json.status.counts.open),
  'the collapsed widget reads this before anyone unlocks; "1 pending" identifies nobody');
check('and whether the inbox is configured is still visible',
  'configured' in open.json.status);

// ---------------------------------------------------------------------------
section('A2  NEGATIVE CONTROL: with the password, everything comes back');
// Without this the whole file passes against an endpoint that returns nothing
// to anyone, which would be a different bug.
const authd = await api.request('/api/admin?do=revisions-status&secret=rev-auth-test-secret');
check('it answers 200', authd.status === 200);
check('and is NOT redacted', !authd.json?.redacted, JSON.stringify(authd.json).slice(0, 120));
check('both tickets come back', (authd.json.status.tickets || []).length === 2,
  String((authd.json.status.tickets || []).length));
const authBody = JSON.stringify(authd.json);
check('the sender name is there for the owner', authBody.includes('Jane Client'));
check('the email address is there for the owner', authBody.includes('jane@client-site.example'));
check('and the request text is there', authBody.includes('Change the pricing tiers'));

section('A2b  a wrong password is treated as no password');
const wrong = await api.request('/api/admin?do=revisions-status&secret=not-the-password');
check('it is redacted', wrong.json?.redacted === true);
check('and leaks nothing', !JSON.stringify(wrong.json).includes('jane@client-site.example'));

// ---------------------------------------------------------------------------
section('A3  the dashboard page sends its secret');
import { readFile } from 'node:fs/promises';
const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
check('the widget fetch carries the key',
  /do=revisions-status&secret=\$\{encodeURIComponent\(key\(\)\)\}/.test(page), 'public/index.html');
check('and a redacted reply is not read as "all caught up"',
  /redacted\s*\?\s*revData\.counts\.open/.test(page),
  'an empty ticket list because it was withheld must not render as good news');

done();
