// R6.10 — no fabricated engagement, no domain rotation, no filter evasion.
//
// These are not accidents a build stumbles into. They are the standard
// growth-hack playbook for cold email, each one a deliberate choice, and each
// one the first thing a future "improve deliverability" change would reach
// for. So each is written down with its reason and given a check that fails.
import { check, section, done } from './world.mjs';
import {
  PROHIBITED, findEvasion, findRedirectChains, checkSendingDomains,
  acceptEngagement, checkOutgoing, ENGAGEMENT_SOURCE,
} from '../lib/integrity.js';

// ---------------------------------------------------------------------------
section('I1  the three prohibitions are written down with reasons');
check('all three are recorded', PROHIBITED.length === 3, String(PROHIBITED.length));
for (const p of PROHIBITED) {
  check(`${p.id} states the rule`, p.rule.length > 25, p.rule);
  check(`${p.id} states why, not just what`, p.why.length > 40, p.why);
}
check('fabricated engagement is one of them', PROHIBITED.some((p) => p.id === 'fabricated-engagement'));
check('domain rotation is one of them', PROHIBITED.some((p) => p.id === 'domain-rotation'));
check('filter evasion is one of them', PROHIBITED.some((p) => p.id === 'filter-evasion'));

// ---------------------------------------------------------------------------
section('I2  filter evasion in our own copy is caught');
const clean = 'I was looking up Lone Star Flooring and could not find a website linked from your listing.';
check('ordinary copy is clean', findEvasion(clean).length === 0, JSON.stringify(findEvasion(clean)));

// zero-width characters: invisible, and only useful for breaking up words
const zw = `Totally fre​e website review`;
let f = findEvasion(zw);
check('invisible characters are found', f.some((x) => x.kind === 'zero-width'), JSON.stringify(f));
check('and counted', f.find((x) => x.kind === 'zero-width')?.count === 1);
check('the reason is stated', /break up words a filter looks for/.test(f.find((x) => x.kind === 'zero-width')?.text || ''));
check('a soft hyphen counts too', findEvasion('fr­ee').some((x) => x.kind === 'zero-width'));

// homoglyphs: a Cyrillic letter that looks Latin
f = findEvasion('Get it for frеe today');
check('a lookalike letter from another alphabet is found', f.some((x) => x.kind === 'homoglyph'), JSON.stringify(f));
check('and the offending character is named', /е/.test(f.find((x) => x.kind === 'homoglyph')?.text || ''));
check('a Greek lookalike is caught as well', findEvasion('οffer').some((x) => x.kind === 'homoglyph'));
check('ordinary accented text is not mistaken for it', findEvasion('Café André').length === 0, JSON.stringify(findEvasion('Café André')));

// words chopped with punctuation
check('f.r.e.e is caught', findEvasion('f.r.e.e website').some((x) => x.kind === 'chopped-word'));
check('a normal sentence with full stops is not', findEvasion('Hello. This is a normal sentence. Thanks.').length === 0);

// hidden text and image-only bodies
f = findEvasion('hello', { html: '<div style="display:none">keywords for the filter</div><p>hello</p>' });
check('hidden text is found', f.some((x) => x.kind === 'hidden-text'), JSON.stringify(f));
check('and says what it is for', /hides text from the reader/.test(f.find((x) => x.kind === 'hidden-text')?.text || ''));
check('font-size:0 is the same trick', findEvasion('x', { html: '<span style="font-size:0">hidden</span>' }).some((x) => x.kind === 'hidden-text'));
f = findEvasion('', { html: '<img src="whole-message.png" />' });
check('an image-only body is found', f.some((x) => x.kind === 'image-only'), JSON.stringify(f));
check('and says who else it hurts', /anyone who blocks images/.test(f.find((x) => x.kind === 'image-only')?.text || ''));
check('an image alongside real text is fine', findEvasion('x', { html: '<p>Here is a genuinely long paragraph of readable text for them.</p><img src="a.png" />' }).length === 0);

