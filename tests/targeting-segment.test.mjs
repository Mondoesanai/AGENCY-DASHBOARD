// A Facebook page is not a website, and an enquiry is not a lead.
//
// R19.5. Proactive outreach is for established businesses that already have a
// verified website of their own. Two failures are being prevented, and they
// pull in opposite directions:
//
//   · Calling a listing link a verified website. A Yelp or Facebook page loads
//     and names the business, so the existing check calls it present. Opening
//     a cold email with "I had a look at your site" is then false in the first
//     sentence, about a business we have never spoken to.
//
//   · Refusing to help somebody because they have no website. A person without
//     one who ASKS us is exactly who the service is for. They are served; they
//     are simply not in the outbound segment, because we did not find them.
//
// The negative control throughout is a genuine own-site business, which must
// stay approachable — otherwise every check here would pass by refusing
// everybody.

import { check, section, done } from './world.mjs';
import {
  isListingUrl, websiteEvidence, WEBSITE_EVIDENCE, EVIDENCE_WORDING,
  segmentFor, SEGMENT, mayApproach, establishedSignals, LISTING_HOSTS,
} from '../lib/targeting.js';
import { WEB_STATUS } from '../lib/discovery.js';

const established = {
  name: 'Hale Flooring', phone: '+15557770001', address: '12 Mill Street', openingHours: 'Mo-Fr 08:00-17:00',
};
const verifiedOwnSite = {
  status: WEB_STATUS.PRESENT, attempted: 'https://haleflooring.example',
  signals: ['business name', 'town name'], observation: 'the site loads and matches this business',
};

// ---------------------------------------------------------------------------
section('T1  a profile on somebody else\'s platform is recognised');
for (const url of [
  'https://www.facebook.com/haleflooring',
  'https://m.facebook.com/haleflooring',
  'https://www.yelp.com/biz/hale-flooring',
  'https://linktr.ee/haleflooring',
  'https://haleflooring.business.site',
  'https://sites.google.com/view/haleflooring',
  'https://www.instagram.com/haleflooring',
  'https://haleflooring.wixsite.com/home',
]) {
  const r = isListingUrl(url);
  check(`${new URL(url).hostname} is a listing`, r.listing === true, JSON.stringify(r));
}
check('a real domain is NOT a listing', isListingUrl('https://haleflooring.example').listing === false);
check('nor is one that merely contains a platform name',
  isListingUrl('https://facebookmarketingpros.example').listing === false,
  'matching on substring would exclude real businesses whose domain mentions a platform');
check('an unreadable URL is not silently treated as a real site',
  isListingUrl('not a url').known === false);
check('the list is a real list', LISTING_HOSTS.length > 20);

section('T2  PRESENT alone is not a verified website');
const profile = websiteEvidence({ ...verifiedOwnSite, attempted: 'https://www.facebook.com/haleflooring' });
check('a loading, matching Facebook page is NOT verified', profile.verified === false,
  'this is the mislabel the module exists to prevent');
check('it is classified as a listing profile', profile.kind === WEBSITE_EVIDENCE.LISTING_PROFILE);
check('the platform is named', profile.platform === 'facebook.com', profile.platform);
check('and the reason says why it is different',
  /somebody else's platform|not this business's own/i.test(profile.why), profile.why);

section('T2b  NEGATIVE CONTROL: a real own site IS verified');
const own = websiteEvidence(verifiedOwnSite);
check('an own domain that loads and matches is verified', own.verified === true, JSON.stringify(own));
check('classified as their own site', own.kind === WEBSITE_EVIDENCE.OWN_SITE);
check('carrying the URL', own.url === 'https://haleflooring.example');

section('T2c  the other outcomes stay distinct');
const notLinked = websiteEvidence({ status: WEB_STATUS.NOT_LINKED });
check('no website linked is its own answer', notLinked.kind === WEBSITE_EVIDENCE.NONE_FOUND);
check('and is NOT stated as "they have no website"',
  /NOT evidence/i.test(notLinked.why), notLinked.why);
check('a site that would not load is not verified',
  websiteEvidence({ status: WEB_STATUS.INACCESSIBLE, attempted: 'https://x.example' }).verified === false);
check('a site that loads but matches nothing is not verified',
  websiteEvidence({ status: WEB_STATUS.UNCERTAIN, attempted: 'https://x.example' }).verified === false);
check('never checked is not verified', websiteEvidence(null).verified === false);
check('never checked is distinguishable from checked-and-absent',
  websiteEvidence(null).kind !== notLinked.kind,
  '"we did not look" and "we looked and found nothing" are different facts');
for (const k of Object.values(WEBSITE_EVIDENCE)) {
  check(`"${k}" has wording a person could read`, !!EVIDENCE_WORDING[k] && EVIDENCE_WORDING[k].length > 10);
}

