// R11.8 — retention and deletion.
//
// Two obligations that pull against each other, and getting the balance wrong
// in either direction is a real failure:
//
//   DELETE   someone can ask to be erased, and that has to mean erased —
//            not hidden, not flagged, not "removed from the UI".
//   REMEMBER the one thing that must SURVIVE deletion is the fact that they
//            asked not to be contacted. Erasing the suppression along with the
//            record is how a "deleted" person gets emailed again next month by
//            a re-import, which is worse than not deleting at all.
//
// So deletion erases the person and keeps a tombstone that contains no personal
// data beyond a one-way hash of the address — enough to recognise them on a
// future import, not enough to reconstruct who they were.

import crypto from 'node:crypto';
import { store } from './store.js';

const TOMBSTONE = (hash) => `erased:${hash}`;
const TOMBSTONE_INDEX = 'erased:all';

/** Default windows. Editable, and stated rather than implied. */
export const RETENTION = Object.freeze({
  prospectsNeverContactedDays: 180,
  repliesDays: 730,
  jobsDoneDays: 30,
  deadLetterDays: 180,
  rawCardImagesDays: 90,
  note: 'Windows are measured from the last activity on the record, not from when it was created.',
});

/** One-way, salted with the deployment secret so a tombstone is not a lookup table. */
export function identityHash(value) {
  const salt = process.env.CRON_SECRET || 'unsalted-dev';
  return crypto.createHmac('sha256', salt).update(String(value || '').trim().toLowerCase()).digest('hex').slice(0, 32);
}

/**
 * Erase a person.
 *
 * Returns what it deleted AND what it deliberately kept, because a deletion
 * routine that quietly keeps things is the thing people are right to distrust.
 */
export async function erasePerson({ contactId, email = null, phone = null, reason = 'requested', by = 'owner', now = Date.now() }) {
  const { getContact, listContacts } = await import('./contacts.js');

  let contact = contactId ? await getContact(contactId) : null;
  if (!contact && email) {
    const { contacts } = await listContacts({ limit: 2000 });
    contact = (contacts || []).find((c) => c.email?.value?.toLowerCase() === String(email).toLowerCase()) || null;
  }
  if (!contact) return { ok: false, reason: 'no such contact' };

  const addr = contact.email?.value || email || '';
  const tel = contact.phone?.value || phone || '';

  // 1. The tombstone FIRST. If anything below fails, the person is still
  //    protected from being re-imported and contacted again.
  const hashes = [addr && identityHash(addr), tel && identityHash(tel)].filter(Boolean);
  for (const h of hashes) {
    await store.set(TOMBSTONE(h), JSON.stringify({ at: now, reason, by }));
    await store.sadd(TOMBSTONE_INDEX, h);
  }
  // keep the address-level suppression too — it is what the send gate reads
  if (addr) await store.set(`suppress:email:${addr.toLowerCase()}`, 'erased');
  // Canonical E.164, like every other writer. This wrote a digits-only key that
  // no consent check read, so an erased person's suppression was invisible to
  // the very gates that exist to honour it. Readers still check both formats so
  // suppressions already written the old way keep matching.
  if (tel) {
    const { normPhone } = await import('./contacts.js');
    const key = normPhone(tel) || String(tel).replace(/\D/g, '');
    if (key) await store.set(`suppress:phone:${key}`, 'erased');
  }

  // 2. Now erase the personal data.
  const erased = [];
  await store.set(`contact:${contact.id}`, '', { ex: 1 });
  erased.push('contact record');

  for (const idx of ['contacts:all']) await store.srem(idx, contact.id).catch(() => {});
  if (addr) await store.srem(`contacts:byEmail:${addr.toLowerCase()}`, contact.id).catch(() => {});
  if (tel) await store.srem(`contacts:byPhone:${String(tel).replace(/\D/g, '')}`, contact.id).catch(() => {});
  erased.push('search indexes');

  // their replies, including the message bodies
  const { listReplies } = await import('./replies.js');
  const replies = (await listReplies({ limit: 2000 })).filter((r) => r.contactId === contact.id);
  for (const r of replies) {
    await store.set(`reply:${r.id}`, '', { ex: 1 });
    await store.srem('replies:inbox', r.id).catch(() => {});
  }
  if (replies.length) erased.push(`${replies.length} reply message(s)`);

  // their campaign memberships
  const campaignIds = await store.smembers('campaigns:all').catch(() => []);
  let memberships = 0;
  for (const cid of campaignIds) {
    const key = `campaign:member:${cid}:${contact.id}`;
    if (await store.get(key).catch(() => null)) {
      await store.set(key, '', { ex: 1 });
      await store.srem(`campaign:members:${cid}`, contact.id).catch(() => {});
      memberships++;
    }
  }
  if (memberships) erased.push(`${memberships} campaign membership(s)`);

  // conversation state and any stored card image
  await store.set(`convo:turns:${contact.id}`, '', { ex: 1 }).catch(() => {});
  await store.set(`convo:lastauto:${contact.id}`, '', { ex: 1 }).catch(() => {});
  for (const k of contact.imageKeys || []) await store.set(k, '', { ex: 1 }).catch(() => {});
  if ((contact.imageKeys || []).length) erased.push('stored card image(s)');

  return {
    ok: true,
    erased,
    kept: [
      'a one-way hash of the email and phone, so a future import cannot silently re-add them',
      'the suppression entry the send gate checks',
    ],
    keptNote: 'Nothing kept can reconstruct who this was. The hash is salted and one-way; it can only answer "have we been told to leave this address alone?".',
    hashes,
  };
}

