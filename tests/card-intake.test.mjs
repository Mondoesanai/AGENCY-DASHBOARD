import { W, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  normaliseCard, mergeCardSides, reviewQueue, saveCards,
  parseCsv, guessMapping, previewCsv, importCsv,
  readCardImage, storeCardImage, getCardImage, MAX_IMAGE_BYTES,
} from '../lib/card-intake.js';
import { getContact, canContact, effectiveConsent, listContacts } from '../lib/contacts.js';

section('K1  OCR confidence: a clear card is trusted, a blurry one is questioned');
const clear = normaliseCard({
  side: 'front',
  name: { value: 'Dana Reyes', confidence: 0.99, uncertain: '' },
  businessName: { value: 'Reyes Roofing', confidence: 0.99, uncertain: '' },
  email: { value: 'dana@reyesroofing.com', confidence: 0.97, uncertain: '' },
  phone: { value: '(214) 555-0143', confidence: 0.96, uncertain: '' },
});
check('a sharp card needs no review', reviewQueue(clear).length === 0, JSON.stringify(reviewQueue(clear)));
const blurry = normaliseCard({
  side: 'front',
  name: { value: 'Dana Reyes', confidence: 0.9, uncertain: '' },
  email: { value: 'dana@rey3sroofing.com', confidence: 0.55, uncertain: 'the 4th char could be e or 3' },
});
const q = reviewQueue(blurry);
check('an uncertain email is flagged for a human', q.some((i) => i.field === 'email'), JSON.stringify(q));
check('…and the model’s note about what it struggled with is kept', /could be e or 3/.test(q.find((i) => i.field === 'email').uncertain));

section('K2  our own format check overrides an over-confident model');
const liar = normaliseCard({
  email: { value: 'dana(at)reyesroofing.com', confidence: 0.99, uncertain: '' },
  phone: { value: '555-01', confidence: 0.99, uncertain: '' },
  website: { value: 'reyesroofing', confidence: 0.99, uncertain: '' },
});
check('an unparseable email is downgraded despite 0.99 confidence', liar.email.needsReview === true && liar.email.confidence <= 0.4, String(liar.email.confidence));
check('a too-short phone is downgraded', liar.phone.needsReview === true);
check('a bare word that is not a domain is downgraded', liar.website.needsReview === true);
check('…but nothing is deleted — the raw reading is preserved for the reviewer', liar.email.value === 'dana(at)reyesroofing.com');

section('K3  a field that is not on the card is left empty, never invented');
const sparse = normaliseCard({ name: { value: 'Pat Ortiz', confidence: 0.95 }, email: { value: null, confidence: 0 }, phone: null });
check('a null email stays null', sparse.email === null);
check('a missing phone stays missing', sparse.phone === null);
check('…and we do NOT fabricate one from the name and a domain', !sparse.email);

section('K4  one photo, several cards; and front/back of the same card');
const twoPeople = mergeCardSides([
  normaliseCard({ side: 'front', name: { value: 'A One', confidence: 0.9 }, businessName: { value: 'Alpha Co', confidence: 0.95 }, email: { value: 'a@alpha.com', confidence: 0.9 } }),
  normaliseCard({ side: 'front', name: { value: 'B Two', confidence: 0.9 }, businessName: { value: 'Beta Co', confidence: 0.95 }, email: { value: 'b@beta.com', confidence: 0.9 } }),
]);
check('two different businesses stay two contacts', twoPeople.length === 2, String(twoPeople.length));
const frontBack = mergeCardSides([
  normaliseCard({ side: 'front', name: { value: 'Cy Vance', confidence: 0.95 }, businessName: { value: 'Vance HVAC', confidence: 0.95 } }),
  normaliseCard({ side: 'back', businessName: { value: 'Vance HVAC', confidence: 0.9 }, phone: { value: '(469) 555-0188', confidence: 0.93 }, email: { value: 'cy@vancehvac.com', confidence: 0.94 } }),
]);
check('front and back of one card become ONE contact', frontBack.length === 1, String(frontBack.length));
check('…combining the details from both sides', frontBack[0].name?.value === 'Cy Vance' && frontBack[0].phone?.value === '(469) 555-0188' && frontBack[0].email?.value === 'cy@vancehvac.com');
check('…and records that both sides were seen', (frontBack[0].sides || []).includes('back'));

