// R6.9 — accurate identity, a real postal address, and an unsubscribe that works.
//
// The messages already carried a real name, business and postal address, and a
// "reply with STOP" line that is genuinely wired. Two things were missing, and
// the second one is not optional any more:
//
//   * asking someone to compose an email to stop hearing from you is the
//     highest-friction mechanism there is, and friction becomes spam complaints;
//   * since February 2024 Gmail and Yahoo require bulk senders to supply
//     List-Unsubscribe and List-Unsubscribe-Post (RFC 8058). Without them cold
//     mail is filtered whatever the body says.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  normAddress, makeToken, verifyToken, unsubscribeUrl, unsubscribeHeaders,
  unsubscribeLine, handleUnsubscribe, isSuppressed, confirmPage, RESULT,
} from '../lib/unsubscribe.js';
import { identityProblems } from '../lib/settings.js';
import { unsubscribeFor } from '../lib/campaigns.js';

const ENV = { UNSUBSCRIBE_SECRET: 'test-unsub-secret', PUBLIC_BASE_URL: 'https://dash.test' };
const ADDR = 'pat@lonestarflooring.test';

// ---------------------------------------------------------------------------
section('U1  the link is tied to one address and cannot be edited into another');
const token = makeToken(ADDR, ENV);
check('a token is produced', !!token && token.length === 32, String(token));
check('it verifies for its own address', verifyToken(ADDR, token, ENV) === true);
// the one that matters: this is what stops one person unsubscribing another
check('it does NOT verify for a different address', verifyToken('someone@else.test', token, ENV) === false);
check('case and spacing do not change the address', verifyToken('  PAT@LoneStarFlooring.TEST ', token, ENV) === true);
check('a tampered token is refused', verifyToken(ADDR, token.slice(0, -1) + 'x', ENV) === false);
check('a truncated token is refused rather than compared loosely', verifyToken(ADDR, token.slice(0, 10), ENV) === false);
check('an empty token is refused', verifyToken(ADDR, '', ENV) === false);
check('with no secret configured, no token is issued', makeToken(ADDR, {}) === null);
check('a different secret produces a different token', makeToken(ADDR, { UNSUBSCRIBE_SECRET: 'other' }) !== token);
check('the secret falls back to CRON_SECRET so it works on a plain deployment', !!makeToken(ADDR, { CRON_SECRET: 'c' }));
check('addresses are normalised consistently', normAddress('  A@B.TEST ') === 'a@b.test');

