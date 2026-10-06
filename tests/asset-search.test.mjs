// Look before asking.
//
// "We need a logo from you" is sometimes true and is often just a failure to
// look. Isha Lo was asked for a logo she had already supplied; it cost four
// days. Inside the same session a file was declared missing while sitting in
// a folder that had not been checked.
//
// The ask is the last step. These checks cover the order, and the refusal to
// improvise when no authorised source exists.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { findAsset, scoreName, addOfficialSource, readOfficialSources, recheckBlockedAssets, SOURCE } from '../lib/asset-search.js';

const NEED = 'add the official CPD Standards Office accreditation logo image';

// ---------------------------------------------------------------------------
section('A1  a filename is matched on what the ask is about');
check('an exact-ish name scores', scoreName('cpd-accredited.png', NEED) > 0, String(scoreName('cpd-accredited.png', NEED)));
check('a generic logo name scores for a logo ask', scoreName('logo.png', NEED) > 0);
check('an unrelated photo does not', scoreName('team-photo-gina.jpg', NEED) === 0, String(scoreName('team-photo-gina.jpg', NEED)));
check('a better match outscores a worse one',
  scoreName('cpd-accreditation-logo.svg', NEED) > scoreName('logo.png', NEED));
check('an empty name is not a match', scoreName('', NEED) === 0);
check('an empty need is not a match', scoreName('cpd.png', '') === 0);

// ---------------------------------------------------------------------------
section('A2  the client may have already sent it');
let r = await findAsset(NEED, {
  ticket: { attachments: [{ filename: 'notes.pdf' }, { filename: 'cpd-accredited.png' }] },
});
check('it is found', r.found === true, JSON.stringify(r.searched));
check('from the attachment', r.asset.source === SOURCE.ATTACHMENT, r.asset.source);
check('the client is NOT asked', r.needsClient === false);
check('and the right file was picked', r.asset.name === 'cpd-accredited.png');
check('a non-image attachment is ignored', !r.alternatives.some((a) => /\.pdf$/.test(a.name)));

// ---------------------------------------------------------------------------
section('A3  then the site\'s own repository');
r = await findAsset(NEED, {
  ticket: { attachments: [] },
  site: { slug: 'lo-down', repo: 'Mondoesanai/TheLoDownWithIshaLo' },
  listRepoFiles: async () => ['index.html', 'images/isha-portrait.jpg', 'images/cpd-accredited.png'],
});
check('it is found in the repo', r.found === true);
check('from the repository', r.asset.source === SOURCE.REPO, r.asset.source);
check('the repo was really searched', r.searched.some((s) => s.where === SOURCE.REPO && s.count === 3));

check('an attachment still wins over the repo',
  (await findAsset(NEED, {
    ticket: { attachments: [{ filename: 'cpd-logo.png' }] },
    site: { slug: 'x', repo: 'a/b' },
    listRepoFiles: async () => ['images/cpd-accredited.png'],
  })).asset.source === SOURCE.ATTACHMENT, 'the client\'s own file is the most authoritative');

// ---------------------------------------------------------------------------
section('A4  then what the agency already holds');
await store.set('brand:assets:lo-down', JSON.stringify([{ name: 'cpd-accredited-logo.png' }, { name: 'random.jpg' }]));
r = await findAsset(NEED, { ticket: { attachments: [] }, site: { slug: 'lo-down' } });
check('it is found in brand assets', r.found === true, JSON.stringify(r.searched));
check('from the agency store', r.asset.source === SOURCE.BRAND, r.asset.source);
await store.set('brand:assets:lo-down', JSON.stringify([]));

// ---------------------------------------------------------------------------
section('A5  an official source is a named URL, never a guess');
r = await findAsset(NEED, { ticket: { attachments: [] }, site: { slug: 'lo-down' } });
check('with no source on file nothing is fetched', r.found === false);
check('and it says exactly why', r.searched.some((s) => s.where === SOURCE.OFFICIAL && /no authorised source/.test(s.skipped || '')),
  JSON.stringify(r.searched.find((s) => s.where === SOURCE.OFFICIAL)));
check('so the client IS asked', r.needsClient === true);
check('with a usable sentence', /has to come from them/.test(r.ask), r.ask);

check('a source must be https', (await addOfficialSource('lo-down', { url: 'http://x.test/l.png', for: 'cpd logo' })).ok === false);
check('a source must say what it is for', (await addOfficialSource('lo-down', { url: 'https://x.test/l.png' })).ok === false);
check('a proper one is accepted', (await addOfficialSource('lo-down', { url: 'https://cpd.test/accredited-logo.png', for: 'CPD accreditation logo' })).ok === true);
check('and is readable back', (await readOfficialSources('lo-down')).length === 1);

let fetched = [];
r = await findAsset(NEED, {
  ticket: { attachments: [] },
  site: { slug: 'lo-down' },
  fetchUrl: async (u) => { fetched.push(u); return { ok: true, bytes: 1234 }; },
});
check('now the authorised URL is fetched', fetched.length === 1 && /cpd\.test/.test(fetched[0]), JSON.stringify(fetched));
check('and the asset is found', r.found === true && r.asset.source === SOURCE.OFFICIAL);
check('an unreachable source is not a found asset',
  (await findAsset(NEED, { ticket: { attachments: [] }, site: { slug: 'lo-down' }, fetchUrl: async () => { throw new Error('502'); } })).found === false);