section('K5  saving cards creates usable contacts with honest relationship context');
const saved = await saveCards(frontBack, { relationship: 'met_in_person', event: 'North Dallas Chamber breakfast', meetingNotes: 'wants a quote for a new site', collectedAt: '2026-10-01T15:00:00Z' });
check('the contact exists and is findable afterwards', saved.length === 1 && !!(await getContact(saved[0].contact.id)));
const cy = await getContact(saved[0].contact.id);
check('the meeting context is stored, not invented', cy.relationship === 'met_in_person' && /Chamber breakfast/.test(cy.event) && /quote for a new site/.test(cy.meetingNotes));
check('it is contactable by email (business address)', (await canContact(cy, { channel: 'email' })).ok === true);

section('K6  holding someone’s card is NOT permission to text them');
check('no SMS consent is recorded by default', effectiveConsent(cy, 'sms').scope === 'none');
const smsBlocked = await canContact(cy, { channel: 'sms', purpose: 'promotional' });
check('a marketing text is refused', smsBlocked.ok === false, smsBlocked.reason);
const withPermission = await saveCards(
  [normaliseCard({ name: { value: 'Jo Ok', confidence: 0.95 }, businessName: { value: 'Ok Co', confidence: 0.95 }, email: { value: 'jo@okco.com', confidence: 0.95 }, phone: { value: '(214) 555-0170', confidence: 0.95 } })],
  { relationship: 'met_in_person', smsConsent: { granted: true, scope: 'one_time_followup', source: 'verbal at meeting', wording: 'said to text her the preview link' } }
);
const jo = await getContact(withPermission[0].contact.id);
check('an explicitly recorded one-time permission is stored with its wording', effectiveConsent(jo, 'sms').scope === 'one_time_followup' && /preview link/.test(jo.consentLog[0].wording));
check('…and still does NOT authorise ongoing marketing', (await canContact({ ...jo, phoneType: 'mobile' }, { channel: 'sms', purpose: 'promotional' })).ok === false);
check('…but does authorise the promised follow-up', (await canContact({ ...jo, phoneType: 'mobile' }, { channel: 'sms', purpose: 'one_time_followup' })).ok === true);

section('K7  "same networking group" is not the same claim as "we met"');
const group = await saveCards([normaliseCard({ name: { value: 'Group Member', confidence: 0.9 }, businessName: { value: 'Member Co', confidence: 0.9 }, email: { value: 'gm@memberco.com', confidence: 0.95 } })], { relationship: 'same_networking_group', networkingGroup: 'BNI Plano' });
const gm = await getContact(group[0].contact.id);
check('the weaker, truthful claim is recorded', gm.relationship === 'same_networking_group' && gm.networkingGroup === 'BNI Plano');
check('…and it does not masquerade as a meeting', gm.relationship !== 'met_in_person');

section('K8  CSV parsing handles the messy files people actually have');
const rows = parseCsv('Name,Company,Email\n"Smith, John",Acme Inc,john@acme.com\n"Say ""Hi""",Beta,b@beta.com\n\n');
check('a quoted comma does not split the field', rows[1][0] === 'Smith, John', JSON.stringify(rows[1]));
check('escaped quotes are unescaped', rows[2][0] === 'Say "Hi"', JSON.stringify(rows[2]));
check('blank lines are dropped', rows.length === 3, String(rows.length));
const map = guessMapping(['Full Name', 'Company Name', 'E-Mail', 'Phone Number', 'Website']);
check('column headers are matched to fields', map.name === 0 && map.businessName === 1 && map.email === 2 && map.phone === 3 && map.website === 4, JSON.stringify(map));

section('K9  import preview writes nothing and tells the truth about each row');
const csv = [
  'Name,Company,Email,Phone',
  'Dana Reyes,Reyes Roofing,dana@reyesroofing.com,214-555-0143',
  'Cy Vance,Vance HVAC,cy@vancehvac.com,469-555-0188',
  'Broken Row,No Contact Co,,',
  'Bad Email,Oops Co,not-an-email,',
  'Dana Reyes,Reyes Roofing,dana@reyesroofing.com,214-555-0143',
].join('\n');
const before = (await listContacts({ limit: 500 })).total;
const pv = await previewCsv(csv, null);
check('preview does not create anything', (await listContacts({ limit: 500 })).total === before, 'contacts changed during preview');
check('a row with no email or phone is marked skip', pv.rows[2].action === 'skip' && /nothing to contact them with/.test(pv.rows[2].problems[0]), JSON.stringify(pv.rows[2]));
check('an invalid email is called out', /not valid/.test(pv.rows[3].problems.join(' ')), JSON.stringify(pv.rows[3].problems));
check('a row duplicated inside the same file is flagged', /duplicated earlier in this same file/.test(pv.rows[4].problems.join(' ')));
check('an existing contact is shown as a merge, not a new record', pv.rows[1].action === 'merge' && !!pv.rows[1].mergeInto, JSON.stringify(pv.rows[1]));
check('the counts add up for the owner to sanity-check', pv.willCreate + pv.willMerge + pv.willSkip === pv.previewed, JSON.stringify({ c: pv.willCreate, m: pv.willMerge, s: pv.willSkip, p: pv.previewed }));

