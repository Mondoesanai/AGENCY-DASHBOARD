// Inbox -> auto-revision pipeline. Reads Mondo's Info@ inbox (via Gmail),
// classifies each new email cheaply, and for anything that reads as a client
// asking for a site change: replies in-thread within minutes, drops a
// calendar hold, and logs a ticket. Nothing here ever ships a code change by
// itself — that's still the SEO agent's job, triggered separately; this just
// makes sure the client hears back fast and the work is scheduled.
import { store } from './store.js';
import { listNewMail, labelProcessed, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, sendGmailReply, sendGmailMessage, getMyEmailAddress, googleConfigured } from './google.js';
import { listSites, matchExistingSite } from './registry.js';
import { markAiMonth } from './aicost.js';
import { addRevisionTodo, todosState, removeTodo, completeTodo } from './todos.js';
import { runAgentCycle } from './agent.js';
import { commitChangeset } from './github.js';

const MONTH = () => new Date().toISOString().slice(0, 7);
const PROMISE_BUSINESS_DAYS = 3;
const AGENCY_NOTIFY = process.env.AGENCY_NOTIFY_EMAIL || 'info@inspiringwebsites.org';
const CHECK_INTERVAL_MS = 10 * 60000;

// Next 10-min boundary — the same "next check" moment the dashboard shows and
// GitHub Actions' cron targets. Single source of truth for "when will the
// agent actually attempt this," shared by the calendar hold and the ticket's
// own targetAt field so they can never say two different things.
const nextCheckBoundaryMs = () => Math.ceil(Date.now() / CHECK_INTERVAL_MS) * CHECK_INTERVAL_MS;

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
// Cheap sanity check before the client ever hears "it's done" — fetches the
// live page and asks Haiku whether it plausibly reflects the request. Fails
// OPEN on purpose: a flaky fetch or an inconclusive answer never blocks a
// real completion, it only holds back the ones the model actively flags as
// NOT matching. Tracked under the same general-ops bucket as classify()
// (coach:spend), not the site's SEO agent budget — this is QA, not agent work.
async function verifyShippedFix(site, ticket) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: true, verified: null, note: 'skipped — no ANTHROPIC_API_KEY' };
  let html;
  try {
    const r = await fetch(site.url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    html = await r.text();
  } catch (e) {
    return { ok: true, verified: null, note: 'skipped — could not fetch the live site' };
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (e) {
    return { ok: true, verified: null, note: 'skipped — AI SDK unavailable' };
  }
  const client = new Anthropic({ apiKey: key });
  let r;
  try {
    r = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'You are a quick QA check for a web agency. A client asked for a change; a fix was just shipped. Look at the live page text and judge whether it plausibly reflects that request. Return ONLY JSON.',
      messages: [
        {
          role: 'user',
          content: `Client asked for: ${ticket.summary}\n\nLive page text (${site.url}):\n${text}\n\nJSON: {"matches": true|false, "reason": "one short sentence"}`,
        },
      ],
    });
  } catch (e) {
    return { ok: true, verified: null, note: 'skipped — model call failed' };
  }
  const usd = +(((r.usage?.input_tokens || 0) / 1e6) * 1 + ((r.usage?.output_tokens || 0) / 1e6) * 5).toFixed(5);
  await bump(`coach:spend:${MONTH()}`, usd);
  await markAiMonth(MONTH());
  try {
    const raw = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const s = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(s);
    return { ok: true, verified: !!parsed.matches, note: String(parsed.reason || '').slice(0, 200) };
  } catch (e) {
    return { ok: true, verified: null, note: 'skipped — could not read the model response' };
  }
}

// Queue positions shift constantly — a ticket ahead of this one finishes,
// gets cancelled, or a new one jumps in front by arriving first. Re-derive
// each pending ticket's real next-attempt time every check and, if it moved
// by more than 5 minutes, actually move the calendar hold to match — so the
// calendar and the dashboard's "Projected completion" never disagree, and a
// hold that turns out too optimistic (or now-early) gets corrected instead
// of just sitting there wrong.
async function resyncQueue() {
  const all = await readArr('revisions:all');
  const scheduled = all.filter((t) => t.status === 'scheduled').sort((a, b) => a.receivedAt - b.receivedAt);
  let changed = false;
  for (let i = 0; i < scheduled.length; i++) {
    const t = scheduled[i];
    const newTargetAt = nextCheckBoundaryMs() + i * CHECK_INTERVAL_MS;
    if (Math.abs(newTargetAt - (t.targetAt || 0)) > 5 * 60000) {
      if (t.calendarEventId) {
        await updateCalendarEvent(t.calendarEventId, { startAt: new Date(newTargetAt), durationMinutes: 10 }).catch(() => {});
      }
      t.targetAt = newTargetAt;
      changed = true;
    }
  }
  if (changed) await store.set('revisions:all', JSON.stringify(all));
}

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

    const verify = await verifyShippedFix(site, t).catch(() => ({ ok: true, verified: null }));
    t.verify = { verified: verify.verified, note: verify.note, checkedAt: Date.now() };
    if (verify.verified === false) {
      // the model actively thinks the live site doesn't reflect the request —
      // hold the email and surface it for a human look instead of telling the
      // client it's done when it might not be. Stays off the to-do list
      // either way (the agent already shipped something), so it won't loop.
      t.status = 'needs attention';
      changed = true;
      continue;
    }

    const mail = await sendRevisionCompletedEmail(site, t);
    t.status = 'done';
    t.doneAt = Date.now();
    t.completionEmail = mail;
    changed = true;
  }
  if (changed) await store.set('revisions:all', JSON.stringify(all));
}