// ---------------------------------------------------------------------------
section('I3  a link must show where it goes');
check('a plain link is fine', findRedirectChains('see https://inspiringwebsites.org/preview/acme').length === 0);
let r = findRedirectChains('click https://bit.ly/3xYz');
check('a shortener is found', r.some((x) => x.kind === 'shortener'), JSON.stringify(r));
check('and the reason names the recipient', /neither the recipient nor a filter can see the destination/.test(r[0]?.text || ''));
r = findRedirectChains('go https://track.example.com/r?u=https%3A%2F%2Fsomewhere.else');
check('a URL carrying another URL is found', r.some((x) => x.kind === 'nested-redirect'), JSON.stringify(r));
check('and it says the destination is disguised', /disguises where the link actually goes/.test(r[0]?.text || ''));
r = findRedirectChains('see https://elsewhere.test/x', { allowedHosts: ['inspiringwebsites.org'] });
check('a host we do not send links to is flagged when a list is given', r.some((x) => x.kind === 'unexpected-host'));
check('and a subdomain of an allowed host is accepted',
  findRedirectChains('see https://preview.inspiringwebsites.org/x', { allowedHosts: ['inspiringwebsites.org'] }).length === 0);

// ---------------------------------------------------------------------------
section('I4  one sending domain, and no pool');
let d = checkSendingDomains({ OUTREACH_FROM_DOMAIN: 'outreach.inspiringwebsites.org' });
check('one domain is fine', d.ok === true && d.domain === 'outreach.inspiringwebsites.org', JSON.stringify(d));
d = checkSendingDomains({ OUTREACH_FROM_DOMAIN: 'a.test, b.test' });
check('two domains are refused', d.ok === false && d.problems.some((p) => p.kind === 'domain-rotation'), JSON.stringify(d));
check('and the refusal says why rotation is the problem', /outrun a reputation you earned/.test(d.problems[0]?.text || ''));
check('space-separated is the same thing', checkSendingDomains({ OUTREACH_FROM_DOMAIN: 'a.test b.test' }).ok === false);
d = checkSendingDomains({ OUTREACH_FROM_DOMAIN: 'a.test', OUTREACH_FROM_DOMAIN_2: 'b.test', OUTREACH_FROM_DOMAIN_3: 'c.test' });
check('a numbered pool is refused', d.problems.some((p) => p.kind === 'domain-pool'), JSON.stringify(d));
check('and names the pool variables', /OUTREACH_FROM_DOMAIN_2/.test(d.problems.find((p) => p.kind === 'domain-pool')?.text || ''));
check('no domain at all is not rotation', checkSendingDomains({}).ok === true);

// ---------------------------------------------------------------------------
section('I5  engagement may only come from evidence');
let e = acceptEngagement({ kind: 'open', source: ENGAGEMENT_SOURCE.PROVIDER_EVENT, evidence: { id: 'evt_1' } });
check('a provider event with its evidence is accepted', e.ok === true, JSON.stringify(e));
check('a provider event with NO evidence is refused', acceptEngagement({ kind: 'open', source: ENGAGEMENT_SOURCE.PROVIDER_EVENT }).ok === false);
check('an owner-recorded fact is accepted', acceptEngagement({ kind: 'reply', source: ENGAGEMENT_SOURCE.OWNER_RECORDED }).ok === true);
// the ones that matter
e = acceptEngagement({ kind: 'open', source: 'inferred' });
check('an inferred open is refused', e.ok === false, JSON.stringify(e));
check('and the refusal says it is not evidence', /is not evidence that anyone did anything/.test(e.reason));
check('a simulated open is refused', acceptEngagement({ kind: 'open', source: 'simulated' }).ok === false);
check('a warm-up open is refused', acceptEngagement({ kind: 'open', source: 'warmup' }).ok === false);
check('no source at all is refused', acceptEngagement({ kind: 'open' }).ok === false);
check('and says so rather than defaulting', /"nothing" is not evidence/.test(acceptEngagement({ kind: 'open' }).reason));
check('only two sources exist', Object.keys(ENGAGEMENT_SOURCE).length === 2, Object.keys(ENGAGEMENT_SOURCE).join(','));