// ---------------------------------------------------------------------------
section('T3  the outbound segment');
const good = segmentFor(established, { verification: verifiedOwnSite });
check('an established business with its own site is in the outbound segment',
  good.segment === SEGMENT.OUTBOUND_ESTABLISHED, JSON.stringify(good).slice(0, 220));
check('and may be approached', good.mayOutbound === true);
check('the premise is stated, so the copy can be checked against it',
  /improving what exists/i.test(good.premise), good.premise);
check('and the premise names the actual URL', good.premise.includes('haleflooring.example'));

const onlyProfile = segmentFor(established, { verification: { ...verifiedOwnSite, attempted: 'https://www.facebook.com/haleflooring' } });
check('the same business with only a Facebook page is NOT in it',
  onlyProfile.segment === SEGMENT.NOT_OUTBOUND, JSON.stringify(onlyProfile).slice(0, 200));
check('but may still be served', onlyProfile.mayServe === true,
  'not approachable is not the same as not wanted');
check('and the refusal explains it in words',
  /profile on another platform/i.test(onlyProfile.why), onlyProfile.why);

section('T3b  too little evidence of being established');
const bare = segmentFor({ name: 'Someone' }, { verification: verifiedOwnSite });
check('a name and a website alone is not enough', bare.segment === SEGMENT.NOT_OUTBOUND, JSON.stringify(bare).slice(0, 200));
check('and it says what was missing', /too little/i.test(bare.why), bare.why);

// The subtle one, and the reason this section exists: the website is ALREADY a
// requirement of the segment. If it also counted towards "established", a bare
// name plus a site would satisfy both from one piece of evidence, and
// "established" would mean nothing.
const signals = establishedSignals(established);
check('a real listing produces several signals', signals.length >= 3, signals.join(', '));
check('each one is something the website did not supply',
  signals.every((s) => /phone|address|hours/i.test(s)) && !signals.some((s) => /website|site/i.test(s)),
  signals.join(', '));
check('a prospect with a verified site but nothing else scores zero',
  establishedSignals({ name: 'Someone' }).length === 0,
  'the website must not be able to vouch for the business being established');
const onlyPhone = segmentFor({ name: 'Someone', phone: '+15557770001' }, { verification: verifiedOwnSite });
check('one signal is still not enough', onlyPhone.segment === SEGMENT.NOT_OUTBOUND, onlyPhone.why);
const twoSignals = segmentFor({ name: 'Someone', phone: '+15557770001', address: '12 Mill Street' }, { verification: verifiedOwnSite });
check('NEGATIVE CONTROL: two independent signals DO qualify',
  twoSignals.segment === SEGMENT.OUTBOUND_ESTABLISHED, twoSignals.why);

section('T4  an inbound enquiry is never outbound');
const inboundNoSite = segmentFor({ name: 'New Bakery' }, { verification: { status: WEB_STATUS.NOT_LINKED }, inbound: true });
check('somebody who asked us is in the inbound segment', inboundNoSite.segment === SEGMENT.INBOUND_REQUEST);
check('they may be served', inboundNoSite.mayServe === true,
  'a person without a website who asks for help is exactly who this is for');
check('but never cold-contacted', inboundNoSite.mayOutbound === false);
check('and the reason says they came to us', /came to us/i.test(inboundNoSite.why), inboundNoSite.why);

// The one that is easy to get wrong in the other direction.
const inboundWithSite = segmentFor(established, { verification: verifiedOwnSite, inbound: true });
check('an inbound person WITH a verified site is still not outbound',
  inboundWithSite.segment === SEGMENT.INBOUND_REQUEST && inboundWithSite.mayOutbound === false,
  'otherwise answering an enquiry quietly enrols them in a cold campaign');

// ---------------------------------------------------------------------------
section('T5  the send gate actually asks');
const { maySend } = await import('../lib/outreach-email.js');
const { upsertContact, field } = await import('../lib/contacts.js');

const grant = () => [{ at: Date.now() - 1000, channel: 'email', kind: 'granted', basis: 'asked us', scope: 'promotional' }];

const profileContact = {
  id: 'seg_profile', email: { value: 'hi@haleflooring.example' }, name: { value: 'Hale' },
  consentLog: grant(),
  websiteCheck: { status: WEB_STATUS.PRESENT, attempted: 'https://www.facebook.com/haleflooring', signals: ['business name'] },
  phone: '+15557770001', address: '12 Mill Street', openingHours: 'Mo-Fr',
};
const gateProfile = await maySend({ contact: profileContact, campaignId: 'seg1', purpose: 'promotional' });
check('a cold send to a profile-only business is refused', gateProfile.ok === false, JSON.stringify(gateProfile).slice(0, 200));
check('with the segment named', gateProfile.code === 'not-in-outbound-segment', gateProfile.code);