// Records what actually happened on the ticket itself — so "why hasn't this
// shipped yet" is visible on the dashboard instead of just an ever-drifting
// date. Attached to the first still-scheduled ticket for that site (good
// enough for a diagnostic note; if a site has several queued, they share it).
async function recordAttempt(slug, result) {
  const all = await readArr('revisions:all');
  const t = all.find((x) => x.slug === slug && x.status === 'scheduled');
  if (!t) return;
  const outcome =
    result?.action === 'change'
      ? 'shipped'
      : result?.alreadyRunning
      ? 'already running'
      : result?.skipped
      ? 'not eligible yet'
      : result?.ok === false
      ? 'error'
      : 'no change made';
  t.lastAttempt = { at: Date.now(), outcome, reason: String(result?.reason || result?.error || '').slice(0, 300) || null };
  await store.set('revisions:all', JSON.stringify(all));
}

// Works through sites with a pending revision until the budget runs out or
// one actually ships — NOT just the first site found. A site that can never
// ship (no repo linked, budget used, agent turned off) used to permanently
// block every other site's revision behind it in the list, since the old
// version returned after exactly one attempt no matter the outcome. Now a
// dead end just moves on to the next site instead of stalling the whole
// queue forever.
async function workOnePendingRevision(sites, deadline) {
  let last = null;
  for (const site of sites) {
    if (Date.now() > deadline) break;
    const { current } = await todosState(site).catch(() => ({ current: null }));
    if (!(current?.items || []).some((it) => it.source === 'revision')) continue;
    let result;
    try {
      result = await runAgentCycle(site, { manual: false });
    } catch (e) {
      result = { ok: false, error: String(e.message || e) };
    }
    await recordAttempt(site.slug, result).catch(() => {});
    last = { slug: site.slug, result };
    if (result?.action === 'change') return last; // shipped — resolveCompletedTickets picks this up next
  }
  return last;
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
  // fail CLOSED here on purpose — if we can't positively confirm we got the
  // lock (including a network error on the lock call itself), skip this run
  // rather than risk two runs racing on the same unlabeled email. The next
  // trigger (poll/cron/button) retries within a minute either way.
  const lockSet = await store.set('revisions:lock', String(Date.now()), { nx: true, ex: 120 }).catch(() => null);
  if (!lockSet) return { ok: true, checked: 0, tickets: 0, note: 'another check is already in progress (or the lock could not be confirmed) — skipped, will retry next trigger' };

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
    // check. Three layers, weakest to strongest requirement: (1) exact same
    // Gmail message id, (2) same thread — Gmail can group same-subject
    // messages between the same two people into one conversation without
    // explicit reply headers, so "the same request" can resurface under a
    // message id we haven't seen before, and (3) same sender + same site +
    // near-identical wording within the last hour, which catches the case
    // where Gmail hands back a genuinely different id AND thread for what's
    // functionally a redelivery of the same email (rare, but it's exactly
    // the failure mode (1) and (2) can't see).
    const existingTickets = await readArr('revisions:all');
    const normSummary = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const msgSummaryGuess = normSummary(msg.subject);
    const already = existingTickets.find(
      (t) =>
        t.id === msg.id ||
        (msg.threadId && t.threadId === msg.threadId) ||
        (emailOf(t.from) === emailOf(msg.from) &&
          t.receivedAt &&
          Date.now() - t.receivedAt < 60 * 60000 &&
          normSummary(t.subject) === msgSummaryGuess)
    );
    if (already) {
      await labelProcessed(msg.id).catch(() => {});
      continue;
    }

    const site = sites.find((s) => s.slug === cls.slug) || null;
    const replyTo = emailOf(msg.from);
    const wasAlreadyKnown = site ? !!(await knownSlugFor(replyTo)) : false;
    if (site) await rememberSender(replyTo, site.slug).catch(() => {});
    // Real, queue-aware estimate: only one pending revision gets worked per
    // check, oldest first, so a ticket sitting behind N others has to wait
    // through N more checks. This is the same math the dashboard shows as
    // "Projected completion" and resyncQueue() below keeps both in sync as
    // the queue shifts (someone else finishes, gets cancelled, etc).
    const aheadInQueue = existingTickets.filter((t) => t.status === 'scheduled').length;
    const holdAt = new Date(nextCheckBoundaryMs() + aheadInQueue * CHECK_INTERVAL_MS);

    let calendarLink = null;
    let calendarEventId = null;
    try {
      const ev = await createCalendarEvent({
        title: `Auto website revision update — ${site ? site.name : 'Unmatched site'}`,
        description:
          `• What: ${cls.summary}\n` +
          `• When: auto-scheduled for the agent's next chance to work it${aheadInQueue ? ` — ${aheadInQueue} request${aheadInQueue === 1 ? '' : 's'} ahead of this one right now` : ''}. This moves automatically if the queue changes.\n\n` +
          `From: ${msg.from}\nSubject: ${msg.subject}\nOriginal: ${msg.snippet}`,
        startAt: holdAt,
        durationMinutes: 10,
      });
      calendarLink = ev.htmlLink;
      calendarEventId = ev.id;
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
      threadId: msg.threadId || null,
      slug: site?.slug || null,
      siteName: site?.name || 'Unmatched site',
      from: msg.from,
      subject: msg.subject,
      summary: cls.summary,
      receivedAt: Date.now(),
      repliedAt,
      calendarLink,
      calendarEventId,
      todoId,
      targetAt: holdAt.getTime(), // the real next-attempt time — same moment the calendar hold is on
      dueBy: addBusinessDays(PROMISE_BUSINESS_DAYS).getTime(), // the conservative promise made in the auto-reply email, not shown as the headline date on the dashboard
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
  // and use whatever time this run has left to make progress on one that
  // hasn't yet — but only START a cycle with real room to finish. A full
  // cycle (repo read, planning call, sometimes a retry, commit) realistically
  // needs 30+ seconds; starting one with only a few seconds of nominal
  // budget left all but guarantees Vercel's hard function ceiling kills it
  // mid-flight, which leaves the site's running-flag stuck (see agent.js's
  // RUNNING_TTL) instead of anything actually shipping. Safer to skip this
  // check and let the next one — which starts with a full fresh budget —
  // take it, than to start something doomed to get killed.
  let worked = null;
  if (Date.now() - t0 < HARD_LIMIT_MS - 35000) {
    worked = await workOnePendingRevision(sites, t0 + HARD_LIMIT_MS).catch(() => null);
    if (worked) await resolveCompletedTickets(sites).catch(() => {});
  }
  // queue positions just shifted (something completed, or a new one joined
  // above) — keep every remaining hold's date honest.
  await resyncQueue().catch(() => {});

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
// still hears about it either way, and — since the agent didn't ship it and
// so resolveCompletedTickets() will never see the to-do disappear on its own
// — clears the to-do itself so it doesn't sit there telling the agent to
// keep working something that's already handled.
export async function markTicketDone(ticketId) {
  const all = await readArr('revisions:all');
  const t = all.find((x) => x.id === ticketId);
  if (!t) return { ok: false, error: 'ticket not found' };
  if (t.slug) {
    const sites = await listSites();
    const site = sites.find((s) => s.slug === t.slug);
    if (site) {
      t.completionEmail = await sendRevisionCompletedEmail(site, t);
      t.siteUrl = site.url || null;
    }
    if (t.todoId) await completeTodo(t.slug, t.todoId).catch(() => {});
  }
  t.status = 'done';
  t.doneAt = Date.now();
  await store.set('revisions:all', JSON.stringify(all));
  return { ok: true, ticket: t };
}

// The "Cancel" button — for a duplicate, a mistake, or a request that turned
// out not to be needed. Unlike Mark done: no completion email (nothing was
// actually done), pulls the to-do so the agent stops working it, and cancels
// the calendar hold. Still lands in "past revisions" so it's not just gone.
export async function cancelTicket(ticketId) {
  const all = await readArr('revisions:all');
  const t = all.find((x) => x.id === ticketId);
  if (!t) return { ok: false, error: 'ticket not found' };
  if (t.slug && t.todoId) await removeTodo(t.slug, t.todoId).catch(() => {});
  if (t.calendarEventId) await deleteCalendarEvent(t.calendarEventId).catch(() => {});
  t.status = 'cancelled';
  t.doneAt = Date.now();
  await store.set('revisions:all', JSON.stringify(all));
  return { ok: true, ticket: t };
}
