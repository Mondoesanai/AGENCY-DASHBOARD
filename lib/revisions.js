// Inbox -> auto-revision pipeline. Reads Mondo's Info@ inbox (via Gmail),
// classifies each new email cheaply, and for anything that reads as a client
// asking for a site change: replies in-thread within minutes, drops a
// calendar hold, and logs a ticket. Nothing here ever ships a code change by
// itself — that's still the SEO agent's job, triggered separately; this just
// makes sure the client hears back fast and the work is scheduled.
import { store } from './store.js';
import { listNewMail, labelProcessed, createCalendarEvent, sendGmailReply, sendGmailMessage, getMyEmailAddress, googleConfigured } from './google.js';
import { listSites, matchExistingSite } from './registry.js';
import { markAiMonth } from './aicost.js';
import { addRevisionTodo, todosState, removeTodo } from './todos.js';
import { runAgentCycle } from './agent.js';
import { commitChangeset } from './github.js';

const MONTH = () => new Date().toISOString().slice(0, 7);
const PROMISE_BUSINESS_DAYS = 3;
const AGENCY_NOTIFY = process.env.AGENCY_NOTIFY_EMAIL || 'info@inspiringwebsites.org';

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
const emailOf = (from) => (from.match(/<(.+)>/) || [, from])[1].trim().toLowerCase();
const domainOf = (email) => (email.split('@')[1] || '').toLowerCase();