const inboundContact = { ...profileContact, id: 'seg_inbound', source: 'preview_request',
  websiteCheck: { status: WEB_STATUS.PRESENT, attempted: 'https://haleflooring.example', signals: ['business name', 'town'] } };
const gateInbound = await maySend({ contact: inboundContact, campaignId: 'seg1', purpose: 'promotional' });
check('a cold send to somebody who came to us is refused', gateInbound.ok === false, JSON.stringify(gateInbound).slice(0, 200));
check('and names the inbound segment', gateInbound.segment === SEGMENT.INBOUND_REQUEST, String(gateInbound.segment));

section('T5b  NEGATIVE CONTROL: the segment gate is not what blocks everything');
const okContact = { ...profileContact, id: 'seg_ok',
  websiteCheck: { status: WEB_STATUS.PRESENT, attempted: 'https://haleflooring.example', signals: ['business name', 'town'] } };
const gateOk = await maySend({ contact: okContact, campaignId: 'seg1', purpose: 'promotional' });
check('a genuine outbound prospect passes the SEGMENT check', gateOk.code !== 'not-in-outbound-segment',
  `${gateOk.code}: ${String(gateOk.reason).slice(0, 120)}`);
check('and is then stopped by the release hold instead', gateOk.ok === false && gateOk.code === 'not-ready',
  'outreach is off and no cold sender is connected — which is the correct reason to refuse today');

section('T5c  the segment gate is for OUTREACH, not for replies');
const reply = await maySend({ contact: inboundContact, campaignId: 'seg1', purpose: 'reply' });
check('answering somebody is not blocked by the outbound segment',
  reply.code !== 'not-in-outbound-segment', `${reply.code}: ${String(reply.reason).slice(0, 120)}`);

// ---------------------------------------------------------------------------
section('T5d  a REAL discovered prospect survives enrolment and reaches the gate');
// The check that catches the failure mode this gate is most likely to have:
// blocking everybody. The evidence has to travel from the OSM listing, through
// verification, through enrolment, onto the contact — and every hop drops
// whatever it does not name. Two of them were dropping it.
const { saveProspect } = await import('../lib/discovery.js').then(async (m) => ({
  saveProspect: m.saveProspect || null,
})).catch(() => ({ saveProspect: null }));

const { upsertContact: upsert, field: fld, getContact } = await import('../lib/contacts.js');
const enrolled = await upsert({
  source: 'discovery',
  name: fld('Dana Kim', { confidence: 0.9, source: 'discovery' }),
  businessName: fld('Hale Flooring', { confidence: 0.9, source: 'discovery' }),
  email: fld('dana@haleflooring.example', { confidence: 0.9, source: 'discovery' }),
  phone: fld('+15557770001', { confidence: 0.9, source: 'discovery' }),
  website: fld('https://haleflooring.example', { confidence: 0.9, source: 'discovery' }),
  address: fld('12 Mill Street, Springfield', { confidence: 0.9, source: 'discovery' }),
  websiteCheck: verifiedOwnSite,
});
const stored = await getContact(enrolled.contact.id);
check('the website evidence survived being stored', !!stored.websiteCheck,
  'upsertContact builds the record explicitly — an unnamed field is silently dropped');
check('and it is the verification, not just the URL',
  stored.websiteCheck.status === WEB_STATUS.PRESENT && !!stored.websiteCheck.attempted);
check('the address survived too', !!stored.address?.value, JSON.stringify(stored.address));

const realGate = mayApproach(stored, { verification: stored.websiteCheck });
check('a real discovered prospect IS approachable', realGate.ok === true,
  `${realGate.reason} — a gate that refuses everybody is an outage, not a gate`);
check('with two independent established signals',
  establishedSignals(stored).length >= 2, establishedSignals(stored).join(', '));

section('T5e  a newer check can take someone OUT of the segment');
const moved = await upsert({
  id: enrolled.contact.id,
  source: 'discovery',
  email: fld('dana@haleflooring.example', { confidence: 0.9, source: 'discovery' }),
  websiteCheck: { ...verifiedOwnSite, attempted: 'https://www.facebook.com/haleflooring', checkedAt: Date.now() + 60000 },
});
const after = await getContact(moved.contact.id);
check('the newer check wins', /facebook/.test(after.websiteCheck.attempted), after.websiteCheck.attempted);
check('and they are no longer approachable',
  mayApproach(after, { verification: after.websiteCheck }).ok === false,
  'keeping the older, more flattering verification would make the premise permanent');

// ---------------------------------------------------------------------------
section('T6  mayApproach fails closed');
check('no verification at all is a refusal', mayApproach(established, {}).ok === false);
check('and says a verified website is the requirement',
  /verified website/i.test(mayApproach(established, {}).reason), mayApproach(established, {}).reason);
check('NEGATIVE CONTROL: full evidence is allowed',
  mayApproach(established, { verification: verifiedOwnSite }).ok === true);

done();
