// Telling ONE email delivered twice apart from TWO emails that look alike.
//
// These are different problems and only one of them is deduplication:
//
//   redelivery  — the same email arriving again, usually because the
//                 "processed" label PATCH failed on an earlier run. Drop it.
//   two requests — two genuinely different emails. Keep both, however close
//                 together they arrive and however similar they read.
//
// Only a stable identifier separates those. Resemblance does not, and two
// attempts to use resemblance have now both failed live:
//
//   D1 — Angie replied to an email we had sent her a while back. Dedupe
//        matched on Gmail THREAD with no time bound, so her request was
//        dropped. Replying in the existing thread is how people use email.
//   D2 — the first fix bounded that thread match to 2 hours and added an
//        identical-wording clause. Both are still resemblance: two real
//        requests minutes apart, or two "please update the hours" about
//        different pages, would still have been discarded.
//
// So identity is Gmail's per-mailbox message id plus the RFC822 Message-ID
// header, and nothing else.
//
//   D3 — separately: Isha Lo's request shipped 90% done and was reported
//        finished, because the one item the agent could not do was recorded
//        only in a git commit message.
import { check, section, done } from './world.mjs';
import { classifyReason, STATES } from '../lib/revision-state.js';

// The dedupe predicate as lib/revisions.js now implements it.
function isDuplicate(msg, tickets, mailbox = 'agency@example.com') {
  return !!tickets.find(
    (t) =>
      (t.id === msg.id && (!t.mailbox || !mailbox || t.mailbox === mailbox)) ||
      (msg.messageIdHeader && t.messageIdHeader && t.messageIdHeader === msg.messageIdHeader)
  );
}

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86400e3;
const BOX = 'agency@example.com';

const angieFirst = {
  id: 'gmail-001',
  threadId: 'thread-angie',
  messageIdHeader: '<aaa-111@mail.example.com>',
  mailbox: BOX,
  from: 'Angie <angie@example.com>',
  subject: 'Your new website',
  snippet: 'Could you change the hours on the contact page to 9-5 weekdays?',
  receivedAt: NOW - 60 * DAY,
};

// ---------------------------------------------------------------------------
section('D1  ONE email delivered twice is a duplicate');
check('the same Gmail message id is a duplicate',
  isDuplicate({ id: 'gmail-001', messageIdHeader: '<aaa-111@mail.example.com>' }, [angieFirst], BOX) === true);
check('redelivery under a NEW Gmail id is still caught by the RFC822 header',
  isDuplicate({ id: 'gmail-999', messageIdHeader: '<aaa-111@mail.example.com>' }, [angieFirst], BOX) === true,
  'this is the case the old thread/subject heuristics were groping for');
check('…even years later — redelivery has no expiry',
  isDuplicate({ id: 'gmail-999', messageIdHeader: '<aaa-111@mail.example.com>' },
    [{ ...angieFirst, receivedAt: NOW - 900 * DAY }], BOX) === true);

// ---------------------------------------------------------------------------
section('D2  TWO different emails are never duplicates');
const angieSecond = {
  id: 'gmail-002',
  threadId: 'thread-angie', // same conversation
  messageIdHeader: '<bbb-222@mail.example.com>', // different message
  from: 'Angie <angie@example.com>',
  subject: 'Re: Your new website',
  snippet: 'One more thing — can we add a photo to the about page?',
};
check('a reply in the same thread gets through', isDuplicate(angieSecond, [angieFirst], BOX) === false,
  'the live bug: a reply in an existing thread was dropped forever');

check('two requests ONE MINUTE apart both get through',
  isDuplicate({ ...angieSecond, id: 'gmail-003', messageIdHeader: '<ccc@x>' },
    [{ ...angieFirst, receivedAt: NOW - 60000 }], BOX) === false,
  'a short time window is not identity');

check('two requests with IDENTICAL wording both get through',
  isDuplicate({ id: 'gmail-004', threadId: 'thread-angie', messageIdHeader: '<ddd@x>', snippet: angieFirst.snippet,
    from: angieFirst.from, subject: angieFirst.subject },
    [angieFirst], BOX) === false,
  '"please update the hours" about two different pages is two requests');

check('same sender and same subject within the hour both get through',
  isDuplicate({ id: 'gmail-005', messageIdHeader: '<eee@x>', from: angieFirst.from, subject: angieFirst.subject },
    [{ ...angieFirst, receivedAt: NOW - 10 * 60000 }], BOX) === false);

check('a different client is never a duplicate',
  isDuplicate({ id: 'gmail-006', messageIdHeader: '<fff@x>', from: 'bob@example.com', subject: 'Hi' }, [angieFirst], BOX) === false);

section('D2b  identity is scoped to the mailbox it came from');
check('the same Gmail id in a DIFFERENT mailbox does not suppress it',
  isDuplicate({ id: 'gmail-001' }, [{ ...angieFirst, mailbox: 'someone-else@example.com' }], BOX) === false,
  'Gmail ids are unique per account, not globally');
check('a legacy ticket with no mailbox recorded still dedupes on id',
  isDuplicate({ id: 'gmail-001' }, [{ ...angieFirst, mailbox: undefined }], BOX) === true);
check('an unknown mailbox fails toward a duplicate TICKET, not a dropped request',
  isDuplicate({ id: 'gmail-001' }, [{ ...angieFirst, mailbox: 'other@example.com' }], null) === true);

section('D2c  the predicates that failed live would fail these tests');
const threadOnly = (m, ts) => !!ts.find((t) => t.id === m.id || (m.threadId && t.threadId === m.threadId));
check('the ORIGINAL logic really did drop her second request', threadOnly(angieSecond, [angieFirst]) === true);
const windowed = (m, ts, now = NOW) => !!ts.find((t) => {
  if (t.id === m.id) return true;
  const age = t.receivedAt ? now - t.receivedAt : Infinity;
  if (m.threadId && t.threadId === m.threadId) return age < 2 * 3600e3;
  return false;
});
check('and the 2-hour window would have dropped two requests a minute apart',
  windowed({ ...angieSecond }, [{ ...angieFirst, receivedAt: NOW - 60000 }]) === true,
  'which is why resemblance was abandoned entirely');

// ---------------------------------------------------------------------------
section('D3  "I could not finish this part" is recognised, not buried');
const ishaCommit =
  'Logo note: her doc asks for the official CPDSO Accredited Provider logo image at the top of ' +
  'the new section — I reused the site\'s existing hand-drawn seal since I don\'t have that logo ' +
  'file; swap it in if she sends it.';
let c = classifyReason(ishaCommit);
check('the real commit text is classified', c.kind === 'needs-client-asset', c.kind);
check('it does not retry — retrying never produces a logo', c.permanent === true);
check('it names what to do', /ask the client for the file/i.test(c.recovery?.label || ''), c.recovery?.label);

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
  classifyReason('Added the logo image to the header and the footer.').kind === 'unknown');

section('D5  a blocked-on-asset ticket is not a finished one');
check('BLOCKED is not terminal — it resumes when the file arrives',
  STATES.BLOCKED !== STATES.SUCCEEDED && STATES.BLOCKED !== STATES.CANCELLED);

done();