// ---------------------------------------------------------------------------
section('U2  the headers Gmail and Yahoo require');
const h = unsubscribeHeaders(ADDR, { env: ENV, replyTo: 'mondo@inspiring.test' });
check('List-Unsubscribe is present', !!h['List-Unsubscribe'], JSON.stringify(h));
check('it carries an https link', /<https:\/\/dash\.test\/api\/collect\?unsub=1/.test(h['List-Unsubscribe']), h['List-Unsubscribe']);
check('and a mailto as the second option', /<mailto:mondo@inspiring\.test\?subject=unsubscribe>/.test(h['List-Unsubscribe']));
check('one-click is declared', h['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', h['List-Unsubscribe-Post']);
check('the link carries the address and its token', /e=pat%40lonestarflooring\.test/.test(h['List-Unsubscribe']) && /t=/.test(h['List-Unsubscribe']));
// one-click is meaningless without a URL to post to
const mailOnly = unsubscribeHeaders(ADDR, { env: {}, replyTo: 'm@i.test' });
check('with no public URL there is still a mailto option', /mailto:/.test(mailOnly['List-Unsubscribe']));
check('but one-click is NOT claimed', !mailOnly['List-Unsubscribe-Post'], JSON.stringify(mailOnly));
check('with nothing at all, no headers are invented', Object.keys(unsubscribeHeaders(ADDR, { env: {} })).length === 0);

// ---------------------------------------------------------------------------
section('U3  the body gets a link, or honest words when it cannot');
let line = unsubscribeLine(ADDR, { env: ENV });
check('the line contains a real link', /https:\/\/dash\.test\/api\/collect\?unsub=1/.test(line), line);
check('and still offers the reply route', /reply with STOP/i.test(line));
line = unsubscribeLine(ADDR, { env: {} });
check('with no link possible it falls back to the STOP wording', /reply with STOP/i.test(line) && !/http/.test(line), line);

// composeCold's helper: a preview has no recipient, so no link can be signed
check('a prospect with an email gets a link', /https:\/\/dash\.test/.test(unsubscribeFor({ email: ADDR }, {}, ENV)));
check('a field-object email works too', /https:\/\/dash\.test/.test(unsubscribeFor({ email: { value: ADDR } }, {}, ENV)));
check('a prospect with no email gets the STOP wording, not a broken link',
  !/http/.test(unsubscribeFor({}, {}, ENV)), unsubscribeFor({}, {}, ENV));

// ---------------------------------------------------------------------------
section('U3b  and the composed message actually carries it');
// Testing the helper is not enough: the question is whether the real message
// body contains the link. A negative control that removed it from composeCold
// passed every other check in this file, which is the whole "built but not
// wired" failure in miniature.
{
  process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret';
  process.env.PUBLIC_BASE_URL = 'https://dash.test';
  const { composeCold } = await import('../lib/campaigns.js');
  const { saveSettings } = await import('../lib/settings.js');
  await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { status: 'confirmed' } });
  const owner = { name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' };
  const prospect = {
    name: 'Lone Star Flooring', email: ADDR, industry: 'flooring',
    web: { status: 'not-linked-in-listing', checkedAt: Date.now() },
  };
  const msg = await composeCold(prospect, { owner });
  check('a message is composed', msg.ok === true, JSON.stringify(msg).slice(0, 160));
  check('the body carries the sender name', msg.body.includes('Mondo Davis'));
  check('and the business', msg.body.includes('Inspiring Websites LLC'));
  check('and the real postal address', msg.body.includes('2201 Preston Rd'));
  // the one NC11 exposed
  check('and a working unsubscribe LINK, not just the STOP wording',
    /https:\/\/dash\.test\/api\/collect\?unsub=1/.test(msg.body), msg.body.slice(-240));
  check('the link is the one signed for THIS recipient',
    msg.body.includes(`t=${makeToken(ADDR, process.env)}`), msg.body.slice(-240));

  // a message with no recipient must not carry a broken or someone else's link
  const preview = await composeCold({ ...prospect, email: null }, { owner });
  check('a recipient-less preview carries no link', !/unsub=1/.test(preview.body), preview.body.slice(-160));
  check('but still tells them how to stop', /STOP/i.test(preview.body));
}

// ---------------------------------------------------------------------------
section('U3c  and the send puts them on the wire');
// Composing the headers is not the same as the provider receiving them. This
// drives the real send path with a fake provider and reads what was actually
// posted — a control that emptied the headers passed everything else.
{
  const { sendProspectEmail } = await import('../lib/outreach-email.js');
  const { upsertContact, field } = await import('../lib/contacts.js');
  const { saveSettings, saveSender } = await import('../lib/settings.js');
  const { store: st } = await import('../lib/store.js');
  await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { status: 'confirmed' } });
  await saveSender({ name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' });
  const rawS = JSON.parse(await st.get('settings:business'));
  await st.set('settings:business', JSON.stringify({ ...rawS, outreach: { ...rawS.outreach, active: true } }));

  const WIRE = 'wire@lonestarflooring.test';
  await st.set(`suppress:email:${WIRE}`, '').catch(() => {});
  const c = (await upsertContact({ source: 'discovery', name: field('Wire Test'), email: field(WIRE) })).contact;

  let posted = null;
  const envSend = { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test', ...ENV };
  const out2 = await sendProspectEmail({
    contact: c, campaignId: 'camp-wire', message: {}, env: envSend,
    fetchImpl: async (url, init) => {
      if (String(url).includes('/leads/bulk')) posted = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'prov-1' }), headers: { get: () => null } };
    },
  });
  check('the send goes through', out2.sent === true, JSON.stringify(out2));
  check('a lead payload was posted', !!posted, JSON.stringify(posted));
  const lead = posted?.leads?.[0] || {};
  check('it carries custom headers to the provider', !!lead.custom_headers, JSON.stringify(lead));
  check('including List-Unsubscribe', !!lead.custom_headers?.['List-Unsubscribe'], JSON.stringify(lead.custom_headers));
  check('and the one-click declaration Gmail requires',
    lead.custom_headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', JSON.stringify(lead.custom_headers));
  check('the link is signed for the recipient, not a shared one',
    String(lead.custom_headers?.['List-Unsubscribe']).includes(makeToken(WIRE, envSend)), lead.custom_headers?.['List-Unsubscribe']);
  check('and the link is also available to the message template',
    String(lead.custom_variables?.unsubscribe_url || '').includes('unsub=1'), JSON.stringify(lead.custom_variables));
}

