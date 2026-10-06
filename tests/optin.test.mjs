// The owner's opt-in funnel, and the one thing about it that had to change.
//
// He wants to message every contact — "we built you a website, want to see
// it? YES or NO" — and treat a YES as the opt-in. That funnel is built here
// exactly as described. The single change: the invitation goes by EMAIL,
// because the invitation IS the marketing message, and texting 400 discovered
// numbers to ask whether they want marketing has already sent 400 unconsented
// marketing texts. The consent would arrive after the act it was meant to
// authorise.
//
// So: same words, same yes/no, carried on the channel allowed to carry a first
// contact — and a YES becomes a real per-person record with the wording
// attached, which is what makes it worth anything later.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  composeInvitation, readInviteReply, recordYes, recordNo,
  attestConsent, attestationFor, clearAttestation,
  contactStatus, statusTable, PERMISSION, INVITE_WORDING_VERSION,
} from '../lib/optin.js';
import { upsertContact, field, effectiveConsent, canContact } from '../lib/contacts.js';

const E = (v) => field(v, { confidence: 1, source: 'manual' });
const OWNER = { name: 'Mondo Davis', businessName: 'Inspiring Websites', postalAddress: '123 Example Rd, Plano TX 75024' };

async function freshContact(n, { phone = true } = {}) {
  const c = await upsertContact({
    source: 'discovery',
    name: E(`Owner ${n}`), businessName: E(`Business ${n}`),
    email: E(`owner${n}@business${n}.test`),
    ...(phone ? { phone: E(`(972) 555-01${String(n).padStart(2, '0')}`) } : {}),
  });
  return c.contact;
}