// ---------------------------------------------------------------------------
section('I6  the whole gate, as the send path runs it');
let g = checkOutgoing({ text: clean, env: { OUTREACH_FROM_DOMAIN: 'o.test' } });
check('an honest message passes', g.ok === true, JSON.stringify(g.findings));
g = checkOutgoing({ text: `fre​e review`, env: { OUTREACH_FROM_DOMAIN: 'o.test' } });
check('an evasive one does not', g.ok === false && g.findings.some((x) => x.kind === 'zero-width'));
g = checkOutgoing({ text: clean, env: { OUTREACH_FROM_DOMAIN: 'a.test,b.test' } });
check('rotation alone blocks the send', g.ok === false && g.findings.some((x) => x.kind === 'domain-rotation'));
g = checkOutgoing({ text: 'see https://bit.ly/x', env: { OUTREACH_FROM_DOMAIN: 'o.test' } });
check('a disguised link blocks the send', g.ok === false && g.findings.some((x) => x.kind === 'shortener'));

// ---------------------------------------------------------------------------
section('I7  the real send path refuses, rather than the module merely offering to');
{
  const { sendProspectEmail, sendReadiness } = await import('../lib/outreach-email.js');
  const { upsertContact, field } = await import('../lib/contacts.js');
  const { saveSettings, saveSender } = await import('../lib/settings.js');
  const { store } = await import('../lib/store.js');

  await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { status: 'confirmed' } });
  await saveSender({ name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' });
  const rawS = JSON.parse(await store.get('settings:business'));
  await store.set('settings:business', JSON.stringify({ ...rawS, outreach: { ...rawS.outreach, active: true } }));

  const ADDR = 'integrity@lonestarflooring.test';
  await store.set(`suppress:email:${ADDR}`, '').catch(() => {});
  const c = (await upsertContact({ source: 'discovery', name: field('Integrity Test'), email: field(ADDR) })).contact;
  const env = {
    INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test',
    PUBLIC_BASE_URL: 'https://dash.test', UNSUBSCRIBE_SECRET: 's',
  };

  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'x' }), headers: { get: () => null } }; };

  // a message with an invisible character must not reach the provider
  let out = await sendProspectEmail({
    contact: c, campaignId: 'camp-int-1',
    message: { subject: 'A fre​e review', body: 'hello' },
    env, fetchImpl,
  });
  check('an evasive message is refused', out.sent === false && out.code === 'integrity', JSON.stringify(out).slice(0, 180));
  check('the provider was never called', called === 0, String(called));
  check('and the refusal names what was wrong', /invisible character/.test(out.reason), out.reason);

  // a disguised link, same
  out = await sendProspectEmail({
    contact: c, campaignId: 'camp-int-2',
    message: { subject: 'Hello', body: 'see https://bit.ly/abc' },
    env, fetchImpl,
  });
  check('a shortened link is refused', out.sent === false && out.code === 'integrity', JSON.stringify(out).slice(0, 160));
  check('still nothing sent', called === 0, String(called));

  // rotation configured, honest message — still refused
  out = await sendProspectEmail({
    contact: c, campaignId: 'camp-int-3',
    message: { subject: 'Hello', body: clean },
    env: { ...env, OUTREACH_FROM_DOMAIN: 'a.test,b.test' }, fetchImpl,
  });
  // Refused at the EARLIER gate: rotation is a readiness blocker, so maySend
  // stops it before the message is even looked at. Two gates catch it; the one
  // that matters is that nothing goes out.
  check('a rotation pool is refused even with honest copy', out.sent === false, JSON.stringify(out).slice(0, 160));
  check('and the reason names the rotation', /prospecting domains are configured/.test(out.reason || ''), out.reason);
  check('it is stopped before the message is even examined', out.code === 'not-ready', out.code);

  // and an honest message on one domain does go
  out = await sendProspectEmail({
    contact: c, campaignId: 'camp-int-4',
    message: { subject: 'Hello', body: clean },
    env, fetchImpl,
  });
  check('an honest message on one domain is sent', out.sent === true, JSON.stringify(out).slice(0, 160));
  check('and the provider was called exactly once', called === 1, String(called));

  // the readiness list surfaces rotation too
  const rd = await sendReadiness({ env: { ...env, OUTREACH_FROM_DOMAIN: 'a.test,b.test' } });
  check('rotation appears in the readiness blockers', rd.blockers.some((b) => b.code === 'domain-rotation'), rd.blockers.map((b) => b.code).join(','));
  await store.set(`suppress:email:${ADDR}`, '').catch(() => {});
}

done();