// Learns sender -> site over time so a name/company match is only ever needed
// ONCE per person. Populated automatically on a confident match, or by Mondo
// manually assigning an "Unmatched" ticket (assignTicketToSite below).
async function knownSlugFor(email) {
  const map = await store.get('revisions:senderMap').catch(() => null);
  try {
    const m = map ? (typeof map === 'string' ? JSON.parse(map) : map) : {};
    return m[email] || null;
  } catch {
    return null;
  }
}
async function rememberSender(email, slug) {
  const raw = await store.get('revisions:senderMap').catch(() => null);
  let m = {};
  try {
    m = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  } catch {
    m = {};
  }
  m[email] = slug;
  await store.set('revisions:senderMap', JSON.stringify(m)).catch(() => {});
}

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
  const senderEmail = emailOf(mail.from);
  const senderDomain = domainOf(senderEmail);
  const knownSlug = await knownSlugFor(senderEmail);
  const siteList = sites.map((s) => `${s.slug} :: business "${s.name}" :: site domain ${(s.url || '').replace(/^https?:\/\//, '')} :: contact email ${s.email || 'none on file'}`).join('\n');
  let r;
  try {
    r = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: "Classify one inbound email to a web agency's general inbox. Return ONLY JSON.",
      messages: [
        {
          role: 'user',
          content: `Known client sites:\n${siteList}\n${knownSlug ? `\nThis exact sender (${senderEmail}) has been confirmed before as: ${knownSlug} — use that unless the email content clearly says otherwise.\n` : ''}
Email:\nFrom: ${mail.from} (domain: ${senderDomain})\nSubject: ${mail.subject}\nBody: ${mail.body || mail.snippet}

Is this a client asking for a change/update to their website (content edit, add/remove something, fix something visible)? Ignore newsletters, spam, invoices, unrelated questions, and anything not about an existing site's content.

IMPORTANT on matching the site: people rarely email from the exact address on file — a personal Gmail, a coworker, a new employee. Don't rely on the sender address alone. Look for ANY of: the sender's email domain matching a site's domain, the business name mentioned anywhere (subject, body, signature), a phone number, or the known-sender hint above. Only return null if there's genuinely no identifying clue at all — guessing wrong is worse than saying you don't know.

JSON: {"isRevision": true|false, "slug": "<matching site slug from the list, or null if you can't tell>", "confident": true|false, "summary": "one short specific line describing exactly what they're asking for, empty string if not a revision"}`,
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
    return { isRevision: !!parsed.isRevision, slug: parsed.slug || null, confident: parsed.confident !== false, summary: String(parsed.summary || '').slice(0, 200) };
  } catch (e) {
    return { isRevision: false, error: 'could not parse classification' };
  }
}

async function sendRevisionCompletedEmail(site, ticket) {
  if (!process.env.RESEND_API_KEY || !process.env.REPORT_FROM) return { sent: false, reason: 'RESEND_API_KEY/REPORT_FROM not set' };
  if (!site.email) return { sent: false, reason: 'no client email on file' };
  let Resend;
  try {
    ({ Resend } = await import('resend'));
  } catch (e) {
    return { sent: false, reason: 'resend package unavailable' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const body =
    `Hi,\n\nJust letting you know — the update you asked for on ${site.name} is live:\n\n` +
    `• ${ticket.summary}\n\n` +
    `Take a look whenever you get a chance: ${site.url}\n\n` +
    `— ${process.env.REPORT_SIGNATURE || 'Inspiring Websites'}`;
  try {
    const r = await resend.emails.send({
      from: process.env.REPORT_FROM,
      to: site.email,
      cc: AGENCY_NOTIFY,
      subject: `Revisions completed — ${site.name}`,
      text: body,
    });
    if (r.error) return { sent: false, reason: r.error.message };
    return { sent: true, id: r.data?.id || null };
  } catch (e) {
    return { sent: false, reason: String(e.message || e) };
  }
}

// Fires once per NEW sender guess (never for an already-known sender — those
// aren't guesses anymore). Fully non-blocking: everything already proceeded
// before this is sent. Mondo only ever has to act if it's actually wrong.
async function sendGuessConfirmation(ticket, site) {
  try {
    const me = await getMyEmailAddress();
    const sent = await sendGmailMessage({
      to: me,
      subject: `Confirm: is "${ticket.from}" = ${site.name}? [ticket:${ticket.id}]`,
      body:
        `Got a website update request from ${ticket.from}, matched it to ${site.name} (${site.url}).\n\n` +
        `Already replied to them, scheduled it, and it's queued to be fixed — no action needed if that's right.\n\n` +
        `If that's WRONG: reply to this email with the word "no" and the correct site's link (e.g. https://theirsite.com), and I'll undo it and redo it against the right site right away.`,
    });
    if (sent?.id) await labelProcessed(sent.id).catch(() => {}); // so it never re-reads its own notification as new mail
  } catch (e) {
    /* best-effort — a failed confirmation doesn't block the actual work */
  }
}

// Undoes a fix that already shipped to the WRONG site, using the before-state
// the agent saved when it made the change. Newly-created files (there was no
// "before") are left in place — harmless extras, not worth building full
// git-delete support for what should be a rare correction.
async function revertShippedFix(ticket) {
  if (!ticket.todoId || !ticket.slug) return null;
  const raw = await store.get(`revert:${ticket.todoId}`).catch(() => null);
  if (!raw) return null;
  const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const revertFiles = (info.files || []).filter((f) => f.before !== null && f.before !== undefined);
  if (!revertFiles.length || !info.repo) return null;
  return commitChangeset(info.repo, {
    files: revertFiles.map((f) => ({ path: f.path, content: f.before })),
    message: `Revert: wrong-site match (ticket ${ticket.id})`,
    branchPrefix: 'seo-agent-revert',
    autoMerge: true,
    body: 'Automated revert — this change was applied to the wrong client\'s site by mistake and is being undone.',
  }).catch(() => null);
}

// A reply to one of our own confirmation emails, matched by the [ticket:id]
// tag in the subject — never runs through the normal client-request classifier.
async function handleCorrectionReply(msg, ticketId, sites) {
  const all = await readArr('revisions:all');
  const t = all.find((x) => x.id === ticketId);
  if (!t) return; // stale/unknown tag, nothing to do

  const body = msg.body || msg.snippet || '';
  if (!/\bno\b/i.test(body)) return; // "yes", or anything else — leave it exactly as is
  const urlMatch = body.match(/https?:\/\/[^\s)]+/i) || body.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)]*)?/i);
  if (!urlMatch) return; // said no but didn't give a link — can't act on it safely

  const correctSlug = await matchExistingSite(urlMatch[0]).catch(() => null);
  if (!correctSlug || correctSlug === t.slug) return;
  const correctSite = sites.find((s) => s.slug === correctSlug);
  if (!correctSite) return;

  // undo whatever happened on the wrong site
  if (t.slug) {
    if (t.status === 'done') await revertShippedFix(t);
    else if (t.todoId) await removeTodo(t.slug, t.todoId);
  }
  // re-route to the real one
  const newTodoId = await addRevisionTodo(correctSlug, { title: t.summary, detail: `Requested by ${t.from} (corrected by Mondo)`, ticketId: t.id }).catch(() => null);
  t.slug = correctSlug;
  t.siteName = correctSite.name;
  t.todoId = newTodoId;
  t.status = newTodoId ? 'scheduled' : 'needs attention';
  t.corrected = true;
  await store.set('revisions:all', JSON.stringify(all));
  await rememberSender(emailOf(t.from), correctSlug).catch(() => {});

  // get it onto the right site now, don't wait for the next poll
  try {
    await runAgentCycle(correctSite, { manual: false });
  } catch {
    /* the normal per-poll pass will pick it up if this attempt didn't land */
  }
}