await store.set('assets:sources:lo-down', JSON.stringify([]));

// ---------------------------------------------------------------------------
section('A6  what was searched is reported, so "we looked" is checkable');
r = await findAsset(NEED, { ticket: { attachments: [] }, site: { slug: 'nope' } });
for (const w of [SOURCE.ATTACHMENT, SOURCE.REPO, SOURCE.BRAND, SOURCE.OFFICIAL])
  check(`${w} is accounted for`, r.searched.some((s) => s.where === w), JSON.stringify(r.searched));
check('a site with no repo says so rather than claiming it searched',
  /no repository linked/.test(r.searched.find((s) => s.where === SOURCE.REPO)?.skipped || ''));

// ---------------------------------------------------------------------------
section('A7  work resumes by itself when the file turns up');
const tickets = [{
  id: 't1',
  attachments: [],
  requirements: [
    { id: 'r1', text: 'change the hours to 12 CPD hours', state: 'done' },
    { id: 'r2', text: 'add the official CPD accreditation logo image', state: 'outstanding', note: 'needs a file from the client' },
  ],
}];
let res = await recheckBlockedAssets(tickets, { siteFor: () => ({ slug: 'lo-down' }) });
check('nothing resumes while the file is still missing', res.count === 0, JSON.stringify(res));
check('and the item stays outstanding', tickets[0].requirements[1].state === 'outstanding');

tickets[0].attachments = [{ filename: 'cpd-accredited.png' }];
res = await recheckBlockedAssets(tickets, { siteFor: () => ({ slug: 'lo-down' }) });
check('it resumes once the file arrives', res.count === 1, JSON.stringify(res));
check('the item goes back to pending, not straight to done', tickets[0].requirements[1].state === 'pending',
  'arriving is not the same as applied');
check('and records where it came from', /client-attachment/.test(tickets[0].requirements[1].note), tickets[0].requirements[1].note);
check('a done item is left alone', tickets[0].requirements[0].state === 'done');

check('a ticket with nothing outstanding is skipped',
  (await recheckBlockedAssets([{ id: 't2', requirements: [{ id: 'a', state: 'done', text: 'x' }] }])).count === 0);
check('no tickets at all is survivable', (await recheckBlockedAssets([])).count === 0);
check('undefined is survivable', (await recheckBlockedAssets(undefined)).count === 0);

// ---------------------------------------------------------------------------
section('A8  with no URL on file, the organisation is researched before anyone is asked');
const officialSearch = async () => ([{ url: 'https://cpdstandards.com/brand-resources', title: 'Brand resources' }]);

// terms permit an accredited party, and this client's entitlement is on file
let found = await findAsset('official CPD Standards Office accreditation logo', {
  ticket: { attachments: [] },
  site: { slug: 'lo-down', accreditationOrg: 'CPD Standards Office', accreditationRef: 'Provider 51045' },
  org: 'CPD Standards Office',
  search: officialSearch,
  fetchPage: async () => 'Accredited providers may display the CPD mark on their website and materials.',
  fetchUrl: async () => ({ ok: true, bytes: 4096 }),
});
check('it is found from the official source', found.found === true, JSON.stringify(found.searched.slice(-1)));
check('and the client is not asked', found.needsClient === false);

// terms are silent — downloadable is not permitted
found = await findAsset('official CPD Standards Office accreditation logo', {
  ticket: { attachments: [] },
  site: { slug: 'lo-down', accreditationOrg: 'CPD Standards Office', accreditationRef: 'Provider 51045' },
  search: officialSearch,
  fetchPage: async () => 'Download our logo pack here.',
  fetchUrl: async () => ({ ok: true }),
});
check('silent terms do NOT produce a download', found.found === false, JSON.stringify(found.research));
check('the client is asked instead', found.needsClient === true);
check('and the ask names the real unresolved point',
  /not permission/i.test(found.ask), found.ask);
check('the research decision is carried', found.research?.decision === 'ask-client', JSON.stringify(found.research));

// entitlement not on file
found = await findAsset('official CPD Standards Office accreditation logo', {
  ticket: { attachments: [] },
  site: { slug: 'lo-down', accreditationOrg: 'CPD Standards Office' },
  search: officialSearch,
  fetchPage: async () => 'Accredited providers may display the mark.',
  fetchUrl: async () => ({ ok: true }),
});
check('permission for someone is not permission for this client', found.found === false);
check('and the ask says what to confirm', /provider\/membership number|currently is one/i.test(found.ask), found.ask);

// no searcher configured at all — the real production state today
found = await findAsset('official CPD Standards Office accreditation logo', {
  ticket: { attachments: [] },
  site: { slug: 'lo-down', accreditationOrg: 'CPD Standards Office' },
});
check('with no search provider it says so rather than pretending', found.research?.decision === 'needs-search',
  JSON.stringify(found.research));
check('and the owner action is to configure one or paste the URL',
  /search provider|brand-resources URL/i.test(found.ask), found.ask);

done();
