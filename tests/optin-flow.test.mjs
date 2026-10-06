// The opt-in funnel with something actually driving it.
//
// The first version of this was a library with no caller — the exact failure
// found overnight, and the reviewer caught me repeating it. The model was
// correct and nothing in the application could run it: the owner could not
// send an invitation, a reply could not be read as an answer, and no consent
// record would ever have been created outside a test.
//
// So these checks are about the TRIGGERS. The mailbox pass that already runs
// on the automation tick now reads invitation answers; the owner has an
// endpoint that reviews before it sends; and the status table has a route.
import { check, section, done } from './world.mjs';
import fs from 'node:fs';
import { store } from '../lib/store.js';
import {
  invitedAt, markInvited, applyInviteReply, invitationCandidates, sendInvitations,
  contactStatus, PERMISSION,
} from '../lib/optin.js';
import { upsertContact, field, getContact, effectiveConsent } from '../lib/contacts.js';
import { ingestReplies } from '../lib/replies.js';

const E = (v) => field(v, { confidence: 1, source: 'manual' });
const OWNER = { name: 'Mondo Davis', businessName: 'Inspiring Websites', postalAddress: '123 Example Rd, Plano TX 75024' };

async function contact(n) {
  const c = await upsertContact({
    source: 'discovery', name: E(`Owner ${n}`), businessName: E(`Business ${n}`),
    email: E(`owner${n}@biz${n}.test`), phone: E(`(972) 555-02${String(n).padStart(2, '0')}`),
  });
  return c.contact;
}

