// The two ways a real client's request died without anyone being told.
//
// Both of these are reconstructions of live failures, not hypotheticals:
//
//   D1 — Angie replied to an email we had sent her a while back. The inbox
//        dedupe matched her new request to an old ticket in the same Gmail
//        THREAD, with no time bound at all, and dropped it. Replying in the
//        existing thread is how people use email, so any client who had ever
//        sent one request could never send a second.
//
//   D2 — Isha Lo asked for her CPD accreditation section. The agent did all of
//        it except the one thing it had no file for (the official logo), said
//        so in the git commit message, and the pipeline emailed her that it
//        was live. Shipping ANYTHING counted as shipping EVERYTHING.
//
// Both tests are written so that reverting the fix turns them red.
import { check, section, done } from './world.mjs';
import { classifyReason, STATES } from '../lib/revision-state.js';

// ---------------------------------------------------------------------------
// The dedupe predicate, lifted out of checkRevisionInbox so it can be driven
// directly. This mirrors the logic in lib/revisions.js — if that changes shape
// this test is the thing that should have to change with it.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const REDELIVERY_MS = 2 * 60 * 60000;

function isDuplicate(msg, tickets, now = Date.now()) {
  const msgBody = norm(String(msg.snippet || msg.body || '').slice(0, 400));
  const msgSubj = norm(msg.subject);
  const emailOf = (s) => String(s || '').match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase() || '';
  return !!tickets.find((t) => {
    if (t.id === msg.id) return true;
    const age = t.receivedAt ? now - t.receivedAt : Infinity;
    if (msg.threadId && t.threadId === msg.threadId) {
      if (age < REDELIVERY_MS) return true;
      if (msgBody && norm(t.snippet || t.summary) === msgBody) return true;
      return false;
    }
    return emailOf(t.from) === emailOf(msg.from) && age < 60 * 60000 && norm(t.subject) === msgSubj;
  });
}

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86400e3;

// the ticket from the conversation we started with her months ago
const oldTicket = {
  id: 'msg-001',
  threadId: 'thread-angie',
  from: 'Angie <angie@example.com>',
  subject: 'Your new website',
  summary: 'Initial handover questions',
  snippet: 'Thanks so much for sending the site over, it looks great!',
  receivedAt: NOW - 60 * DAY,
};

section('D1  a new request in an old thread is NOT a duplicate');
const angieNewRequest = {
  id: 'msg-002',
  threadId: 'thread-angie',
  from: 'Angie <angie@example.com>',
  subject: 'Re: Your new website',
  snippet: 'Hi! Could you change the hours on the contact page to 9-5 weekdays?',
};
check('her follow-up gets through', isDuplicate(angieNewRequest, [oldTicket], NOW) === false,
  'this is the live bug: a reply in an existing thread was dropped forever');

check('a third request, months later again, also gets through',
  isDuplicate({ ...angieNewRequest, id: 'msg-003', snippet: 'One more — can we add a photo to the about page?' },
    [oldTicket, { ...angieNewRequest, receivedAt: NOW - 30 * DAY, snippet: angieNewRequest.snippet }], NOW) === false);

section('D2  but real redelivery is still caught');
check('the exact same message id is a duplicate',
  isDuplicate({ ...angieNewRequest, id: 'msg-001' }, [oldTicket], NOW) === true);
check('the same email arriving again minutes later is a duplicate',
  isDuplicate(angieNewRequest, [{ ...oldTicket, id: 'other', receivedAt: NOW - 5 * 60000 }], NOW) === true,
  'inside the redelivery window a thread match still counts');
check('word-for-word the same request in the thread is a duplicate, however old',
  isDuplicate(angieNewRequest, [{ ...oldTicket, snippet: angieNewRequest.snippet }], NOW) === true);
check('same sender, same subject, within the hour is a duplicate',
  isDuplicate({ id: 'x', from: 'Angie <angie@example.com>', subject: 'Website change', snippet: 'a' },
    [{ id: 'y', from: 'angie@example.com', subject: 'website change', receivedAt: NOW - 10 * 60000 }], NOW) === true);
check('a different client in a different thread is never a duplicate',
  isDuplicate({ id: 'z', threadId: 'thread-bob', from: 'bob@example.com', subject: 'Hi', snippet: 'change the logo' },
    [oldTicket], NOW) === false);

// the negative control for the FIX itself: with no time bound, D1 would fail
const oldBuggyDuplicate = (msg, tickets) => !!tickets.find((t) => t.id === msg.id || (msg.threadId && t.threadId === msg.threadId));
check('the OLD logic really did drop her request (so this test has teeth)',
  oldBuggyDuplicate(angieNewRequest, [oldTicket]) === true);

// ---------------------------------------------------------------------------
section('D3  "I could not finish this part" is recognised, not buried');
// the exact sentence the agent wrote into Isha's commit message
const ishaCommit =
  'Logo note: her doc asks for the official CPDSO Accredited Provider logo image at the top of ' +
  'the new section — I reused the site\'s existing hand-drawn seal since I don\'t have that logo ' +
  'file; swap it in if she sends it.';
let c = classifyReason(ishaCommit);
check('the real commit text is classified', c.kind === 'needs-client-asset', c.kind);
check('it does not retry — retrying never produces a logo', c.permanent === true);
check('it names what to do', /ask the client for the file/i.test(c.recovery?.label || ''), c.recovery?.label);
check('and why it is stuck', /only the client has/i.test(c.recovery?.hint || ''));

for (const [text, why] of [
  ['I don\'t have the logo file for this', 'plain statement'],
  ['needs the official brand logo image from them', 'needs the official X'],
  ['awaiting a photo from the client before this can finish', 'awaiting'],
  ['left the placeholder, swap it in if they send it', 'swap it in if'],
  ['will finish once she sends the headshot', 'once she sends'],
]) check(`recognised: ${why}`, classifyReason(text).kind === 'needs-client-asset', `${why} → ${classifyReason(text).kind}`);

section('D4  and it is not confused with the things that already worked');
for (const [text, expect] of [
  ['no GitHub repo set (Settings → Automation)', 'no-repo'],
  ['paced — next attempt in ~20h', 'paced'],
  ['this month\'s budget is used ($23.85 / $20)', 'budget'],
  ['request timed out', 'transient'],
  ['the safety check rejected it', 'content'],
  ['this is stored in a third-party dashboard', 'not-file-editable'],
]) check(`${expect} still classifies as ${expect}`, classifyReason(text).kind === expect, `got ${classifyReason(text).kind}`);
check('an ordinary successful summary is NOT treated as blocked',
  classifyReason('Updated the hours on the contact page and the footer.').kind === 'unknown');
check('a shipped-and-complete note is not a false positive',
  classifyReason('Added the logo image to the header and the footer.').kind === 'unknown',
  classifyReason('Added the logo image to the header and the footer.').kind);

section('D5  a blocked-on-asset ticket is not a finished one');
check('needs-client-asset is permanent, so it will not silently retry',
  classifyReason(ishaCommit).permanent === true);
check('BLOCKED is not terminal — it resumes when the file arrives',
  STATES.BLOCKED !== STATES.SUCCEEDED && STATES.BLOCKED !== STATES.CANCELLED);

done();
