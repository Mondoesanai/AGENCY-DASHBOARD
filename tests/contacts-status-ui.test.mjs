// The contact-permission screen.
//
// The requirement is one sentence — a contact marked emailable must not look
// SMS-eligible — and it is easy to satisfy in a library and lose in a
// template. The moment the two channels share a badge, a colour, or a column,
// somebody texts a person who only agreed to email. So most of these checks
// are about the two staying apart on screen, and about a failed read never
// rendering as "nobody can be contacted".
import { check, section, done } from './world.mjs';
import { renderSummary, renderStatusList, renderInviteReview, wireContactStatus, toneFor } from '../public/contacts-status.js';

const emailOnly = {
  id: 'c1', name: 'Dana Reyes',
  email: { eligible: true, label: 'Email OK', reason: 'a business address, first contact is permitted', next: 'Send the preview invitation' },
  sms: { eligible: false, promotional: false, permission: 'none', label: 'Permission needed', reason: 'no permission on file', next: 'Send the preview invitation by email — a YES unlocks texting' },
};
const bothOk = {
  id: 'c2', name: 'Cy Vance',
  email: { eligible: true, label: 'Email OK', reason: 'a business address', next: null },
  sms: { eligible: true, promotional: false, permission: 'documented', label: 'Text OK — one message', reason: 'they replied YES to the preview invitation', next: null },
};
const stopped = {
  id: 'c3', name: 'Pat Lee', suppressed: true,
  email: { eligible: false, label: 'Opted out', reason: 'they asked not to be contacted', next: null },
  sms: { eligible: false, promotional: false, label: 'Opted out', reason: 'they asked not to be contacted', next: null },
};
const noMobile = {
  id: 'c4', name: 'Sam Ortiz',
  email: { eligible: true, label: 'Email OK', reason: 'a business address', next: null },
  sms: { eligible: false, promotional: false, label: 'No mobile number', reason: 'no mobile number on file', next: 'Find a mobile number, or keep this one to email' },
};