// Any open ticket whose linked to-do has disappeared from the site's list got
// shipped by the agent (possibly on a completely different run/trigger than
// this one) — that's the completion signal. Checked every poll, so this fires
// within ~10 minutes of the fix actually going live, not just when this
// process happened to be the one that made the fix.
async function resolveCompletedTickets(sites) {
  const all = await readArr('revisions:all');
  let changed = false;
  for (const t of all) {
    if (t.status !== 'scheduled' || !t.todoId || !t.slug) continue;
    const site = sites.find((s) => s.slug === t.slug);
    if (!site) continue;
    const { current } = await todosState(site).catch(() => ({ current: null }));
    const stillOpen = (current?.items || []).some((it) => it.id === t.todoId);
    if (stillOpen) continue;
    // the to-do vanished, meaning the agent shipped it — pull the exact
    // repo/branch/PR it went out on from that site's agent log so the ticket
    // can show "here's the commit" instead of just "done".
    const log = await readArr(`agent:log:${site.slug}`);
    const shipEntry = log.find((e) => (e.action === 'shipped' || e.action === 'PR opened') && (!e.at || e.at >= t.receivedAt));
    if (shipEntry) {
      t.repo = site.repo || null;
      t.commitUrl = shipEntry.prUrl || null;
      t.branch = shipEntry.branch || null;
      t.shipSummary = shipEntry.detail || null;
    }
    t.siteUrl = site.url || null;
    const mail = await sendRevisionCompletedEmail(site, t);
    t.status = 'done';
    t.doneAt = Date.now();
    t.completionEmail = mail;
    changed = true;
  }
  if (changed) await store.set('revisions:all', JSON.stringify(all));
}

// One agent cycle for the site with the oldest pending revision — this is
// what actually gets it fixed "today" instead of waiting for that site's
// normal turn in the daily rotation. Bounded to one per check (this endpoint
// gets pinged every ~10 min, so a second site's turn is never far behind).
async function workOnePendingRevision(sites, deadline) {
  for (const site of sites) {
    if (Date.now() > deadline) return null;
    const { current } = await todosState(site).catch(() => ({ current: null }));
    if (!(current?.items || []).some((it) => it.source === 'revision')) continue;
    try {
      return { slug: site.slug, result: await runAgentCycle(site, { manual: false }) };
    } catch (e) {
      return { slug: site.slug, result: { ok: false, error: String(e.message || e) } };
    }
  }
  return null;
}

export async function revisionsStatus() {
  return {
    configured: googleConfigured(),
    lastCheck: Number(await store.get('revisions:lastCheck').catch(() => 0)) || 0,
    tickets: (await readArr('revisions:all')).slice(0, 30),
  };
}

// maxMs lets a caller with its own time budget already partly spent (e.g. the
// daily cron, which does health checks + the SEO agent + this in one 60s
// function) hand over only what's left, instead of this always assuming a
// fresh 50s window and risking the whole function getting hard-killed.
export async function checkRevisionInbox({ maxMs = 50000 } = {}) {
  if (!googleConfigured()) return { ok: false, error: 'Google not connected — GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN not set in Vercel' };

  // Three independent triggers can call this now — GitHub Actions (~10 min),
  // the daily-cron fallback, and the dashboard's own Refresh/Check-inbox-now
  // button. Gmail dedup relies on labeling each message right after it's
  // processed, which takes several seconds (reply + calendar + ticket write)
  // — so two overlapping runs can both grab the same not-yet-labeled email
  // and create a duplicate ticket. This lock makes sure only one run is ever
  // actually working the inbox at a time; a second caller just no-ops.
  const lockSet = await store.set('revisions:lock', String(Date.now()), { nx: true, ex: 120 }).catch(() => 'skip-lock');
  if (lockSet === null) return { ok: true, checked: 0, tickets: 0, note: 'another check is already in progress' };

  try {
    return await runInboxCheck(maxMs);
  } finally {
    await store.set('revisions:lock', '', { ex: 1 }).catch(() => {});
  }
}

