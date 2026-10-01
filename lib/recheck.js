// R5.9 — periodic website rechecks.
//
// A business we looked at months ago may have built a site, let one lapse, or
// had one break. That is genuinely useful to know. It is also the single most
// tempting place to put an automatic message, which is why the requirement says
// a recheck creates an INTERNAL OPPORTUNITY and not a message.
//
// Three rules keep it honest:
//
//   MATERIAL CHANGE  — only a transition that changes what is true about them
//                      counts. A flaky fetch, or anything involving the
//                      "uncertain" state, is noise and must not create work.
//   COOLDOWN         — a change is not a licence to write to someone we
//                      contacted last week. The opportunity still gets created
//                      (we want to know), but it is marked not-contactable with
//                      the date it becomes contactable.
//   PERMISSION       — an opportunity never implies consent. Whether we may
//                      write is still decided by the normal consent gate at
//                      send time, not here.
//
// Nothing in this file sends anything, and nothing in it can.

import { store } from './store.js';
import { verifyWebsite, WEB_STATUS, getProspect, updateProspect, listProspects } from './discovery.js';

/** Days before a contacted prospect may be approached again about a change. */
export const DEFAULT_COOLDOWN_DAYS = 60;

/** Minimum gap between rechecks of the same business. */
export const DEFAULT_RECHECK_DAYS = 90;

export const CHANGE = Object.freeze({
  BUILT_A_SITE: 'built-a-site', // nothing found before, a working site now
  SITE_WENT_DOWN: 'site-went-down', // worked before, does not load now
  SITE_CAME_BACK: 'site-came-back', // did not load before, works now
  SITE_DISAPPEARED: 'site-disappeared', // worked before, nothing linked now
  NONE: 'no-material-change',
});

/**
 * Was the difference between two verified states worth acting on?
 *
 * `uncertain` is deliberately inert in BOTH directions. It means "we could not
 * tie a page to this business", which is a statement about our confidence, not
 * about them — so moving into or out of it is not news about the business.
 */
export function materialChange(before, after) {
  const b = before?.status;
  const a = after?.status;
  if (!b || !a || b === a) return { material: false, change: CHANGE.NONE, reason: b === a ? 'status unchanged' : 'no previous status to compare' };
  if (b === WEB_STATUS.UNCERTAIN || a === WEB_STATUS.UNCERTAIN) {
    return { material: false, change: CHANGE.NONE, reason: 'an uncertain reading says something about our confidence, not about the business' };
  }

  if (b === WEB_STATUS.NOT_LINKED && a === WEB_STATUS.PRESENT) {
    return { material: true, change: CHANGE.BUILT_A_SITE, reason: 'no website was found before; there is a working one now' };
  }
  if (b === WEB_STATUS.PRESENT && a === WEB_STATUS.INACCESSIBLE) {
    return { material: true, change: CHANGE.SITE_WENT_DOWN, reason: 'their website worked before and does not load now' };
  }
  if (b === WEB_STATUS.INACCESSIBLE && a === WEB_STATUS.PRESENT) {
    return { material: true, change: CHANGE.SITE_CAME_BACK, reason: 'their website was down before and works now' };
  }
  if (b === WEB_STATUS.PRESENT && a === WEB_STATUS.NOT_LINKED) {
    return { material: true, change: CHANGE.SITE_DISAPPEARED, reason: 'a website was verified before and none is linked now' };
  }
  if (b === WEB_STATUS.NOT_LINKED && a === WEB_STATUS.INACCESSIBLE) {
    // they listed a site that does not work — new information, but weak
    return { material: true, change: CHANGE.SITE_WENT_DOWN, reason: 'a website is listed now, but it does not load' };
  }
  return { material: false, change: CHANGE.NONE, reason: `transition ${b} → ${a} is not treated as material` };
}

/** Does a change mean we should STOP approaching them on the old premise? */
export function invalidatesPremise(change) {
  // If they now have a working site, a "couldn't find a website" approach is no
  // longer true, and continuing it would be the exact dishonesty this system
  // exists to prevent.
  return change === CHANGE.BUILT_A_SITE || change === CHANGE.SITE_CAME_BACK;
}

const OPP = (id) => `opportunity:${id}`;
const OPP_INDEX = 'opportunities:open';

/**
 * Create the internal record. Deliberately returns an object with no message,
 * no recipient and no send path — there is nothing here to accidentally post.
 */
