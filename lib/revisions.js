// Inbox -> auto-revision pipeline. Reads Mondo's Info@ inbox (via Gmail),
// classifies each new email cheaply, and for anything that reads as a client
// asking for a site change: replies in-thread within minutes, drops a
// calendar hold, and logs a ticket. Nothing here ever ships a code change by
// itself — that's still the SEO agent's job, triggered separately; this just
// makes sure the client hears back fast and the work is scheduled.
import { store } from './store.js';
import { listNewMail, labelProcessed, createCalendarEvent, sendGmailReply, googleConfigured } from './google.js';
import { listSites } from './registry.js';
import { markAiMonth } from './aicost.js';

const MONTH = () => new Date().toISOString().slice(0, 7);
const PROMISE_BUSINESS_DAYS = 3;
const CALENDAR_HOLD_BUSINESS_DAYS = 2;

async function num(k) {
  const v = await store.get(k).catch(() => null);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
async function bump(k, usd) {
  const cur = await num(k);
  await store.set(k, String(+(cur + usd).toFixed(5)), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
}
async function readArr(k) {
  const raw = await store.get(k).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function addBusinessDays(n) {
  let d = new Date();
  let added = 0;
  while (added < n) {
    d = new Date(d.getTime() + 86400000);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  d.setUTCHours(15, 0, 0, 0); // ~10am Central, good-enough default
  return d;
}
const dateQuery = (d) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
const emailOf = (from) => (from.match(/<(.+)>/) || [, from])[1].trim();

async function classify(mail, sites) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { isRevision: false, error: 'no ANTHROPIC_API_KEY' };
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (e) {
    return { isRevision: false, error: 'sdk: ' + (e.message || e) };
  }
  const client = new Anthropic({ apiKey: key });
  const siteList = sites.map((s) => `${s.slug} :: ${s.name} :: ${s.url} :: client email ${s.email || 'none on file'}`).join('\n');
  let r;
  try {
    r = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: "Classify one inbound email to a web agency's general inbox. Return ONLY JSON.",
      messages: [
        {
          role: 'user',
          content: `Known client sites:\n${siteList}\n\nEmail:\nFrom: ${mail.from}\nSubject: ${mail.subject}\nBody: ${mail.body || mail.snippet}\n\nIs this a client asking for a change/update to their website (content edit, add/remove something, fix something visible)? Ignore newsletters, spam, invoices, unrelated questions, and anything not about an existing site's content.\nJSON: {"isRevision": true|false, "slug": "<matching site slug from the list, or null>", "summary": "one short specific line describing exactly what they're asking for, empty string if not a revision"}`,
        },
      ],
    });
  } catch (e) {
    return { isRevision: false, error: 'model call failed: ' + (e.message || e) };
  }
  const usd = +(((r.usage?.input_tokens || 0) / 1e6) * 1 + ((r.usage?.output_tokens || 0) / 1e6) * 5).toFixed(5);
  await bump(`coach:spend:${MONTH()}`, usd);
  await markAiMonth(MONTH());
  const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    let s = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const parsed = JSON.parse(s);
    return { isRevision: !!parsed.isRevision, slug: parsed.slug || null, summary: String(parsed.summary || '').slice(0, 200) };
  } catch (e) {
    return { isRevision: false, error: 'could not parse classification' };
  }
}

export async function revisionsStatus() {
  return {
    configured: googleConfigured(),
    lastCheck: Number(await store.get('revisions:lastCheck').catch(() => 0)) || 0,
    tickets: (await readArr('revisions:all')).slice(0, 30),
  };
}

export async function checkRevisionInbox() {
  if (!googleConfigured()) return { ok: false, error: 'Google not connected — GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN not set in Vercel' };

  const lastCheckSec = Number(await store.get('revisions:lastCheck').catch(() => 0)) || Math.floor(Date.now() / 1000) - 3 * 86400;
  const since = dateQuery(new Date(lastCheckSec * 1000 - 86400000)); // 1 day of slack so day-boundary emails aren't missed

  let mail;
  try {
    mail = await listNewMail(since);
  } catch (e) {
    return { ok: false, error: 'could not read Gmail: ' + (e.message || e) };
  }

  const sites = await listSites();
  const results = [];
  for (const msg of mail) {
    let cls;
    try {
      cls = await classify(msg, sites);
    } catch (e) {
      cls = { isRevision: false, error: String(e.message || e) };
    }
    if (!cls.isRevision) {
      await labelProcessed(msg.id).catch(() => {});
      continue;
    }

    const site = sites.find((s) => s.slug === cls.slug) || null;
    const replyTo = emailOf(msg.from);
    const holdAt = addBusinessDays(CALENDAR_HOLD_BUSINESS_DAYS);

    let calendarLink = null;
    try {
      const ev = await createCalendarEvent({
        title: `Revision: ${site ? site.name : 'Unmatched site'} — ${cls.summary}`,
        description: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${cls.summary}\n\nOriginal: ${msg.snippet}`,
        startAt: holdAt,
      });
      calendarLink = ev.htmlLink;
    } catch (e) {
      /* still proceed — a missing calendar entry shouldn't block the reply */
    }

    let repliedAt = null;
    try {
      await sendGmailReply({
        to: replyTo,
        subject: msg.subject,
        threadId: msg.threadId,
        inReplyTo: msg.messageIdHeader,
        body: `Hi,\n\nThanks for sending this over — got it: ${cls.summary}\n\nWe'll have it updated and live within ${PROMISE_BUSINESS_DAYS} business days, and I'll follow up personally once it's done.\n\n— ${process.env.REPORT_SIGNATURE || 'Inspiring Websites'}`,
      });
      repliedAt = Date.now();
    } catch (e) {
      /* logged on the ticket itself below */
    }

    const ticket = {
      id: msg.id,
      slug: site?.slug || null,
      siteName: site?.name || 'Unmatched site',
      from: msg.from,
      subject: msg.subject,
      summary: cls.summary,
      receivedAt: Date.now(),
      repliedAt,
      calendarLink,
      dueBy: holdAt.getTime() + 86400000, // the 2-day hold + 1 day buffer toward the 3-day promise
      status: repliedAt ? 'scheduled' : 'needs attention',
    };
    const all = await readArr('revisions:all');
    all.unshift(ticket);
    await store.set('revisions:all', JSON.stringify(all.slice(0, 200)));
    await labelProcessed(msg.id).catch(() => {});
    results.push(ticket);
  }

  await store.set('revisions:lastCheck', String(Math.floor(Date.now() / 1000)));
  return { ok: true, checked: mail.length, tickets: results.length, results };
}

export async function markTicketDone(ticketId) {
  const all = await readArr('revisions:all');
  const t = all.find((x) => x.id === ticketId);
  if (!t) return { ok: false, error: 'ticket not found' };
  t.status = 'done';
  t.doneAt = Date.now();
  await store.set('revisions:all', JSON.stringify(all));
  return { ok: true, ticket: t };
}