// ---------------------------------------------------------------------------
section('U1  THE RULE: emailable never looks textable');
let html = renderStatusList({ ok: true, rows: [emailOnly] });
check('both channels appear', /Email OK/.test(html) && /Permission needed/.test(html));
check('they are in separate blocks', (html.match(/cs-ch /g) || html.match(/class="cs-ch/g) || []).length === 2,
  String((html.match(/class="cs-ch/g) || []).length));
check('each is labelled with its channel', /cs-ch-k">Email</.test(html) && /cs-ch-k">Text</.test(html));
check('the email block reads ok', /cs-ok/.test(html));
check('the text block does NOT', /cs-todo/.test(html), 'permission needed must not borrow the ok tone');
check('no combined "contactable" badge exists anywhere', !/contactable/i.test(html));

// the same person must not produce one shared verdict
check('there is no single status word for the row',
  !/class="cs-row[^"]*"[^>]*>\s*<div class="cs-status/.test(html));

section('U1b  and the tones are distinct');
check('Email OK is ok', toneFor('Email OK') === 'ok');
check('Text OK is ok', toneFor('Text OK — one message') === 'ok');
check('Permission needed is its own tone', toneFor('Permission needed') === 'todo');
check('and NOT an alarm', toneFor('Permission needed') !== 'stop',
  'it is the normal state of a discovered business, not an error');
check('Opted out is a stop', toneFor('Opted out') === 'stop');
check('No mobile number is neither', toneFor('No mobile number') === 'none');

// ---------------------------------------------------------------------------
section('U2  every blocked row says what to do next');
check('the sms block carries its next action', /YES unlocks texting/.test(html));
check('shown as an action, not buried in prose', /cs-ch-next/.test(html));
html = renderStatusList({ ok: true, rows: [noMobile] });
check('no mobile is distinguished from no permission', /No mobile number/.test(html) && !/Permission needed/.test(html),
  'they need completely different things done about them');
check('and still offers a way forward', /Find a mobile number/.test(html));
html = renderStatusList({ ok: true, rows: [stopped] });
check('an opted-out row offers no next action', !/cs-ch-next/.test(html),
  'there is nothing to do about somebody who asked us to stop');
check('and is visually set apart', /cs-row-stop/.test(html));

// ---------------------------------------------------------------------------
section('U3  a failed read is never "nobody can be contacted"');
let s = renderSummary({ ok: false, error: 'storage unreachable' });
check('it says the read failed', /Could not read contact permissions/.test(s), s.slice(0, 120));
check('naming the reason', /storage unreachable/.test(s));
check('and that it is not an all-clear', /not an all-clear/.test(s));
check('it does NOT report zero of anything', !/0 can be/.test(s));
check('the list renders nothing rather than an empty state', renderStatusList({ ok: false }) === '');
check('loading is its own state', /Reading who/.test(renderSummary(null)));
check('and is not confused with empty', !/No contacts yet/.test(renderSummary(null)));
check('a genuine empty says so plainly', /No contacts yet/.test(renderSummary({ ok: true, total: 0 })));

// ---------------------------------------------------------------------------
section('U4  the counts are a sentence, and the assertion is flagged');
s = renderSummary({ ok: true, total: 12, emailEligible: 11, smsEligible: 3, permissionNeeded: 8, suppressed: 1, ownerAsserted: 0 });
check('it counts emailable and textable separately', /11 can be emailed/.test(s) && /3 can be texted/.test(s), s);
check('and those needing permission', /8 need permission/.test(s));
check('no owner-asserted warning when there are none', !/your own assertion/.test(s));
s = renderSummary({ ok: true, total: 12, emailEligible: 11, smsEligible: 5, permissionNeeded: 6, suppressed: 1, ownerAsserted: 2 });
check('an assertion IS flagged', /your own assertion/.test(s), s);
check('saying nothing is on file for them individually', /nothing on file for them individually/.test(s));
check('and how to make it real', /turns that into real records/.test(s));

// ---------------------------------------------------------------------------
section('U5  the invitation review sends nothing and says what it would send');
let r = renderInviteReview({
  ok: true,
  candidates: { eligible: [{ id: 'a' }, { id: 'b' }], skipped: [{ id: 'c', name: 'Pat', why: 'already invited' }] },
  preview: { prepared: [{ id: 'a', body: 'Hi Dana,\n\nReply YES and I will send you the link.' }], refused: [] },
});
check('it says nothing is sent from this screen', /Nothing is sent from this screen/.test(r), r.slice(0, 200));
check('it says how many would be invited', /<b>2<\/b> would be invited/.test(r));
check('and how many were skipped, with reasons', /already invited/.test(r));
check('the exact message is inspectable', /Reply YES and I will send you the link/.test(r));
check('and the button names the number', /Send 1 invitation/.test(r));
check('it explains what a yes unlocks', /lets us text them later/.test(r));
check('and that the record is their own words', /recorded with their own words/.test(r));

r = renderInviteReview({ ok: true, candidates: { eligible: [], skipped: [] }, preview: { prepared: [], refused: [{ name: 'Bo', why: 'no preview exists yet' }] } });
check('with nothing to send the button is disabled', /disabled/.test(r));
check('and the blocker is named', /no preview exists yet/.test(r));

section('U5b  one blocker stopping everybody reads as one task');
const many = renderInviteReview({ ok: true, candidates: { eligible: [], skipped: [] },
  preview: { prepared: [], refused: ['Ann','Bo','Cy','Di'].map((n) => ({ name: n, why: 'set a postal address in Settings' })) } });
check('the reason appears once, not four times', (many.match(/set a postal address/g) || []).length === 1,
  String((many.match(/set a postal address/g) || []).length));
check('with a count instead of four names', /4 contacts/.test(many), many.slice(0, 220));
check('and the total is still stated', /<b>4<\/b> cannot be invited/.test(many));
const mixedR = renderInviteReview({ ok: true, candidates: { eligible: [], skipped: [] },
  preview: { prepared: [], refused: [{ name: 'Ann', why: 'no preview exists yet' }, { name: 'Bo', why: 'set a postal address' }, { name: 'Cy', why: 'set a postal address' }] } });
check('different reasons stay separate', (mixedR.match(/<li>/g) || []).length === 2, String((mixedR.match(/<li>/g) || []).length));
check('a single-contact group names the person', /Ann/.test(mixedR));
check('and the biggest group is listed first', mixedR.indexOf('postal address') < mixedR.indexOf('no preview exists yet'));
const failed = renderInviteReview({ ok: false, error: 'nope' });
check('a failed review is named as a failure', /Could not work out who to invite/.test(failed), failed);
check('and warns against acting on it', /failed to load/.test(failed));

// ---------------------------------------------------------------------------
section('U6  every control has a handler');
const listeners = [];
const root = { addEventListener: (ev, fn) => listeners.push([ev, fn]) };
check('it wires', wireContactStatus(root, {}) === true);
check('wiring nothing is survivable', wireContactStatus(null, {}) === false);

listeners.length = 0;
const did = [];
wireContactStatus(root, { send: () => did.push('send'), review: () => did.push('review'), open: (id) => did.push('open:' + id) });
listeners[0][1]({ target: { closest: (s2) => (s2 === '#csInviteSend' ? {} : null) } });
check('the send button is wired', did[0] === 'send', JSON.stringify(did));
listeners[0][1]({ target: { closest: (s2) => (s2 === '[data-contact]' ? { getAttribute: () => 'c9' } : null) } });
check('a row opens that contact', did[1] === 'open:c9', JSON.stringify(did));
listeners[0][1]({ target: { closest: () => null } });
check('a click on nothing is survivable', did.length === 2);

// ---------------------------------------------------------------------------
section('U7  hostile data cannot inject markup');
html = renderStatusList({ ok: true, rows: [{
  id: '"><img src=x onerror=alert(1)>', name: '<script>alert(1)</script>',
  email: { label: '<b>x</b>', reason: 'ok', next: null }, sms: { label: 'y', reason: '<i>z</i>', next: null },
}] });
check('a name is escaped', !/<script>/.test(html), html.slice(0, 160));
// The real property is that no executable tag is FORMED. The literal text
// "onerror=" surviving inside an escaped attribute is harmless, and asserting
// against the substring would fail on safe output while passing on some unsafe
// output — a weaker check wearing a scarier name.
check('an id cannot break out of its attribute', !/<img/.test(html), html.slice(0, 200));
check('the quote that would end the attribute is escaped', /&quot;/.test(html) || !/data-contact="">/.test(html));
check('a label is escaped', !/<b>x<\/b>/.test(html));
check('a reason is escaped', !/<i>z<\/i>/.test(html));

// ---------------------------------------------------------------------------
section('U8  why this business is worth contacting, or that it is not');
const worth = { id: "w1", name: "Dana", email: emailOnly.email, sms: emailOnly.sms,
  observation: { has: true, summary: "No website is linked from their listing.",
    why: "That is a fact about the listing, not about the business.", next: "A preview is worth building." } };
html = renderStatusList({ ok: true, rows: [worth] });
check('a contactable prospect is marked worth contacting', /Worth contacting/.test(html), html.slice(0, 200));
check('the observation itself is shown', /No website is linked from their listing/.test(html));
check('with the caveat that keeps it honest', /fact about the listing, not about the business/.test(html));
check('and the action it implies', /A preview is worth building/.test(html));

const notWorth = { id: "w2", name: "Cy", email: emailOnly.email, sms: emailOnly.sms,
  observation: { has: false, summary: "They already have a working website.",
    why: "There is no honest observation to open with.", next: "Leave them alone unless something else connects you." } };
html = renderStatusList({ ok: true, rows: [notWorth] });
check('a business with a working site says there is NO honest opening', /No honest opening/.test(html), html.slice(0, 220));
check('and is not dressed up as an opportunity', !/Worth contacting/.test(html));
check('the advice is to leave them alone', /Leave them alone/.test(html));
check('it is given the same visual weight, not hidden', /cs-obs-no/.test(html) && /cs-obs-s/.test(html),
  "a quiet version of this is how a weaker reason gets reached for");
check('a row with no observation still renders', /cs-row/.test(renderStatusList({ ok: true, rows: [emailOnly] })));

done();