async function runInboxCheck(maxMs) {
  const t0 = Date.now();
  const HARD_LIMIT_MS = maxMs;

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
    if (Date.now() - t0 > HARD_LIMIT_MS - 8000) {
      results.push({ id: msg.id, skipped: true, reason: 'out of time this run — the next check in ~10 min picks it up' });
      continue;
    }

    // a reply to one of Mondo's own confirmation emails, not a client request
    const ticketTag = msg.subject.match(/\[ticket:([^\]]+)\]/i);
    if (ticketTag) {
      await handleCorrectionReply(msg, ticketTag[1], sites).catch(() => {});
      await labelProcessed(msg.id).catch(() => {});
      continue;
    }

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

    // belt-and-suspenders: the Gmail label is the primary once-only guard,
    // but if that PATCH silently failed on a prior run (network hiccup, swallowed
    // by a .catch), the same email would otherwise get a second ticket next
    // check. A ticket already exists for this exact message id — skip.
    if ((await readArr('revisions:all')).some((t) => t.id === msg.id)) {
      await labelProcessed(msg.id).catch(() => {});
      continue;
    }

    const site = sites.find((s) => s.slug === cls.slug) || null;
    const replyTo = emailOf(msg.from);
    const wasAlreadyKnown = site ? !!(await knownSlugFor(replyTo)) : false;
    if (site) await rememberSender(replyTo, site.slug).catch(() => {});
    // this run is about to try to actually fix it (workOnePendingRevision,
    // below) — so the real estimate is "the next ~10-minute check," not some
    // arbitrary future date. Small buffer so the event lands a beat after
    // this run finishes instead of already being in the past.
    const holdAt = new Date(Date.now() + 10 * 60000);

    let calendarLink = null;
    try {
      const ev = await createCalendarEvent({
        title: `Auto website revision update — ${site ? site.name : 'Unmatched site'}`,
        description:
          `• What: ${cls.summary}\n` +
          `• When: auto-scheduled — the agent works this the moment it's queued, usually within ~10 minutes of the client's email\n\n` +
          `From: ${msg.from}\nSubject: ${msg.subject}\nOriginal: ${msg.snippet}`,
        startAt: holdAt,
        durationMinutes: 10,
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

    // queue it for the agent — this is what actually gets it fixed, not just
    // acknowledged. Sites we couldn't match to a client can't be auto-queued;
    // those stay "needs attention" for Mondo to route by hand.
    let todoId = null;
    if (site) {
      todoId = await addRevisionTodo(site.slug, { title: cls.summary, detail: `Requested by ${msg.from}`, ticketId: msg.id }).catch(() => null);
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
      todoId,
      dueBy: addBusinessDays(PROMISE_BUSINESS_DAYS).getTime(), // the promise made in the auto-reply
      status: todoId ? 'scheduled' : 'needs attention',
    };
    const all = await readArr('revisions:all');
    all.unshift(ticket);
    await store.set('revisions:all', JSON.stringify(all.slice(0, 200)));
    await labelProcessed(msg.id).catch(() => {});
    results.push(ticket);

    // a fresh guess (first time we've ever seen this sender) gets a
    // confirmation email — once they're known, no more of these, ever.
    if (site && !wasAlreadyKnown) await sendGuessConfirmation(ticket, site);
  }

  await store.set('revisions:lastCheck', String(Math.floor(Date.now() / 1000)));

  // did an earlier-queued revision (this run or a past one) actually ship?
  await resolveCompletedTickets(sites).catch(() => {});
  // and use whatever time this run has left to make progress on one that hasn't yet
  let worked = null;
  if (Date.now() - t0 < HARD_LIMIT_MS - 15000) {
    worked = await workOnePendingRevision(sites, t0 + HARD_LIMIT_MS).catch(() => null);
    if (worked) await resolveCompletedTickets(sites).catch(() => {});
  }

  return { ok: true, checked: mail.length, tickets: results.length, results, worked };
}

// For the rare truly-ambiguous email (no company name, no matching domain,
// unknown sender) that came back "Unmatched" — one manual click routes it,
// AND teaches the system that sender for every email after this one.
export async function assignTicketToSite(ticketId, slug) {
  const all = await readArr('revisions:all');
  const t = all.find((x) => x.id === ticketId);
  if (!t) return { ok: false, error: 'ticket not found' };
  const sites = await listSites();
  const site = sites.find((s) => s.slug === slug);
  if (!site) return { ok: false, error: 'unknown site' };
  t.slug = slug;
  t.siteName = site.name;
  t.todoId = await addRevisionTodo(slug, { title: t.summary || t.subject, detail: `Requested by ${t.from}`, ticketId: t.id }).catch(() => null);
  t.status = t.todoId ? 'scheduled' : t.status;
  await store.set('revisions:all', JSON.stringify(all));
  await rememberSender(emailOf(t.from), slug).catch(() => {});
  return { ok: true, ticket: t };
}

// Manual override (the "Mark done" button) — for when Mondo fixed something
// himself outside the agent. Sends the same completion email so the client
// still hears about it either way.
export async function markTicketDone(ticketId) {
  const all = await readArr('revisions:all');
  const t = all.find((x) => x.id === ticketId);
  if (!t) return { ok: false, error: 'ticket not found' };
  if (t.slug) {
    const sites = await listSites();
    const site = sites.find((s) => s.slug === t.slug);
    if (site) t.completionEmail = await sendRevisionCompletedEmail(site, t);
  }
  t.status = 'done';
  t.doneAt = Date.now();
  await store.set('revisions:all', JSON.stringify(all));
  return { ok: true, ticket: t };
}