section('K10  import commits, and a spreadsheet column can never create SMS consent');
const res = await importCsv(csv, null, { relationship: 'none' });
check('valid rows are imported', res.created >= 1 && res.ok, JSON.stringify(res));
check('rows with nothing usable to contact are skipped, not half-created', res.skipped === 2, String(res.skipped));
 check('…and the owner is told which rows were dropped and why', res.errors.some((e) => /no usable email or phone/.test(e.error)), JSON.stringify(res.errors));
const imported = (await listContacts({ limit: 500 })).contacts.find((c) => c.email?.value === 'dana@reyesroofing.com');
check('the imported contact is real and usable', !!imported && (await canContact(imported, { channel: 'email' })).ok === true);
check('an import grants NO sms consent on its own', effectiveConsent(imported, 'sms').scope === 'none');
const withConsent = await importCsv('Name,Email\nCon Sent,consent@biz.com', { name: 0, email: 1 }, {
  consent: { scope: 'promotional', channel: 'email', source: 'signup form on our site', wording: 'I agree to receive emails from Inspiring Websites', wordingVersion: 'v2' },
});
check('consent IS recorded when the owner supplies real wording and source', withConsent.created === 1);
const cs = (await listContacts({ limit: 500 })).contacts.find((c) => c.email?.value === 'consent@biz.com');
check('…with the exact wording stored as evidence', /I agree to receive emails/.test(cs.consentLog[0].wording) && cs.consentLog[0].wordingVersion === 'v2');

section('K11  re-importing the same file does not duplicate anyone');
const totalBefore = (await listContacts({ limit: 500 })).total;
await importCsv(csv, null, { relationship: 'none' });
check('a second identical import creates nobody new', (await listContacts({ limit: 500 })).total === totalBefore, `was ${totalBefore}`);

section('K12  card images are stored for later checking, oversize ones refused');
const small = await storeCardImage(Buffer.from('fake-image-bytes').toString('base64'), 'image/jpeg');
check('an image is stored and returns a key', small.ok && !!small.key);
check('…and can be fetched back to re-check a disputed field', (await getCardImage(small.key))?.mimeType === 'image/jpeg');
const huge = await storeCardImage('A'.repeat(MAX_IMAGE_BYTES * 2), 'image/jpeg');
check('an oversize photo is refused with a plain message', huge.ok === false && /too large/.test(huge.error), huge.error);

section('K13  reading a real photo end to end (model mocked)');
W.anthropic.push(JSON.stringify({
  cards: [
    { side: 'front', name: { value: 'Mia Chen', confidence: 0.97, uncertain: '' }, businessName: { value: 'Chen Dental', confidence: 0.98, uncertain: '' }, role: { value: 'Owner', confidence: 0.9, uncertain: '' }, email: { value: 'mia@chendental.com', confidence: 0.96, uncertain: '' }, phone: { value: '(972) 555-0122', confidence: 0.95, uncertain: '' }, website: { value: 'chendental.com', confidence: 0.94, uncertain: '' }, address: null, otherText: 'Plano, TX' },
    { side: 'front', name: { value: 'Ravi Patel', confidence: 0.6, uncertain: 'surname may be Pate1' }, businessName: { value: 'Patel Law', confidence: 0.92, uncertain: '' }, email: { value: 'ravi@pate1law.com', confidence: 0.45, uncertain: 'l vs 1 in the domain' }, phone: null, website: null, address: null, otherText: '' },
  ],
}));
const read = await readCardImage({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg', note: 'two cards from the chamber event' });
check('both cards on the photo are read', read.ok && read.cards.length === 2, JSON.stringify(read).slice(0, 160));
check('the clean card needs no review', reviewQueue(read.cards[0]).length === 0);
const ravi = reviewQueue(read.cards[1]);
check('the ambiguous l-vs-1 email is held for review, not saved blind', ravi.some((i) => i.field === 'email'), JSON.stringify(ravi));
check('the cost of reading is reported so it can be billed to the budget', typeof read.costUsd === 'number' && read.costUsd >= 0);
const savedBoth = await saveCards(read.cards, { relationship: 'met_in_person', event: 'Chamber event' });
check('both become contacts, with the uncertain one flagged', savedBoth.length === 2 && savedBoth[1].review.length > 0);

void store;
done();
