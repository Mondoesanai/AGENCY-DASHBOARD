import { W, addRepo, addMail, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { saveSiteConfig, listSites } from '../lib/registry.js';
import { checkRevisionInbox, revisionsStatus } from '../lib/revisions.js';
import { handleInbound } from '../lib/sms-actions.js';

const MK = new Date().toISOString().slice(0, 7);
const OWNER = '+15551234567';
const readArr = async (k) => { const r = await store.get(k); try { const a = typeof r === 'string' ? JSON.parse(r) : r; return Array.isArray(a) ? a : []; } catch { return []; } };

addRepo('acme/site', { 'index.html': '<html><head><title>Acme</title></head><body><p>Hours: 8-6</p></body></html>', 'sitemap.xml': 'x', 'robots.txt': 'x', 'llms.txt': 'x' });
W.pages['https://acme.test'] = '<html><body>Hours: 9-5</body></html>';
await saveSiteConfig('acme', { url: 'https://acme.test', name: 'Acme Detailing', repo: 'acme/site', email: 'owner@acme.test', client: 'Sam' });
await saveSiteConfig('abovepar', { url: 'https://abovepar.test', name: 'Above Par', repo: 'acme/site', email: 'debbie@abovepar.test', client: 'Debbie' });
await store.set('conv:tagged:acme', '1'); await store.set('conv:tagged:abovepar', '1');
for (const s of ['acme', 'abovepar']) {
  await store.set(`agent:keywords:${s}`, JSON.stringify(['a b c']));
  await store.set(`agent:ranks:${s}`, JSON.stringify({ at: Date.now(), depth: 100, results: [{ keyword: 'a b c', rank: null }] }));
}

// ---- the fake models -------------------------------------------------------
let planMode = 'patch';
W.router = (req, flat) => {
  const sys = String(req.system || '');
  if (/Classify one inbound email/.test(sys)) {
    const verified = /IS a verified client of (\w+)/.exec(flat);
    if (/MARKER_CLIENT_REQ/.test(flat)) return JSON.stringify({ isRevision: true, slug: 'acme', confident: true, summary: 'Change the hours to 9-5' });
    if (/MARKER_STRANGER_REQ/.test(flat)) return JSON.stringify({ isRevision: true, slug: 'acme', confident: true, summary: 'Add a new menu item to the Acme site' });
    if (/MARKER_THANKS/.test(flat)) return JSON.stringify({ isRevision: true, slug: 'acme', confident: true, summary: 'Website will be updated' }); // a deliberately over-eager classifier
    if (/MARKER_NOMATCH/.test(flat)) return JSON.stringify({ isRevision: true, slug: null, confident: true, summary: 'change something' });
    return JSON.stringify({ isRevision: false, slug: null, confident: true, summary: '' });
  }
  if (/senior technical-SEO/.test(sys)) {
    if (planMode === 'blocked') return 'SUMMARY: x\nCOMMIT: x\nBLOCKED: This value is stored in a third-party dashboard, not in the repo.';
    return `SUMMARY: Updated your opening hours to 9-5 on the homepage
COMMIT: revision: hours
PATCH: index.html
REASON: hours
---FIND---
Hours: 8-6
---REPLACE---
Hours: 9-5
---END PATCH---`;
  }
  if (/quick QA check/.test(sys)) return '{"matches": true, "reason": "live page shows 9-5"}';
  return '{}';
};
const classifierCalls = () => W.anthropicCalls.filter((c) => /Classify one inbound email/.test(String(c.system))).length;
const sentTo = (addr) => W.gmail.sent.filter((raw) => new RegExp('^To: ' + addr.replace(/[.+]/g, '\\$&'), 'm').test(raw));

section('I1  mixed inbox: only the verified client gets a reply');
addMail({ id: 'c1', from: 'Sam <owner@acme.test>', subject: 'Hours', body: 'MARKER_CLIENT_REQ please change our hours to 9-5' });
addMail({ id: 's1', from: 'Random Guy <random@gmail.com>', subject: 'Update', body: 'MARKER_STRANGER_REQ can you add a new menu item to the Acme Detailing site' });
addMail({ id: 'th', from: 'Jo <jo@othercorp.test>', subject: 'Re: your website', body: 'MARKER_THANKS Hey thank you for sending me the website, will be updated shortly', threadHasSent: true });
addMail({ id: 'bot', from: 'Read Assistant <executiveassistant@e.read.ai>', subject: 'Meeting report', body: 'MARKER_CLIENT_REQ notes about the website' });
addMail({ id: 'nl', from: 'News <hello@newsletter.test>', subject: 'Deals', body: 'weekly deals' });
addMail({ id: 'nm', from: 'Someone <someone@nowhere.test>', subject: 'hi', body: 'MARKER_NOMATCH can you change something' });
addMail({ id: 'dom', from: 'Sam N <sam.new@acme.test>', subject: 'more', body: 'MARKER_CLIENT_REQ another hours tweak' });
const r1 = await checkRevisionInbox({ maxMs: 40000 });
const st1 = await revisionsStatus();
const byId = (id) => st1.tickets.find((t) => t.id === id);
check('inbox run succeeded and read all 7 mails', r1.ok && r1.checked === 7, JSON.stringify(r1));
check('client request became a ticket and was queued for the agent (already shipped + closed in the same run)', ['scheduled', 'done'].includes(byId('c1')?.status) && !!byId('c1')?.todoId, JSON.stringify(byId('c1')));
check('client got the in-thread reply', sentTo('owner@acme.test').length >= 1);
check('calendar hold created for the client request', W.calendar.length >= 1);
check('owner texted an FYI for the client request', W.sms.some((s) => /New request from Sam .*Change the hours/.test(s.body)), JSON.stringify(W.sms.map((s) => s.body)));
check('client at a NEW address on their own domain is still trusted (email changes handled)', byId('dom')?.status === 'scheduled', JSON.stringify(byId('dom')));
check('stranger became a HELD ticket, not queued', byId('s1')?.lowConfidence === true && !byId('s1')?.todoId, JSON.stringify(byId('s1')));
check('stranger got NO reply email', sentTo('random@gmail.com').length === 0);
check('owner was asked by text about the stranger with YES/NO', W.sms.some((s) => /random@gmail\.com/.test(s.body) && /Reply YES or NO \(#\d+\)/.test(s.body)), JSON.stringify(W.sms.map((s) => s.body)));
check('"thanks for sending the site" reply: no ticket', !byId('th'));
check('"thanks for sending the site" reply: NO reply email', sentTo('jo@othercorp.test').length === 0);
check('meeting bot: classifier never even called for it', !W.anthropicCalls.some((c) => /executiveassistant/.test(JSON.stringify(c.messages))));
check('newsletter ignored', !byId('nl'));
check('unmatched stranger mail dropped (no ticket, no reply, no ask)', !byId('nm') && sentTo('someone@nowhere.test').length === 0 && !W.sms.some((s) => /someone@nowhere/.test(s.body)));
check('every message was labelled processed (never re-read)', ['c1', 's1', 'th', 'bot', 'nl', 'nm', 'dom'].every((id) => W.gmail.inbox.find((m) => m.id === id).labels.includes('iw-processed')));
const clientPrompt = W.anthropicCalls.find((c) => /MARKER_CLIENT_REQ/.test(JSON.stringify(c.messages)) && /owner@acme/.test(JSON.stringify(c.messages)) && /Classify/.test(String(c.system)));
check('classifier is told a verified client is a verified client', /IS a verified client of acme \(address on file\)/.test(JSON.stringify(clientPrompt?.messages)));
const strangerPrompt = W.anthropicCalls.find((c) => /MARKER_STRANGER_REQ/.test(JSON.stringify(c.messages)));
check('classifier is told a stranger is NOT verified', /NOT a verified client/.test(JSON.stringify(strangerPrompt?.messages)));

section('I2  the agent works the queued client revisions in the same run');
check('the hours revision shipped to the live site', W.repos['acme/site'].files['index.html'].includes('Hours: 9-5'));
const r1b = await checkRevisionInbox({ maxMs: 40000 });
const st1b = await revisionsStatus();
check('ticket resolved to done after the live-site QA check', st1b.tickets.find((t) => t.id === 'c1')?.status === 'done', JSON.stringify(st1b.tickets.find((t) => t.id === 'c1')));
check('client emailed that it is live (summary + link)', W.emails.some((e) => e.to === 'owner@acme.test' && /Revisions completed/.test(e.subject) && /acme\.test/.test(e.text)), JSON.stringify(W.emails.map((e) => e.to + ' | ' + e.subject)));
check('owner texted that it is done', W.sms.some((s) => /^Done: Acme Detailing/.test(s.body)), JSON.stringify(W.sms.map((s) => s.body)));

section('I3  answering the stranger question by text');
const askId = /#(\d+)/.exec(W.sms.find((s) => /random@gmail\.com/.test(s.body)).body)[1];
check('a stranger texting the owner number is ignored', (await handleInbound({ from: '+19998887777', body: 'YES ' + askId })) === '');
const beforeReplies = sentTo('random@gmail.com').length;
const yesReply = await handleInbound({ from: OWNER, body: 'yes' });
check('YES accepted', /queued the change/.test(yesReply), yesReply);
check('YES sent the stranger a real reply', sentTo('random@gmail.com').length === beforeReplies + 1);
const st2 = await revisionsStatus();
check('held ticket is now queued for the agent', st2.tickets.find((t) => t.id === 's1')?.status === 'scheduled' && !!st2.tickets.find((t) => t.id === 's1')?.todoId);
addMail({ id: 's2', from: 'Random Guy <random@gmail.com>', subject: 'another', body: 'MARKER_STRANGER_REQ one more thing for acme detailing' });
await checkRevisionInbox({ maxMs: 40000 });
const s2 = (await revisionsStatus()).tickets.find((t) => t.id === 's2');
check('after YES that address is remembered: next mail handled automatically (no new question)', s2?.status === 'scheduled' && s2?.lowConfidence !== true, JSON.stringify(s2));

section('I4  NO drops it silently');
addMail({ id: 's3', from: 'Other Person <other@yahoo.test>', subject: 'x', body: 'MARKER_STRANGER_REQ change something on acme detailing' });
await checkRevisionInbox({ maxMs: 40000 });
const askS3 = W.sms.filter((s) => /other@yahoo\.test/.test(s.body)).pop();
check('asked', !!askS3);
const noReply = await handleInbound({ from: OWNER, body: 'no' });
check('NO acknowledged', /Ignored/.test(noReply), noReply);
check('no reply email to them', sentTo('other@yahoo.test').length === 0);
check('ticket cancelled', (await revisionsStatus()).tickets.find((t) => t.id === 's3')?.status === 'cancelled');

section('I5a  with several tickets queued for one site, the question is about the ticket actually worked (oldest), not the newest');
planMode = 'blocked';
addMail({ id: 'c2', from: 'Sam <owner@acme.test>', subject: 'x', body: 'MARKER_CLIENT_REQ update the number in our payment dashboard' });
await checkRevisionInbox({ maxMs: 40000 });
const askA = W.sms.filter((s) => /DONE.*RETRY.*SKIP/.test(s.body)).pop();
const stA = await revisionsStatus();
const queued = stA.tickets.filter((t) => t.status === 'scheduled' || t.status === 'needs attention');
check('question names the OLDEST queued ticket (menu item), not the newest (payment dashboard)', /menu item/.test(askA?.body || '') && !/payment/.test(askA?.body || ''), askA?.body);
check('the newest ticket (c2) was NOT touched', !stA.tickets.find((t) => t.id === 'c2')?.lastAttempt, JSON.stringify(stA.tickets.find((t) => t.id === 'c2')));
for (const t of queued.filter((t) => t.id !== 'c2')) await (await import('../lib/revisions.js')).cancelTicket(t.id);
for (const a of (await (await import('../lib/sms.js')).pendingIds())) await (await import('../lib/sms.js')).closeAsk(a);
W.sms.length = 0;

section('I5  something the agent truly cannot do -> asks with DONE / RETRY / SKIP, and each works');
planMode = 'blocked';
await checkRevisionInbox({ maxMs: 40000 });
const blockedAsk = W.sms.filter((s) => /DONE.*RETRY.*SKIP/.test(s.body)).pop();
check('owner asked by text with the real reason and 3 choices', !!blockedAsk && /third-party dashboard/.test(blockedAsk.body), JSON.stringify(blockedAsk));
const c2 = () => revisionsStatus().then((s) => s.tickets.find((t) => t.id === 'c2'));
check('ticket is flagged needs attention', (await c2())?.status === 'needs attention', JSON.stringify(await c2()));
planMode = 'patch';
const retryReply = await handleInbound({ from: OWNER, body: 'RETRY' });
check('RETRY re-queues it', /another try/.test(retryReply) && (await c2())?.status === 'scheduled', retryReply);
planMode = 'blocked';
await checkRevisionInbox({ maxMs: 40000 }); // blocked again (asks again)
const emailsBefore = W.emails.length;
const doneReply = await handleInbound({ from: OWNER, body: 'DONE' });
check('DONE marks it complete and emails the client', /Marked done/.test(doneReply) && W.emails.length > emailsBefore, doneReply);
check('nothing pending afterwards', /Nothing waiting/.test(await handleInbound({ from: OWNER, body: 'yes' })));

section('I6  cost guard: every text is plain ASCII and short');
check('no non-ASCII in any text sent', W.sms.every((s) => !/[^\x20-\x7E\n]/.test(s.body)));
check('no text over 320 chars (max 2 segments)', W.sms.every((s) => s.body.length <= 320), String(Math.max(...W.sms.map((s) => s.body.length))));
console.log('  texts sent in this whole scenario:', W.sms.length);

done();