// ---------------------------------------------------------------------------
section('U4  GET must never unsubscribe anyone');
// Mail clients and security scanners fetch links inside messages. If opening
// one were enough, a scanner would opt people out and nobody would know why.
const page = confirmPage({ address: ADDR, token, done: false });
check('the page names the address', page.includes(ADDR));
check('it asks for a POST', /method="POST"/.test(page));
check('with the token carried through', page.includes(token));
check('and says plainly that opening the page did nothing', /does not unsubscribe you on its own/.test(page));
check('it explains why that is deliberate', /mail scanners open links/.test(page));
check('the page is not indexable', /name="robots" content="noindex"/.test(page));
const hostile = confirmPage({ address: '<img src=x onerror=alert(1)>', token: 'x', done: false });
check('a hostile address is escaped', !/<img src=x/.test(hostile) && /&lt;img/.test(hostile));

// ---------------------------------------------------------------------------
section('U5  pressing the button really stops the mail');
await store.set(`suppress:email:${ADDR}`, '').catch(() => {});
check('not suppressed to begin with', (await isSuppressed(ADDR)) === false);

let out = await handleUnsubscribe({ address: ADDR, token: 'not-the-right-token', env: ENV });
check('a bad token changes nothing', out.ok === false && out.result === RESULT.BAD_TOKEN, JSON.stringify(out));
check('and the address is still sendable', (await isSuppressed(ADDR)) === false);

out = await handleUnsubscribe({ address: ADDR, token, env: ENV });
check('a valid token unsubscribes', out.ok === true && out.result === RESULT.DONE, JSON.stringify(out));
check('the address is suppressed', (await isSuppressed(ADDR)) === true);
check('and the person is told in plain words', /will not be emailed again/.test(out.message));

out = await handleUnsubscribe({ address: ADDR, token, env: ENV });
check('pressing it twice is not an error', out.ok === true && out.result === RESULT.ALREADY, JSON.stringify(out));
check('and says so rather than pretending it just happened', /already unsubscribed/i.test(out.message));

check('no address is refused', (await handleUnsubscribe({ address: '', token, env: ENV })).result === RESULT.NO_ADDRESS);
check('an unconfigured deployment says so instead of silently failing',
  (await handleUnsubscribe({ address: ADDR, token, env: {} })).result === RESULT.NOT_CONFIGURED);

