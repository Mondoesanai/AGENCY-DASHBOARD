// Look for the file before asking the client for it.
//
// WHY: "we need a logo from you" is sometimes true and is often just a failure
// to look. On Isha Lo's CPD request the agent asked for a logo it did not
// have — and the owner had already supplied one. It cost four days and a round
// trip, and it happened again inside the same session when a file was searched
// for in one folder and reported missing while it sat in another.
//
// So the ask is now the LAST step, not the first. Order matters: cheapest and
// most authoritative first.
//
//   1. the client's own email attachments on this ticket — they may have sent
//      it with the request and nobody looked
//   2. the site's own repository — a previous request may have added it, or it
//      may be sitting unused under a different name
//   3. the agency's brand_assets folder for that client, if one exists
//   4. an official source, which is a NETWORK fetch of a named URL and is
//      deliberately NOT guesswork — see the note on sources below
//   5. only then, ask the client
//
// ON OFFICIAL SOURCES. This will fetch a URL that a person or an explicit
// registry supplied for that asset. It will not search the web and pick
// something that looks right: an accreditation mark taken off an unrelated
// page is how a client ends up displaying a logo they are not entitled to, and
// a near-miss is worse than a blank because nobody checks it again. Where no
// authorised source is on file, this reports `needsClient` rather than
// improvising, and that is the correct outcome, not a limitation to route
// around.

import { store } from './store.js';

/** Where a found asset came from, in descending order of authority. */
export const SOURCE = Object.freeze({
  ATTACHMENT: 'client-attachment',
  REPO: 'site-repository',
  BRAND: 'agency-brand-assets',
  OFFICIAL: 'official-source',
});

const IMAGE_RE = /\.(png|jpe?g|svg|webp|gif|avif)$/i;

/** Words that make a filename plausibly the thing being asked for. */
function keywordsOf(need) {
  return String(need || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 8);
}
const STOP = new Set([
  'the', 'and', 'for', 'add', 'official', 'logo', 'image', 'file', 'photo', 'please',
  'need', 'needs', 'their', 'this', 'that', 'with', 'from', 'section', 'page', 'site',
]);

/** How well a filename matches what we are looking for. 0 = no match. */
export function scoreName(filename, need) {
  const f = String(filename || '').toLowerCase();
  if (!f) return 0;
  const words = keywordsOf(need);
  if (!words.length) return 0;
  let hits = 0;
  for (const w of words) if (f.includes(w)) hits++;
  // a bare "logo.png" is a weak but real signal when the ask is about a logo
  const generic = /\b(logo|badge|seal|mark|accredit)/.test(f) && /logo|badge|seal|mark|accredit/.test(String(need).toLowerCase());
  return hits + (generic ? 0.5 : 0);
}

/**
 * Search everywhere we are allowed to look, in order, and stop at the first
 * confident hit.
 *
 * Returns `{found:false, needsClient:true, searched:[...]}` when nothing turns
 * up — and the list of what was actually searched, because "we looked" is a
 * claim that should be checkable.
 */