export async function createOpportunity(prospect, verdict, { cooldownDays = DEFAULT_COOLDOWN_DAYS, now = Date.now() } = {}) {
  const lastContacted = Number(prospect.lastContactedAt) || 0;
  const cooldownUntil = lastContacted ? lastContacted + cooldownDays * 86400000 : 0;
  const inCooldown = cooldownUntil > now;

  const id = `${prospect.id}:${verdict.change}:${new Date(now).toISOString().slice(0, 10)}`;
  const opportunity = {
    id,
    prospectId: prospect.id,
    business: prospect.name,
    change: verdict.change,
    reason: verdict.reason,
    observedAt: now,
    // the three things that decide whether a human may act on this
    contactable: !inCooldown,
    cooldownUntil: inCooldown ? cooldownUntil : null,
    blockedBy: inCooldown
      ? `contacted ${Math.round((now - lastContacted) / 86400000)} days ago; the ${cooldownDays}-day cooldown runs until ${new Date(cooldownUntil).toISOString().slice(0, 10)}`
      : null,
    // explicit, so nobody reading this record mistakes it for permission
    permissionNote: 'This is an internal note. Whether anyone may be contacted is decided by the consent gate at send time, not here.',
    premiseInvalidated: invalidatesPremise(verdict.change),
    status: 'open',
  };
  await store.set(OPP(id), JSON.stringify(opportunity));
  await store.sadd(OPP_INDEX, id);
  return opportunity;
}

export async function listOpportunities({ limit = 100 } = {}) {
  const ids = await store.smembers(OPP_INDEX).catch(() => []);
  const out = [];
  for (const id of ids.slice(0, limit)) {
    const raw = await store.get(OPP(id)).catch(() => null);
    if (!raw) continue;
    try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { /* skip */ }
  }
  return out.sort((a, b) => b.observedAt - a.observedAt);
}

export async function resolveOpportunity(id, outcome = 'actioned') {
  const raw = await store.get(OPP(id)).catch(() => null);
  if (!raw) return null;
  const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
  o.status = 'resolved';
  o.outcome = outcome;
  o.resolvedAt = Date.now();
  await store.set(OPP(id), JSON.stringify(o));
  await store.srem(OPP_INDEX, id);
  return o;
}

/**
 * Recheck one prospect. Returns what it saw and what it created — never a
 * message, and never a send.
 */
export async function recheckProspect(prospectId, { fetchImpl = globalThis.fetch, now = Date.now(), cooldownDays = DEFAULT_COOLDOWN_DAYS, recheckDays = DEFAULT_RECHECK_DAYS, force = false } = {}) {
  const p = await getProspect(prospectId);
  if (!p) return { ok: false, reason: 'unknown prospect' };

  const since = now - (Number(p.web?.checkedAt) || 0);
  if (!force && p.web?.checkedAt && since < recheckDays * 86400000) {
    return { ok: true, skipped: true, reason: `checked ${Math.round(since / 86400000)} days ago; rechecks are ${recheckDays} days apart` };
  }

  const before = p.web || null;
  const after = await verifyWebsite(p, { fetchImpl });
  const verdict = materialChange(before, after);

  await updateProspect(prospectId, { web: after, previousWeb: before || null });

  if (!verdict.material) {
    return { ok: true, changed: false, change: verdict.change, reason: verdict.reason, opportunity: null };
  }

  const opportunity = await createOpportunity({ ...p, id: prospectId }, verdict, { cooldownDays, now });
  return { ok: true, changed: true, change: verdict.change, reason: verdict.reason, opportunity, sent: false };
}

/**
 * A bounded sweep for the scheduled tick. Caps the work so a recheck pass can
 * never become an unbounded crawl, and reports what it refused.
 */
export async function runRecheckSweep({ max = 10, fetchImpl = globalThis.fetch, now = Date.now(), ...opts } = {}) {
  const all = await listProspects({ limit: 500 });
  const results = { checked: 0, skipped: 0, changes: [], opportunities: 0 };
  for (const p of all) {
    if (results.checked >= max) break;
    const r = await recheckProspect(p.id, { fetchImpl, now, ...opts });
    if (!r.ok) continue;
    if (r.skipped) { results.skipped++; continue; }
    results.checked++;
    if (r.changed) {
      results.changes.push({ business: p.name, change: r.change, contactable: r.opportunity.contactable });
      results.opportunities++;
    }
  }
  results.note = 'Rechecks create internal opportunities only. Nothing here contacts anyone.';
  return results;
}