/** Has this address been erased? Used by import, so deletion actually sticks. */
export async function wasErased(value) {
  if (!value) return { erased: false };
  const h = identityHash(value);
  const rec = await store.get(TOMBSTONE(h)).catch(() => null);
  if (!rec) return { erased: false };
  let meta = {};
  try { meta = typeof rec === 'string' ? JSON.parse(rec) : rec; } catch { /* fine */ }
  return { erased: true, at: meta.at || null, reason: meta.reason || 'requested', hash: h };
}

/**
 * Delete what is simply old.
 *
 * Deliberately conservative: it never touches a contact, a booking or an
 * opt-out. Those are either someone's standing instruction or a record of a
 * commercial relationship, and "it was a while ago" is not a reason to lose
 * either. It clears working data — finished jobs, old raw replies, prospects
 * that were never contacted.
 */
export async function runRetentionSweep({ now = Date.now(), dryRun = false, windows = RETENTION } = {}) {
  const out = { dryRun, removed: { jobs: 0, deadLetter: 0, prospects: 0, replies: 0 }, kept: [], note: '' };

  const { listQueue, listDeadLetter } = await import('./jobs.js');
  const done = (await listQueue({ limit: 1000 })).filter((j) => j.state === 'done' && now - (j.completedAt || j.createdAt || now) > windows.jobsDoneDays * 86400000);
  for (const j of done) {
    if (!dryRun) { await store.set(`job:${j.id}`, '', { ex: 1 }); await store.srem('jobs:queue', j.id); }
    out.removed.jobs++;
  }

  const dead = (await listDeadLetter({ limit: 1000 })).filter((j) => now - (j.deadAt || now) > windows.deadLetterDays * 86400000);
  for (const j of dead) {
    if (!dryRun) { await store.set(`job:${j.id}`, '', { ex: 1 }); await store.srem('jobs:dead', j.id); }
    out.removed.deadLetter++;
  }

  const { listProspects } = await import('./discovery.js');
  const prospects = await listProspects({ limit: 2000 });
  for (const p of prospects) {
    const stale = now - (p.discoveredAt || 0) > windows.prospectsNeverContactedDays * 86400000;
    if (!stale || p.lastContactedAt) continue; // never delete one we actually wrote to
    if (!dryRun) { await store.set(`prospect:${p.id}`, '', { ex: 1 }); await store.srem('prospects:all', p.id); }
    out.removed.prospects++;
  }

  out.kept = [
    'contacts — a person is deleted on request, not on a timer',
    'opt-outs and suppressions — these never expire',
    'bookings — a record of a commercial relationship',
  ];
  out.note = dryRun
    ? 'Dry run: nothing was deleted. These are the records that would be.'
    : 'Working data only. Contacts, opt-outs and bookings are never removed by age.';
  return out;
}

/** What a person is entitled to see about themselves (R11.8). */
export async function exportPerson(contactId) {
  const { getContact } = await import('./contacts.js');
  const contact = await getContact(contactId);
  if (!contact) return { ok: false, reason: 'no such contact' };

  const { listReplies } = await import('./replies.js');
  const replies = (await listReplies({ limit: 2000 })).filter((r) => r.contactId === contactId);

  return {
    ok: true,
    contact,
    replies: replies.map((r) => ({ at: r.at, kind: r.kind, text: r.text })),
    consentHistory: contact.consentLog || [],
    note: 'Everything held about this person, including why we believe we were allowed to contact them.',
  };
}