export async function findAsset(need, { ticket = null, site = null, listRepoFiles = null, fetchUrl = null, officialSources = null } = {}) {
  const searched = [];
  const candidates = [];

  // 1. the client's own attachments on this ticket
  const atts = ticket?.attachments || ticket?.attachmentNames || [];
  searched.push({ where: SOURCE.ATTACHMENT, count: atts.length });
  for (const a of atts) {
    const name = typeof a === 'string' ? a : a?.filename || a?.name || '';
    if (!IMAGE_RE.test(name)) continue;
    const s = scoreName(name, need);
    if (s > 0) candidates.push({ source: SOURCE.ATTACHMENT, name, score: s + 1, ref: a });
  }

  // 2. the site's own repository
  if (typeof listRepoFiles === 'function' && site?.repo) {
    let files = [];
    try { files = (await listRepoFiles(site.repo)) || []; } catch { files = []; }
    searched.push({ where: SOURCE.REPO, count: files.length });
    for (const f of files) {
      const name = typeof f === 'string' ? f : f?.path || '';
      if (!IMAGE_RE.test(name)) continue;
      const s = scoreName(name, need);
      if (s > 0) candidates.push({ source: SOURCE.REPO, name, score: s, ref: f });
    }
  } else {
    searched.push({ where: SOURCE.REPO, skipped: site?.repo ? 'no file lister supplied' : 'no repository linked' });
  }

  // 3. anything the agency already holds for this client
  try {
    const raw = await store.get(`brand:assets:${site?.slug || ''}`);
    const held = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    searched.push({ where: SOURCE.BRAND, count: Array.isArray(held) ? held.length : 0 });
    for (const f of Array.isArray(held) ? held : []) {
      const name = f?.name || f?.path || String(f || '');
      const s = scoreName(name, need);
      if (s > 0) candidates.push({ source: SOURCE.BRAND, name, score: s, ref: f });
    }
  } catch {
    searched.push({ where: SOURCE.BRAND, skipped: 'could not be read' });
  }

  // 4. an authorised official source — a named URL, never a web search
  const sources = officialSources || (await readOfficialSources(site?.slug));
  const match = (sources || []).find((s) => scoreName(s.for || '', need) > 0 || scoreName(need, s.for || '') > 0);
  if (match && typeof fetchUrl === 'function') {
    searched.push({ where: SOURCE.OFFICIAL, url: match.url });
    try {
      const got = await fetchUrl(match.url);
      if (got && got.ok) candidates.push({ source: SOURCE.OFFICIAL, name: match.url, score: 99, ref: got });
    } catch { /* an unreachable source is not a found asset */ }
  } else {
    searched.push({ where: SOURCE.OFFICIAL, skipped: match ? 'no fetcher supplied' : 'no authorised source on file for this asset' });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    return {
      found: false,
      needsClient: true,
      searched,
      ask: `We could not find this anywhere we hold, so it has to come from them: ${String(need).slice(0, 160)}`,
    };
  }
  return { found: true, needsClient: false, asset: candidates[0], alternatives: candidates.slice(1, 4), searched };
}

/** URLs a person has explicitly authorised as the source for a given asset. */
export async function readOfficialSources(slug) {
  try {
    const raw = await store.get(`assets:sources:${slug || ''}`);
    const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Record a source for an asset. Explicit, per client, and never inferred —
 * this is the gate that keeps step 4 from becoming "find something that looks
 * like the logo".
 */
export async function addOfficialSource(slug, { url, for: forWhat, addedBy = 'owner' }) {
  if (!url || !/^https:\/\//i.test(url)) return { ok: false, error: 'an official source must be an https URL' };
  if (!forWhat) return { ok: false, error: 'say which asset this is the source for' };
  const list = await readOfficialSources(slug);
  list.push({ url, for: String(forWhat).slice(0, 160), addedBy, at: Date.now() });
  await store.set(`assets:sources:${slug}`, JSON.stringify(list.slice(-20)));
  return { ok: true, count: list.length };
}

/**
 * Has a file we were waiting on turned up since we last looked?
 *
 * This is what makes "resume automatically" real: a blocked requirement is
 * re-searched, and if the asset now exists the ticket goes back in the queue
 * without anyone remembering to do it.
 */
export async function recheckBlockedAssets(tickets, opts = {}) {
  const resumed = [];
  for (const t of tickets || []) {
    const reqs = (t.requirements || []).filter((r) => r.state === 'outstanding');
    if (!reqs.length) continue;
    for (const r of reqs) {
      const hit = await findAsset(r.text, { ticket: t, site: opts.siteFor ? opts.siteFor(t) : null, ...opts });
      if (hit.found) {
        r.state = 'pending';
        r.note = `found in ${hit.asset.source}: ${hit.asset.name}`;
        resumed.push({ ticketId: t.id, requirementId: r.id, source: hit.asset.source, name: hit.asset.name });
      }
    }
  }
  return { ok: true, resumed, count: resumed.length };
}