// ---------------------------------------------------------------------------
section('F1  THE TRIGGER: the mailbox pass reads invitation answers');
// This is the check that would have caught the orphan. ingestReplies is what
// the automation tick calls; if the funnel is not in there, nothing ever runs it.
const src = fs.readFileSync(new URL('../lib/replies.js', import.meta.url), 'utf8');
check('the ingest pass imports the opt-in module', /import\('\.\/optin\.js'\)/.test(src));
check('it checks whether this contact was invited', /invitedAt\(/.test(src));
check('and applies their answer', /applyInviteReply\(/.test(src));

const a = await contact(1);
await markInvited(a.id, {});
check('the invitation is recorded as sent', !!(await invitedAt(a.id)));

let ingested = await ingestReplies({
  listMail: async () => ([{ id: 'm1', from: `Owner 1 <${a.email.value}>`, subject: 'Re: A website preview', body: 'YES please send it over' }]),
  isKnownContact: async () => ({ contactId: a.id }),
});
check('the reply was ingested', ingested.ok === true && ingested.ingested >= 0, JSON.stringify(ingested).slice(0, 120));
const aAfter = await getContact(a.id);
check('and the YES became a real consent record', effectiveConsent(aAfter, 'sms').scope === 'one_time_followup',
  effectiveConsent(aAfter, 'sms').scope);
check('created by the scheduled pass, not by a test calling the library',
  (aAfter.consentLog || []).some((r) => /preview invitation/i.test(r.source || '')));
check('the run reports the opt-in', ingested.optIns === 1, String(ingested.optIns));

section('F1b  a NO through the same path');
const b = await contact(2);
await markInvited(b.id, {});
ingested = await ingestReplies({
  listMail: async () => ([{ id: 'm2', from: `<${b.email.value}>`, subject: 'Re:', body: 'No thanks' }]),
  isKnownContact: async () => ({ contactId: b.id }),
});
check('they are suppressed', !!(await getContact(b.id)).optedOutAt);
check('and counted as an opt-out', ingested.optOuts === 1, String(ingested.optOuts));

section('F1c  "yes" from somebody who was never asked is just a word');
const c = await contact(3);
// deliberately NOT invited
ingested = await ingestReplies({
  listMail: async () => ([{ id: 'm3', from: `<${c.email.value}>`, subject: 'Re:', body: 'yes' }]),
  isKnownContact: async () => ({ contactId: c.id }),
});
check('no consent is created', effectiveConsent(await getContact(c.id), 'sms').scope === 'none',
  'treating this as consent would be exactly the inference the module exists to prevent');
check('and nothing is counted as an opt-in', !ingested.optIns);

section('F1d  an unclear answer changes nothing and reaches a person');
const d = await contact(4);
await markInvited(d.id, {});
const unclear = await applyInviteReply(d.id, 'Who is this and how did you get my email? We already have someone.');
check('it is unclear', unclear.verdict === 'unclear');
check('nothing changed', unclear.changed === false);
check('a person is needed', unclear.needsPerson === true);
check('their standing is untouched', effectiveConsent(await getContact(d.id), 'sms').scope === 'none');

// ---------------------------------------------------------------------------
section('F2  the owner reviews before anything leaves');
const e1 = await contact(5);
const cands = await invitationCandidates([await getContact(e1.id), await getContact(a.id), await getContact(b.id)]);
check('a fresh contact is a candidate', cands.eligible.some((x) => x.id === e1.id));
check('one already invited is skipped', cands.skipped.some((x) => x.id === a.id && /already invited/.test(x.why)));
check('one who said no is skipped', cands.skipped.some((x) => x.id === b.id), JSON.stringify(cands.skipped));
check('with the reason, not just excluded', cands.skipped.every((x) => !!x.why));

section('F2b  a dry run composes everything and sends nothing');
let sent = [];
const dry = await sendInvitations([await getContact(e1.id)], {
  owner: OWNER, previewUrlFor: async () => 'https://preview.test/5',
  send: async (m) => { sent.push(m); return { ok: true }; },
  dryRun: true,
});
check('nothing was sent', sent.length === 0, JSON.stringify(sent).slice(0, 80));
check('but the message was composed', dry.prepared.length === 1);
check('and it is the real message', /Reply YES/.test(dry.prepared[0].body));
check('the contact is NOT marked invited by a dry run', !(await invitedAt(e1.id)));

section('F2c  with no sender connected it says so rather than doing nothing');
const nos = await sendInvitations([await getContact(e1.id)], { owner: OWNER, previewUrlFor: async () => 'https://p.test' });
check('it refuses', nos.ok === false);
check('and names the reason', /no email sender is connected/.test(nos.error), nos.error);
check('marked disconnected, not failed', nos.disconnected === true,
  'not connected and tried-and-failed look identical on a screen; only one is honest');

section('F2d  a real send marks them invited, so a reply can be read');
sent = [];
const real = await sendInvitations([await getContact(e1.id)], {
  owner: OWNER, previewUrlFor: async () => 'https://preview.test/5',
  send: async (m) => { sent.push(m); return { ok: true }; },
});
check('it sent one', real.sent === 1, JSON.stringify(real).slice(0, 120));
check('to the right address', /owner5@biz5\.test/.test(sent[0].to), sent[0].to);
check('now they are marked invited', !!(await invitedAt(e1.id)));

section('F2e  a contact with no preview is refused individually, not in bulk');
const f = await contact(6);
const mixed = await sendInvitations([await getContact(f.id)], {
  owner: OWNER, previewUrlFor: async () => null,
  send: async () => ({ ok: true }),
});
check('that one is refused', mixed.refused.length === 1);
check('because the claim would not be true', /has to be true when it is sent/.test(mixed.refused[0].why), mixed.refused[0].why);
check('and nothing was sent for them', mixed.sent === 0);

// ---------------------------------------------------------------------------
section('F3  the endpoints exist and the review one sends nothing');
const api = fs.readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
for (const c2 of ['contact-status', 'invite-review', 'invite-send', 'attest-consent'])
  check(`?do=${c2} is routed`, new RegExp(`case '${c2}'`).test(api));
check('review runs as a dry run', /dryRun: true/.test(api.slice(api.indexOf("case 'invite-review'"), api.indexOf("case 'invite-send'"))));
check('and says so in its answer', /sendsNothing: true/.test(api));
check('sending is POST only', /sending is a POST/.test(api));
check('and obeys the owner\'s outreach switch', /outreach is switched off/.test(api),
  'the master switch has to govern this path exactly as it governs the others');

// ---------------------------------------------------------------------------
section('F4  status after a YES is readable');
const st = await contactStatus(await getContact(a.id));
check('permission is documented', st.sms.permission === PERMISSION.DOCUMENTED, JSON.stringify(st.sms));
check('email and sms are separate objects', !!st.email && !!st.sms);
check('each carries its own reason', !!st.email.reason && !!st.sms.reason);

done();
