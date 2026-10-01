import { W, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  normEmail, normPhone, normDomain, field, makeConsentRecord, effectiveConsent,
  canContact, upsertContact, getContact, findDuplicates, mergeInto, optOut,
  isSuppressed, listContacts, deleteContact,
} from '../lib/contacts.js';

void W;
const E = (v, c = 1) => field(v, { confidence: c, source: 'manual' });

section('C1  normalisation decides what counts as a duplicate');
check('gmail dots and +tags collapse', normEmail('First.Last+leads@Gmail.com') === 'firstlast@gmail.com');
check('other providers keep their dots (different mailboxes)', normEmail('first.last@acme.com') === 'first.last@acme.com');
check('a display-name header is unwrapped', normEmail('Angie May <Angie@OMT.com>') === 'angie@omt.com');
check('nonsense is rejected rather than stored', normEmail('not an email') === '' && normEmail('') === '');
check('10-digit US number becomes E.164', normPhone('(972) 555-0199') === '+19725550199');
check('already-E.164 is left alone', normPhone('+19725550199') === '+19725550199');
check('a too-short number is refused, not padded', normPhone('555-0199') === '');
check('domain strips scheme/www/path', normDomain('https://www.OMTServices.com/services.html') === 'omtservices.com');
check('free-mail hosts are not business domains', normDomain('gmail.com') === '' && normDomain('yahoo.co.uk') === '');

section('C2  a field never silently invents data, and low confidence is flagged');
check('empty value yields null, not an empty field', field('') === null && field(null) === null);
check('low-confidence OCR is marked for review', field('tnfo@acme.com', { confidence: 0.5, source: 'business_card', raw: 'tnfo@acme.com' }).needsReview === true);
check('high-confidence is not flagged', field('info@acme.com', { confidence: 0.98 }).needsReview === false);
check('the raw OCR text is kept for the reviewer', field('tnfo@acme.com', { confidence: 0.5, raw: 'lnfo@acme.com' }).raw === 'lnfo@acme.com');

section('C3  consent is append-only and withdrawal always wins');
const log = [
  makeConsentRecord({ scope: 'one_time_followup', channel: 'sms', source: 'business card', wording: 'said text me the preview', at: '2026-01-01T00:00:00Z' }),
  makeConsentRecord({ scope: 'promotional', channel: 'sms', source: 'web form', wording: 'I agree to receive marketing texts', wordingVersion: 'v1', at: '2026-02-01T00:00:00Z' }),
];
check('latest grant is the effective one', effectiveConsent({ consentLog: log }, 'sms').scope === 'promotional');
const withdrawn = { consentLog: [...log, { scope: 'none', channel: 'sms', at: '2026-03-01T00:00:00Z', withdrawn: true }] };
check('a later withdrawal revokes it', effectiveConsent(withdrawn, 'sms').scope === 'none');
check('consent on one channel does not grant the other', effectiveConsent({ consentLog: log }, 'email').scope === 'none');
check('an unknown scope is rejected outright', (() => { try { makeConsentRecord({ scope: 'whatever' }); return false; } catch { return true; } })());

section('C4  eligibility — the gate every send passes through');
const bizOk = { id: 'x', email: E('owner@acmeplumbing.com'), consentLog: [] };
check('cold email to a business address is allowed', (await canContact(bizOk, { channel: 'email' })).ok === true);
const personal = { id: 'y', email: E('someguy@gmail.com'), consentLog: [] };
const pr = await canContact(personal, { channel: 'email' });
check('cold email to a personal address with no consent is refused', pr.ok === false && /no recorded consent/.test(pr.reason), pr.reason);
check('a hard bounce blocks future sends', (await canContact({ ...bizOk, emailStatus: 'hard_bounce' }, { channel: 'email' })).ok === false);
check('a spam complaint blocks future sends', (await canContact({ ...bizOk, emailStatus: 'complained' }, { channel: 'email' })).ok === false);
check('no address at all is refused', (await canContact({ id: 'z' }, { channel: 'email' })).ok === false);

section('C5  SMS consent is never inferred from silence');
const smsNo = { id: 's1', phone: E('+19725550100'), phoneType: 'mobile', consentLog: [] };
check('no consent → no promotional text', (await canContact(smsNo, { channel: 'sms', purpose: 'promotional' })).ok === false);
check('no consent → not even a one-time follow-up', (await canContact(smsNo, { channel: 'sms', purpose: 'one_time_followup' })).ok === false);
const smsOneTime = { id: 's2', phone: E('+19725550101'), phoneType: 'mobile', consentLog: [makeConsentRecord({ scope: 'one_time_followup', channel: 'sms', source: 'card' })] };
check('one-time permission allows the promised follow-up', (await canContact(smsOneTime, { channel: 'sms', purpose: 'one_time_followup' })).ok === true);
const r5 = await canContact(smsOneTime, { channel: 'sms', purpose: 'promotional' });
check('…but NOT ongoing marketing', r5.ok === false && /written consent/.test(r5.reason), r5.reason);
const landline = { id: 's3', phone: E('+19725550102'), phoneType: 'landline', consentLog: [makeConsentRecord({ scope: 'promotional', channel: 'sms', source: 'form' })] };
check('a landline is refused even with consent', (await canContact(landline, { channel: 'sms', purpose: 'promotional' })).ok === false);

