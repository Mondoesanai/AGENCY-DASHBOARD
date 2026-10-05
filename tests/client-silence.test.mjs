// Does anything notice when a client is being ignored?
//
// Every existing health check watches the machinery — workers, queues, jobs.
// All of them were green on the days Angie's request was dropped and Isha's
// was reported finished while one item was still outstanding. Nothing threw,
// so nothing was reported, so nobody knew.
//
// These checks are about the client's experience instead: a request that went
// quiet is a failure even when the machine is perfectly healthy.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { diagnose } from '../lib/recovery.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86400e3;
const has = (f, id) => f.findings.some((x) => x.id === id);
const get = (f, id) => f.findings.find((x) => x.id === id);

async function withTickets(tickets, fn) {
  await store.set('revisions:all', JSON.stringify(tickets));
  const f = await diagnose({ now: NOW });
  await fn(f);
}

// ---------------------------------------------------------------------------
section('S1  a healthy machine with an ignored client is NOT healthy');
await withTickets([
  { id: 't1', status: 'scheduled', receivedAt: NOW - 5 * DAY, repliedAt: null,
    summary: 'change the opening hours on the contact page', siteName: 'Angie', slug: 'omt' },
], (f) => {
  check('an unanswered request is found', has(f, 'client-unanswered'));
  const x = get(f, 'client-unanswered');
  check('it says how long they have waited', /5 days old/.test(x.what), x.what);
  check('and names the request', /opening hours/.test(x.action), x.action);
  check('it is stuck, not merely degraded', x.severity === 'stuck', x.severity);
});

await withTickets([
  { id: 't1', status: 'scheduled', receivedAt: NOW - 2 * 3600e3, repliedAt: null, summary: 'x' },
], (f) => check('a request from 2 hours ago is not yet a finding', !has(f, 'client-unanswered')));

await withTickets([
  { id: 't1', status: 'scheduled', receivedAt: NOW - 5 * DAY, repliedAt: NOW - 5 * DAY + 60000, summary: 'x' },
], (f) => check('a request we DID reply to is not flagged as unanswered', !has(f, 'client-unanswered')));

// ---------------------------------------------------------------------------
section('S2  waiting on a file nobody asked for — Isha\'s case');
await withTickets([
  { id: 't2', status: 'needs attention', receivedAt: NOW - 4 * DAY, repliedAt: NOW - 4 * DAY,
    siteName: 'The Lo Down with Isha Lo', slug: 'lo-down',
    outstanding: 'needs the official CPDSO Accredited Provider logo image',
    blockedBy: { action: 'request-asset', label: 'Ask the client for the file this needs' } },
], (f) => {
  check('it is surfaced', has(f, 'awaiting-client-asset'));
  const x = get(f, 'awaiting-client-asset');
  check('it does NOT read as finished', /finished apart from/.test(x.what), x.what);
  check('it names the client', /Isha Lo/.test(x.action), x.action);
  check('and the actual file needed', /CPDSO Accredited Provider logo/.test(x.action), x.action);
  check('it needs a person, not a retry', x.severity === 'needs-configuration', x.severity);
});

// ---------------------------------------------------------------------------
section('S3  shipped is not the same as delivered');
await withTickets([
  { id: 't3', status: 'needs attention', state: 'awaiting_review', receivedAt: NOW - 6 * DAY, repliedAt: NOW - 6 * DAY, summary: 'y' },
], (f) => {
  check('a long-unconfirmed ship is found', has(f, 'shipped-unconfirmed'));
  check('and says so plainly', /Shipped is not the same as delivered/.test(get(f, 'shipped-unconfirmed').action));
});
await withTickets([
  { id: 't3', status: 'needs attention', state: 'awaiting_review', receivedAt: NOW - 6 * 3600e3, repliedAt: NOW, summary: 'y' },
], (f) => check('one shipped this morning is not nagged about', !has(f, 'shipped-unconfirmed')));

// ---------------------------------------------------------------------------
section('S4  a request matched to no site cannot be worked on');
await withTickets([
  { id: 't4', status: 'needs attention', receivedAt: NOW - 3 * DAY, repliedAt: NOW - 3 * DAY, slug: null, summary: 'z' },
], (f) => {
  check('an unmatched request is found', has(f, 'unmatched-request'));
  check('and the action is to assign it', /assign each one to a site/.test(get(f, 'unmatched-request').action));
});

// ---------------------------------------------------------------------------
section('S5  open far longer than we promise');
await withTickets([
  { id: 't5', status: 'scheduled', receivedAt: NOW - 30 * DAY, repliedAt: NOW - 30 * DAY,
    summary: 'add the new team photos', siteName: 'Some Client' },
], (f) => {
  check('a month-old request is found', has(f, 'request-overdue'));
  const x = get(f, 'request-overdue');
  check('it counts the days', /30 days/.test(x.what), x.what);
  check('and offers the honest option too', /tell them where it stands/.test(x.action), x.action);
});

// ---------------------------------------------------------------------------
section('S6  quiet when things are genuinely fine');
await withTickets([
  { id: 'd1', status: 'done', receivedAt: NOW - 40 * DAY, repliedAt: NOW - 40 * DAY },
  { id: 'd2', status: 'cancelled', receivedAt: NOW - 40 * DAY },
  { id: 'ok', status: 'scheduled', receivedAt: NOW - 2 * DAY, repliedAt: NOW - 2 * DAY, slug: 'omt', summary: 'fine' },
], (f) => {
  for (const id of ['client-unanswered', 'awaiting-client-asset', 'shipped-unconfirmed', 'unmatched-request', 'request-overdue'])
    check(`no false alarm: ${id}`, !has(f, id));
});

// closed tickets must never be nagged about, however old
await withTickets([
  { id: 'd3', status: 'done', receivedAt: NOW - 90 * DAY, repliedAt: null, slug: null },
], (f) => {
  check('a finished request is not "unanswered"', !has(f, 'client-unanswered'));
  check('a finished request is not "overdue"', !has(f, 'request-overdue'));
  check('a finished request is not "unmatched"', !has(f, 'unmatched-request'));
});

// ---------------------------------------------------------------------------
section('S7  unreadable is not the same as nobody waiting');
await store.set('revisions:all', '{ this is not json');
let f = await diagnose({ now: NOW });
check('a corrupt store is reported, not treated as all-clear', has(f, 'revisions-unreadable'));
check('and says exactly that', /Unknown is not the same as nobody waiting/.test(get(f, 'revisions-unreadable').action));

// ---------------------------------------------------------------------------
section('S8  diagnose stays read-only');
await store.set('revisions:all', JSON.stringify([
  { id: 'r1', status: 'scheduled', receivedAt: NOW - 5 * DAY, repliedAt: null, summary: 'untouched' },
]));
await diagnose({ now: NOW });
const after = JSON.parse(await store.get('revisions:all'));
check('looking at the tickets does not change them', after.length === 1 && after[0].summary === 'untouched');

await store.set('revisions:all', JSON.stringify([]));
done();
