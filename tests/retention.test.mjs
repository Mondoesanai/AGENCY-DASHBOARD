// R11.8 — deletion that actually deletes, and remembers the one thing it must.
import { check, section, done } from './world.mjs';
import { RETENTION, identityHash, erasePerson, wasErased, runRetentionSweep, exportPerson } from '../lib/retention.js';
import { upsertContact, field, getContact, canContact, listContacts } from '../lib/contacts.js';
import { recordReply, listReplies, REPLY_KINDS } from '../lib/replies.js';
import { createCampaign, addMember, getMember, CAMPAIGN_TYPES } from '../lib/campaigns.js';
import { store } from '../lib/store.js';

const E = (v) => field(v, { confidence: 1, source: 'manual' });

// ---------------------------------------------------------------------------
section('T1  erasing a person removes their data');
const camp = (await createCampaign({ name: 'retention test', type: CAMPAIGN_TYPES.COLD_NO_SITE })).campaign;
const c = (await upsertContact({
  source: 'discovery',
  name: E('Erase Me'),
  businessName: E('Erase Co'),
  email: E('eraseme@test.test'),
  phone: E('214-555-0999'),
})).contact;
await addMember(camp.id, c);
await recordReply({ contactId: c.id, kind: REPLY_KINDS.NOT_INTERESTED, text: 'please go away', campaignId: camp.id });

check('the contact exists first', !!(await getContact(c.id)));
check('they have a reply on file', (await listReplies({ limit: 500 })).some((r) => r.contactId === c.id));
check('and a campaign membership', !!(await getMember(camp.id, c.id)));

const result = await erasePerson({ contactId: c.id, reason: 'they asked' });
check('the erase succeeds', result.ok === true, JSON.stringify(result).slice(0, 160));
check('the contact record is gone', (await getContact(c.id)) === null);
check('their reply messages are gone', !(await listReplies({ limit: 500 })).some((r) => r.contactId === c.id));
check('their campaign membership is gone', (await getMember(camp.id, c.id)) === null);
check('they are gone from the contact list', !((await listContacts({ limit: 500 })).contacts || []).some((x) => x.id === c.id));
check('it reports what it erased', result.erased.length >= 3, JSON.stringify(result.erased));

// ---------------------------------------------------------------------------
section('T2  the one thing deletion must NOT erase');
// Erasing the suppression along with the record is how a "deleted" person gets
// emailed again next month by a re-import.
check('it says what it kept', result.kept.length >= 1, JSON.stringify(result.kept));
check('and why that is not a loophole', /Nothing kept can reconstruct who this was/.test(result.keptNote), result.keptNote);
 check('the hash is described as one-way', /salted and one-way/.test(result.keptNote));

const w = await wasErased('eraseme@test.test');
check('the address is recognised as erased', w.erased === true, JSON.stringify(w));
check('with the reason kept', w.reason === 'they asked');
check('a different address is not', (await wasErased('someoneelse@test.test')).erased === false);

// the decisive test: re-importing them must not make them contactable again
const reimported = (await upsertContact({
  source: 'csv_import',
  name: E('Erase Me'),
  businessName: E('Erase Co'),
  email: E('eraseme@test.test'),
})).contact;
check('a re-import creates a fresh record', !!reimported.id);
const allowed = await canContact(reimported, { channel: 'email', purpose: 'promotional' });
check('BUT THEY ARE STILL NOT CONTACTABLE', allowed.ok === false, JSON.stringify(allowed));
check('because the suppression survived the deletion', /opted out|suppress|erased/i.test(allowed.reason), allowed.reason);

// ---------------------------------------------------------------------------
section('T3  the tombstone cannot be turned back into a person');
const h = identityHash('eraseme@test.test');
check('the hash is not the address', !h.includes('eraseme') && !h.includes('@'), h);
check('it is fixed length', h.length === 32, String(h.length));
check('the same address hashes the same way', identityHash('eraseme@test.test') === h);
check('case and spacing do not change it', identityHash('  ERASEME@Test.test ') === h);
check('a different address hashes differently', identityHash('other@test.test') !== h);
const raw = await store.get(`erased:${h}`);
// The needle used to include the bare area code "214", which is three digits
// that a millisecond timestamp contains roughly a third of the time — so this
// check failed or passed depending on the day it ran, and a test that is
// sometimes red for no reason is a test people learn to ignore. Matched
// against the identifying values in full instead.
check(
  'the stored tombstone holds no personal data',
  !/eraseme|Erase Co|214-555-0999|2145550999/i.test(String(raw)),
  String(raw)
);
check('and the needles are the ones actually in the fixture',
  /eraseme/i.test('eraseme@test.test') && /214-555-0999/.test('214-555-0999'),
  'a scan for values the fixture never had would pass on an empty string');

// ---------------------------------------------------------------------------
section('T4  erasing someone who does not exist is refused, not faked');
check('an unknown contact is refused', (await erasePerson({ contactId: 'nope' })).ok === false);
check('and an unknown email too', (await erasePerson({ email: 'ghost@nowhere.test' })).ok === false);

// ---------------------------------------------------------------------------
section('T5  the retention sweep is conservative about what it will delete');
check('the windows are stated, not implied', typeof RETENTION.prospectsNeverContactedDays === 'number');
check('and measured from last activity', /last activity/.test(RETENTION.note), RETENTION.note);

const dry = await runRetentionSweep({ dryRun: true });
check('a dry run deletes nothing', dry.dryRun === true);
check('and says so', /nothing was deleted/.test(dry.note), dry.note);
check('it names what it will never remove by age', dry.kept.length === 3, JSON.stringify(dry.kept));
check('contacts are never removed on a timer', dry.kept.some((k) => /not on a timer/.test(k)));
check('opt-outs never expire', dry.kept.some((k) => /never expire/.test(k)));
check('bookings are kept as a commercial record', dry.kept.some((k) => /commercial relationship/.test(k)));

// a contact older than every window is still not touched by the sweep
const old = (await upsertContact({ source: 'manual', name: E('Old Contact'), email: E('old@test.test') })).contact;
await store.set(`contact:${old.id}`, JSON.stringify({ ...old, createdAt: Date.now() - 5 * 365 * 86400000 }));
await runRetentionSweep({ now: Date.now() });
check('a five-year-old contact survives the sweep', !!(await getContact(old.id)));

// ---------------------------------------------------------------------------
section('T6  a person can be shown everything held about them');
const subject = (await upsertContact({ source: 'manual', name: E('Subject Access'), email: E('sar@test.test') })).contact;
await recordReply({ contactId: subject.id, kind: REPLY_KINDS.WANTS_DETAILS, text: 'how much is it' });
const exp = await exportPerson(subject.id);
check('the export succeeds', exp.ok === true);
check('it includes the contact record', exp.contact.id === subject.id);
check('it includes their messages', exp.replies.some((r) => /how much is it/.test(r.text)), JSON.stringify(exp.replies));
check('and the consent history, so they can see why we wrote to them', Array.isArray(exp.consentHistory));
check('an unknown person is refused', (await exportPerson('nope')).ok === false);

done();