// ---------------------------------------------------------------------------
section('O1  the invitation is the owner\'s message, and every claim in it is true');
let inv = composeInvitation({ contact: { name: E('Dana Reyes'), businessName: E('Reyes Roofing') }, owner: OWNER, previewUrl: 'https://preview.test/r' });
check('it composes', inv.ok === true, inv.reason);
check('it offers the preview', /preview for Reyes Roofing/.test(inv.body), inv.body.slice(0, 160));
check('it says free, and that nothing is owed', /no charge|nothing owed/i.test(inv.body));
check('it asks the yes/no question the owner wanted', /Reply YES/.test(inv.body) && /Reply NO/.test(inv.body));
check('NO means we stop', /won't contact you again/.test(inv.body));
check('it identifies the sender', /Mondo Davis/.test(inv.body));
check('with a postal address, as CAN-SPAM requires', /Plano TX/.test(inv.body));
check('and it is versioned, so a consent record can cite it', inv.wordingVersion === INVITE_WORDING_VERSION);

section('O1b  it refuses to send a claim that is not true yet');
check('no preview means no "we built you a website"',
  composeInvitation({ contact: {}, owner: OWNER, previewUrl: null }).ok === false);
check('and says why that matters', /has to be true when it is sent/.test(
  composeInvitation({ contact: {}, owner: OWNER, previewUrl: null }).reason || ''));
check('an unidentified sender is refused', composeInvitation({ contact: {}, owner: { name: 'X' }, previewUrl: 'https://x.test' }).ok === false);
check('citing the real requirement', /postal address/i.test(
  composeInvitation({ contact: {}, owner: { name: 'X' }, previewUrl: 'https://x.test' }).reason || ''));

// ---------------------------------------------------------------------------
section('O2  reading the answer');
for (const t of ['yes', 'Yes please', 'YES!', 'yeah send it', 'sure', 'ok', 'interested'])
  check(`"${t}" is a yes`, readInviteReply(t).verdict === 'yes', readInviteReply(t).verdict);
for (const t of ['no', 'No thanks', 'NO', 'not interested', 'stop', 'remove me'])
  check(`"${t}" is a no`, readInviteReply(t).verdict === 'no', readInviteReply(t).verdict);
check('an empty reply is unclear', readInviteReply('').verdict === 'unclear');
check('a real reply is a conversation, not a vote',
  readInviteReply('Who is this and how did you get my email? We already have a web guy.').verdict === 'unclear',
  'a long reply must reach a person rather than being scored yes or no');
check('and says so', /real reply/.test(readInviteReply('Who is this and how did you get my email exactly').why));
check('"no thanks, maybe later" reads as no, not yes',
  readInviteReply('no thanks, maybe later').verdict === 'no');

// ---------------------------------------------------------------------------
section('O3  a YES is what makes texting legitimate');
const c1 = await freshContact(1);
let before = await canContact(c1, { channel: 'sms', purpose: 'one_time_followup' });
check('before the YES, texting is refused', before.ok === false, before.reason);

const yes = await recordYes(c1, { text: 'YES please send it', invite: inv });
check('the YES is recorded', yes.ok === true, JSON.stringify(yes).slice(0, 120));
check('as documented permission', yes.permission === PERMISSION.DOCUMENTED);

const c1b = await (await import('../lib/contacts.js')).getContact(c1.id);
const cons = effectiveConsent(c1b, 'sms');
check('the consent log now covers sms', cons.scope === 'one_time_followup', cons.scope);
check('the source names what they replied to', /preview invitation/i.test(cons.source || ''), cons.source);
const rec = (c1b.consentLog || []).slice(-1)[0];
check('their actual words are kept as evidence', /YES please send it/.test(rec.evidence || ''), rec.evidence);
check('and the wording they agreed to', /free website preview/i.test(rec.wording || ''), rec.wording);
check('which is what makes it provable later', !!rec.wordingVersion);

// These fixtures use 555-01xx, the range reserved for fiction — and the gate
// refuses them by name, which is a property worth keeping rather than routing
// around: a test number must never be able to become a real send.
const after = await canContact(c1b, { channel: 'sms', purpose: 'one_time_followup' });
check('a fiction-range number is refused even WITH consent', after.ok === false, after.reason);
check('and says why, rather than failing as "no permission"',
  /reserved for fiction/i.test(after.reason), after.reason);

// what recordYes is actually responsible for is the consent, so that is
// asserted directly rather than through a gate with its own separate rule
check('the consent scope itself now covers a follow-up', cons.scope === 'one_time_followup');
check('but NOT a promotional series', cons.scope !== 'promotional',
  'they asked for one thing; a series needs its own permission');

section('O3b  a NO is honoured on both channels');
const c2 = await freshContact(2);
await recordNo(c2, { text: 'No thanks' });
const c2b = await (await import('../lib/contacts.js')).getContact(c2.id);
check('they are opted out', !!c2b.optedOutAt, JSON.stringify(c2b).slice(0, 120));
check('email is refused', (await canContact(c2b, { channel: 'email', purpose: 'promotional' })).ok === false);
check('and sms is refused', (await canContact(c2b, { channel: 'sms', purpose: 'one_time_followup' })).ok === false);

// ---------------------------------------------------------------------------
section('O4  the owner\'s blanket checkbox is recorded as a claim, not as proof');
const c3 = await freshContact(3);
let att = await attestConsent({ contactIds: [c3.id], by: 'owner', basis: 'short' });
check('an unexplained assertion is refused', att.ok === false);
check('and asks how they gave permission', /how these people gave permission/i.test(att.error), att.error);
check('no contacts selected is refused', (await attestConsent({ contactIds: [], basis: 'a proper explanation here' })).ok === false);

att = await attestConsent({
  contactIds: [c3.id], by: 'owner',
  basis: 'Collected business cards at the Plano chamber mixer on 2026-09-18; each person was told I would text them a website preview.',
});
check('a proper one is accepted', att.ok === true, att.error);
check('it unlocks one message', /one requested follow-up/.test(att.unlocks));
check('and explicitly NOT a sequence', /recurring/.test(att.doesNotUnlock));
check('it points at the way to make it real', /email invitation/i.test(att.note));

const stored = await attestationFor(c3.id);
check('who asserted it is kept', stored.by === 'owner');
check('and when', !!stored.at);
check('and on what basis', /chamber mixer/.test(stored.basis));
// the STORED scope, not the description beside it: a record saying
// "promotional" while the blurb says "one follow-up" is the shape of this
// going wrong quietly, and asserting only the blurb would miss it
check('the stored scope is a single follow-up', stored.scope === 'one_time_followup', stored.scope);
check('never promotional', stored.scope !== 'promotional',
  'a blanket claim cannot tell the person who asked for a call from the one whose card was in a bowl');

check('it is NOT written into the consent log',
  effectiveConsent(await (await import('../lib/contacts.js')).getContact(c3.id), 'sms').scope === 'none',
  'keeping them apart is what lets the screen say "asserted, nothing on file" instead of showing a tick');

// ---------------------------------------------------------------------------
section('O5  the status table says exactly what each person is');
let st = await contactStatus(await (await import('../lib/contacts.js')).getContact(c1.id));
check('a YES is recognised as documented permission', st.sms.permission === PERMISSION.DOCUMENTED, JSON.stringify(st.sms));
// the fixture's number is fiction-range, so the gate still refuses it — and
// the STATUS must reflect the gate rather than the consent, or the screen
// would promise a send that the send path would then refuse
check('the status follows the gate, not the paperwork', st.sms.eligible === false);
check('and the reason names the real obstacle', /reserved for fiction/i.test(st.sms.reason), st.sms.reason);
check('email stays separately described', st.email.label === 'Email OK', st.email.label);

st = await contactStatus(await (await import('../lib/contacts.js')).getContact(c3.id));
check('an asserted contact is marked owner-asserted', st.sms.permission === PERMISSION.ATTESTED);
check('the label says so on the screen', /owner-asserted/.test(st.sms.label), st.sms.label);
check('the reason admits nothing is on file for them', /nothing on file for this person/.test(st.sms.reason), st.sms.reason);
check('and the next action is to make it real', /email invitation/i.test(st.sms.next), st.sms.next);

const c4 = await freshContact(4);
st = await contactStatus(await (await import('../lib/contacts.js')).getContact(c4.id));
check('a plain discovered contact needs permission', st.sms.label === 'Permission needed', st.sms.label);
check('it is NOT sms eligible', st.sms.eligible === false);
check('but it IS emailable — the two never blur', st.email.eligible === true,
  'a contact marked emailable must not look SMS-eligible, and the reverse');
check('with the next step spelled out', /YES unlocks texting/.test(st.sms.next), st.sms.next);

const c5 = await freshContact(5, { phone: false });
st = await contactStatus(await (await import('../lib/contacts.js')).getContact(c5.id));
check('no mobile is its own state, not "permission needed"', st.sms.label === 'No mobile number', st.sms.label);

st = await contactStatus(await (await import('../lib/contacts.js')).getContact(c2.id));
check('an opted-out contact says so on both channels', st.suppressed === true && st.email.label === 'Opted out');

section('O5b  the counts');
const { getContact } = await import('../lib/contacts.js');
const all = await Promise.all([c1, c2, c3, c4, c5].map((c) => getContact(c.id)));
const table = await statusTable(all);
check('five contacts', table.total === 5, String(table.total));
check('one has documented sms permission', table.smsEligible >= 1, String(table.smsEligible));
check('none has promotional permission', table.smsPromotional === 0, String(table.smsPromotional));
check('one is owner-asserted', table.ownerAsserted === 1, String(table.ownerAsserted));
check('one is suppressed', table.suppressed === 1, String(table.suppressed));
check('one has no mobile', table.unknown === 1, String(table.unknown));

await clearAttestation(c3.id);
check('an attestation can be withdrawn', (await attestationFor(c3.id)) === null);

// ---------------------------------------------------------------------------
section('O6  the observation, including when there is not one');
const { observationFor } = await import('../lib/optin.js');
let ob = await observationFor({ web: { status: 'not-linked-in-listing' } });
check('a listing with no site is worth contacting', ob.has === true);
check('and the caveat is carried with it', /fact about the listing/.test(ob.why), ob.why);
ob = await observationFor({ web: { status: 'verified-present' } });
check('a working site means NO honest opening', ob.has === false, JSON.stringify(ob));
check('and says why that is not a reason to write anyway', /opinion we have not earned/.test(ob.why), ob.why);
check('the advice is to leave them alone', /Leave them alone/.test(ob.next));
ob = await observationFor({ web: { status: 'uncertain' } });
check('uncertain is not treated as missing', ob.has === false, JSON.stringify(ob));
check('and says so in those words', /Uncertain is not the same as missing/.test(ob.why), ob.why);
ob = await observationFor({});
check('unchecked is its own answer', ob.has === false && ob.status === null);
check('and asks for the check rather than guessing', /Run a web check/.test(ob.next), ob.next);

done();