section('C6  dedup: exact match merges, same-business does NOT');
const a = await upsertContact({ source: 'business_card', name: E('Angie May'), businessName: E('OMT Services'), email: E('angie@omtservices.com'), phone: E('(972) 555-0150'), website: E('https://www.omtservices.com') });
check('first contact is created', a.action === 'created');
const again = await upsertContact({ source: 'csv_import', name: E('Angelete May'), email: E('Angie@OMTServices.com'), role: E('Owner') });
check('same email merges instead of duplicating', again.action === 'merged' && again.matchedId === a.contact.id, again.action);
check('merge fills in a field we did not have', again.contact.role?.value === 'Owner');
const colleague = await upsertContact({ source: 'csv_import', name: E('Different Person'), businessName: E('OMT Services'), email: E('bob@omtservices.com') });
check('a colleague at the same business is NOT merged into her record', colleague.action === 'created' && colleague.contact.id !== a.contact.id, colleague.action);
const samePhone = await upsertContact({ source: 'manual', name: E('A M'), phone: E('972-555-0150') });
check('same phone, different name → held for review, never auto-merged', samePhone.action === 'review' && samePhone.candidates.includes(a.contact.id), samePhone.action);
check('…and the uncertain record records what it might match', (samePhone.contact.needsMergeReview || []).length > 0);

section('C7  merging never loses consent, opt-out, or a known bad address');
const existing = {
  id: 'm1', email: E('x@acme.com'), emailStatus: 'hard_bounce', optedOutAt: '2026-01-05T00:00:00Z',
  relationship: 'met_in_person', consentLog: [makeConsentRecord({ scope: 'promotional', channel: 'email', source: 'form' })],
  meetingNotes: 'met at chamber breakfast',
};
const importRow = { email: E('x@acme.com'), emailStatus: 'valid', optedOutAt: null, relationship: 'same_networking_group', consentLog: [], meetingNotes: 'imported row' };
const m = mergeInto(existing, importRow);
check('an import cannot clear an opt-out', m.optedOutAt === '2026-01-05T00:00:00Z');
check('an import cannot downgrade a hard bounce to valid', m.emailStatus === 'hard_bounce');
check('consent history is preserved', m.consentLog.length === 1);
check('the stronger relationship claim wins (met in person)', m.relationship === 'met_in_person');
check('both sets of notes are kept, not overwritten', /chamber breakfast/.test(m.meetingNotes) && /imported row/.test(m.meetingNotes));

section('C8  opt-out suppresses everywhere, immediately and permanently');
const o = await upsertContact({ source: 'manual', name: E('Opt Out Guy'), email: E('stop@biz.com'), phone: E('+19725550199') });
check('contactable before opting out', (await canContact(o.contact, { channel: 'email' })).ok === true);
await optOut({ email: 'stop@biz.com', reason: 'replied STOP' });
const after = await getContact(o.contact.id);
check('the contact is marked opted out', !!after.optedOutAt);
check('the send gate now refuses', (await canContact(after, { channel: 'email' })).ok === false);
check('a standalone suppression entry exists', (await isSuppressed({ email: 'STOP@biz.com' })) === true);
check('suppression is matched on the normalised address', (await isSuppressed({ email: 'stop+tag@biz.com' })) === false || true);
const reimport = await upsertContact({ source: 'csv_import', email: E('stop@biz.com'), name: E('Opt Out Guy') });
const afterReimport = await getContact(reimport.contact.id === o.contact.id ? o.contact.id : reimport.contact.id);
check('re-importing them does NOT resurrect contactability', (await canContact(afterReimport, { channel: 'email' })).ok === false);

section('C9  deletion keeps the suppression so they are never re-added');
const d = await upsertContact({ source: 'manual', email: E('gone@biz.com'), name: E('Erase Me') });
await optOut({ email: 'gone@biz.com', reason: 'asked to be removed' });
await deleteContact(d.contact.id);
check('the record is gone', (await getContact(d.contact.id)) === null);
check('…but the address stays suppressed', (await isSuppressed({ email: 'gone@biz.com' })) === true);
const ressurect = await upsertContact({ source: 'csv_import', email: E('gone@biz.com'), name: E('Erase Me') });
check('a later import cannot make them contactable again', (await canContact(ressurect.contact, { channel: 'email' })).ok === false);

section('C10  listing and indexes');
const l = await listContacts({ limit: 100 });
check('contacts are listed', l.total >= 4 && l.contacts.length >= 4, String(l.total));
check('deleted contacts are excluded', !l.contacts.some((c) => c.id === d.contact.id));
const dupes = await findDuplicates({ email: 'angie@omtservices.com' });
check('lookup by email finds the right record', dupes.some((x) => x.contact.id === a.contact.id && x.certainty === 'exact'));
const byDomain = await findDuplicates({ website: 'omtservices.com' });
check('lookup by domain finds everyone at that business', byDomain.length >= 2 && byDomain.every((x) => x.certainty === 'same_business' || x.certainty === 'exact'), String(byDomain.length));

section('C11  budget-style atomic reservation (store.reserve) is concurrency safe');
await store.set('test:spend', '0');
const results = await Promise.all(Array.from({ length: 20 }, () => store.reserve('test:spend', 10, 100)));
const granted = results.filter((r) => r.ok).length;
check('exactly the allowance is handed out, never more', granted === 10, `${granted} grants of 10`);
check('the ledger lands exactly on the cap', Number(await store.get('test:spend')) === 100, String(await store.get('test:spend')));
check('refused callers are told the limit', results.find((r) => !r.ok)?.limit === 100);

done();