// the send gate must actually honour it
{
  const { maySend } = await import('../lib/outreach-email.js');
  const { upsertContact, field } = await import('../lib/contacts.js');
  const c = (await upsertContact({ source: 'discovery', name: field('Pat'), email: field(ADDR) })).contact;
  const gate = await maySend({ contact: c, campaignId: 'any', env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test', ...ENV } });
  check('the send gate refuses an unsubscribed address', gate.ok === false, JSON.stringify(gate));
}

// an unreadable suppression list must fail CLOSED
{
  const realGet = store.get;
  store.get = async (k) => { if (String(k).startsWith('suppress:email:')) throw new Error('store down'); return realGet.call(store, k); };
  check('if the list cannot be read, treat the address as suppressed', (await isSuppressed('anyone@x.test')) === true);
  store.get = realGet;
}

// ---------------------------------------------------------------------------
section('U6  "accurate identity" means more than "not blank"');
check('a complete identity has no problems', identityProblems({ name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' }).length === 0);
let p = identityProblems({});
check('a blank identity is rejected', p.length >= 3, JSON.stringify(p));
check('and names each missing piece', p.map((x) => x.field).join(',') === 'name,business,postalAddress', p.map((x) => x.field).join(','));
check('CAN-SPAM is named as the reason for the address', /CAN-SPAM/.test(p.find((x) => x.field === 'postalAddress').text));

// the ones a truthiness check would have let through
const bad = (addr) => identityProblems({ name: 'A', business: 'B', postalAddress: addr });
check('a one-word address is refused', bad('Plano').length > 0, JSON.stringify(bad('Plano')));
check('an address with no number is refused', bad('Preston Road, Plano, Texas').length > 0);
check('a literal TODO is refused', bad('TODO add address 75093').some((x) => /placeholder/.test(x.text)), JSON.stringify(bad('TODO add address 75093')));
check('"123 Main St" is refused', bad('123 Main St, Anytown TX 75000').some((x) => /placeholder/.test(x.text)));
check('an example address is refused', bad('1 Example Ave, Plano TX 75093').some((x) => /placeholder/.test(x.text)));
check('a real-looking address passes', bad('2201 Preston Rd Suite 405, Plano TX 75093').length === 0);
check('a broken reply-to is caught, because replies would go nowhere',
  identityProblems({ name: 'A', business: 'B', postalAddress: '2201 Preston Rd, Plano TX 75093', replyTo: 'not an email' }).some((x) => x.field === 'replyTo'));
check('and a good one is not', identityProblems({ name: 'A', business: 'B', postalAddress: '2201 Preston Rd, Plano TX 75093', replyTo: 'm@i.test' }).length === 0);

// ---------------------------------------------------------------------------
section('U7  the sending gate refuses until all of this is true');
{
  const { sendReadiness } = await import('../lib/outreach-email.js');
  const { saveSender, saveSettings } = await import('../lib/settings.js');
  await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { status: 'confirmed' } });
  await saveSender({ name: '', business: '', postalAddress: '' });
  let rd = await sendReadiness({ env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test', ...ENV } });
  let codes = rd.blockers.map((b) => b.code);
  check('a blank sender identity blocks sending', codes.some((c) => c.startsWith('identity-')), codes.join(','));
  check('and each missing field is listed separately', codes.filter((c) => c.startsWith('identity-')).length >= 3, codes.join(','));

  await saveSender({ name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' });
  rd = await sendReadiness({ env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test' } });
  codes = rd.blockers.map((b) => b.code);
  check('no public URL blocks sending, because the link would point nowhere', codes.includes('no-public-url'), codes.join(','));
  check('and it says why Gmail and Yahoo care', /one-click unsubscribe/.test(rd.blockers.find((b) => b.code === 'no-public-url').text));
  rd = await sendReadiness({ env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test', PUBLIC_BASE_URL: 'https://dash.test' } });
  codes = rd.blockers.map((b) => b.code);
  check('no signing secret blocks sending, because links would be forgeable', codes.includes('no-unsub-secret'), codes.join(','));
}

// ---------------------------------------------------------------------------
section('U8  through the real HTTP handler, as a stranger would reach it');
// The route lives on the public collect function because someone who wants to
// stop hearing from us must never be asked to log in.
{
  process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret';
  process.env.PUBLIC_BASE_URL = 'https://dash.test';
  const handler = (await import('../api/collect.js')).default;
  const ADDR2 = 'stranger@elsewhere.test';
  const tok = makeToken(ADDR2, process.env);
  await store.set(`suppress:email:${ADDR2}`, '').catch(() => {});

  const mkRes = () => {
    const r = { statusCode: 0, body: '', headers: {} };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.send = (b) => { r.body = String(b); return r; };
    r.json = (b) => { r.body = JSON.stringify(b); return r; };
    r.end = () => r;
    return r;
  };

  // GET renders the page and changes NOTHING
  let res = mkRes();
  await handler({ method: 'GET', query: { unsub: '1', e: ADDR2, t: tok }, headers: {} }, res);
  check('GET returns a page', res.statusCode === 200 && /Unsubscribe/.test(res.body));
  check('it is served as HTML', String(res.headers['Content-Type'] || '').includes('text/html'));
  check('and is not cached, so a stale page cannot mislead', /no-store/.test(res.headers['Cache-Control'] || ''));
  check('GET did NOT unsubscribe anyone', (await isSuppressed(ADDR2)) === false);

  // even a valid token on a GET does nothing — this is the scanner case
  check('a scanner fetching the link leaves them subscribed', (await isSuppressed(ADDR2)) === false);

  // POST performs it, which is what RFC 8058 one-click sends
  res = mkRes();
  await handler({ method: 'POST', query: { unsub: '1' }, body: { e: ADDR2, t: tok }, headers: {} }, res);
  check('POST unsubscribes', res.statusCode === 200, String(res.statusCode));
  check('the page confirms it', /Unsubscribed/.test(res.body), res.body.slice(0, 160));
  check('and the address really is suppressed', (await isSuppressed(ADDR2)) === true);

  // a forged token gets nowhere
  const ADDR3 = 'victim@elsewhere.test';
  await store.set(`suppress:email:${ADDR3}`, '').catch(() => {});
  res = mkRes();
  await handler({ method: 'POST', query: { unsub: '1' }, body: { e: ADDR3, t: tok }, headers: {} }, res);
  check('one person cannot unsubscribe another', (await isSuppressed(ADDR3)) === false, String(res.statusCode));
  check('and the attempt is refused, not silently ignored', res.statusCode === 400);
  check('with a page saying the link is not valid', /not valid for this address/.test(res.body));

  await store.set(`suppress:email:${ADDR2}`, '').catch(() => {});
  await store.set(`suppress:email:${ADDR3}`, '').catch(() => {});
}

await store.set(`suppress:email:${ADDR}`, '').catch(() => {});
done();
