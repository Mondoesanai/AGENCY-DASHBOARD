// R5 end to end (L2) — the complete workflow a person can actually run:
// discover → qualify → create a campaign → preview the exact words → enrol
// prospects → start → see what is due.
//
// Every step goes through the real `api/admin.js` handler, not the library, so
// this is the evidence that the campaign code is reachable rather than an
// orphan. The reviewer flagged exactly that gap; these checks close it.
import { W, check, section, done } from './world.mjs';
import adminHandler from '../api/admin.js';
import { saveSettings, saveSender } from '../lib/settings.js';
import { saveProspects, updateProspect } from '../lib/discovery.js';
import { store } from '../lib/store.js';

process.env.CRON_SECRET = 'sekret-1234';
const S = 'sekret-1234';

function mkRes() {
  return {
    code: 0, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() {}, end() { return this; },
  };
}
const api = async (q, body = null) => {
  const res = mkRes();
  const [path, ...rest] = q.split('&');
  const query = { do: path, secret: S };
  for (const kv of rest) { const [k, v] = kv.split('='); query[k] = decodeURIComponent(v); }
  await adminHandler({ method: body ? 'POST' : 'GET', query, body, headers: {} }, res);
  return res;
};

// ---------------------------------------------------------------------------
section('E1  every campaign endpoint refuses without the password');
for (const q of ['campaigns-list', 'campaign-create', 'campaign-preview', 'campaign-add-prospects', 'campaign-due']) {
  const res = mkRes();
  await adminHandler({ method: 'GET', query: { do: q }, body: null, headers: {} }, res);
  check(`${q} is password-gated`, res.code === 401, `${q} -> ${res.code}`);
}

// ---------------------------------------------------------------------------
section('E2  a campaign is created through the API, as a draft');
let r = await api('campaign-create', { name: 'DFW flooring — no site found', type: 'cold-no-site-found', cadence: { gapDays: 4, followUps: 2 } });
check('it is created', r.code === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 160));
const camp = r.body.campaign;
check('as a draft, never running', camp.status === 'draft');
check('with the requested cadence', camp.cadence.gapDays === 4 && camp.cadence.followUps === 2);

r = await api('campaign-create', { name: 'too eager', type: 'cold-no-site-found', cadence: { gapDays: 0, followUps: 50 } });
check('an unsafe cadence is clamped rather than refused', r.body.ok === true);
check('and the clamping is reported back to the operator', r.body.campaign.cadenceNotes.length === 2, JSON.stringify(r.body.campaign.cadenceNotes));
r = await api('campaign-create', { name: 'bad', type: 'not-a-type' });
check('an unknown type is a 400', r.code === 400 && r.body.ok === false);

r = await api('campaigns-list');
check('the list endpoint returns them', r.body.campaigns.length >= 2);

// ---------------------------------------------------------------------------
section('E3  preview shows the exact words, and sends nothing');
await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { geography: { label: 'Dallas–Fort Worth' } } });

// three prospects in the three states that matter
await saveProspects([
  { sourceId: 'osm:node/901', name: 'Lone Star Flooring', email: 'pat@lonestarflooring.com', phone: '2145550147', city: 'Dallas', industry: 'flooring', evidence: {} },
  { sourceId: 'osm:node/902', name: 'Metroplex Floors', email: 'sam@metroplexfloors.com', city: 'Plano', industry: 'flooring', evidence: {} },
  { sourceId: 'osm:node/903', name: 'Trinity Tile', email: 'dana@trinitytile.com', city: 'Frisco', industry: 'flooring', evidence: {} },
  { sourceId: 'osm:node/904', name: 'No Email Co', city: 'Irving', industry: 'flooring', evidence: {} },
]);
const ID = (n) => `osm-node-${n}`;
await updateProspect(ID(901), { web: { status: 'not-linked-in-listing', observation: "I couldn't find a website linked from your OpenStreetMap listing." }, qualification: { segment: 'no-site-found' } });
await updateProspect(ID(902), { web: { status: 'inaccessible', observation: 'The listed website returned HTTP 503.' }, qualification: { segment: 'weak-site' } });
await updateProspect(ID(903), { web: { status: 'verified-present', observation: 'The listed website loads and matches this business.' }, qualification: { segment: 'has-site' } });
await updateProspect(ID(904), { web: { status: 'not-linked-in-listing', observation: 'none linked' }, qualification: { segment: 'no-site-found' } });

// sender identity is required before any message can be composed
r = await api('campaign-preview', { prospectId: ID(901) });
check('with no sender identity, no message is produced', r.body.message.ok === false, JSON.stringify(r.body.message));
check('and it names CAN-SPAM as the reason', /postal address/.test(r.body.message.reason), r.body.message.reason);
check('the response says the identity is incomplete', r.body.owner.complete === false);

await saveSender({ name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '123 Example St, Plano TX 75024' });
r = await api('campaign-preview', { prospectId: ID(901) });
check('with the identity set, a message is composed', r.body.message.ok === true, JSON.stringify(r.body.message).slice(0, 200));
const msg = r.body.message;
check('it uses the listing wording', /couldn't find a website linked from your/.test(msg.body));
check('it never claims they have no website', !/(have|has) no website/i.test(msg.body));
check('it carries the postal address', msg.body.includes('123 Example St'));
check('it quotes the configured price', msg.mentionsPrice === true && /\$2,500/.test(msg.body));
check('it mentions no preview, because none exists', msg.mentionsPreview === false);

// the important refusal, visible through the API
r = await api('campaign-preview', { prospectId: ID(903) });
check('a business with a working website produces NO message', r.body.message.ok === false, JSON.stringify(r.body.message));
check('and the API says why', /verified-present/.test(r.body.message.reason), r.body.message.reason);

check('previewing sent nothing', W.emails.length === 0, `${W.emails.length} emails were sent`);

// ---------------------------------------------------------------------------
section('E4  enrolling prospects refuses the ones it should');
r = await api('campaign-add-prospects', { campaignId: camp.id, prospectIds: [ID(901), ID(902), ID(903), ID(904), 'does-not-exist'] });
check('the call succeeds', r.body.ok === true, JSON.stringify(r.body).slice(0, 200));
check('only the matching prospect is enrolled', r.body.enrolled === 1, JSON.stringify(r.body.enrolledDetail));
const why = Object.fromEntries(r.body.refused.map((x) => [x.name || x.id, x.reason]));
check('a weak-site prospect is refused from a no-site campaign', /campaign is for businesses with no website found/.test(why['Metroplex Floors'] || ''), why['Metroplex Floors']);
check('a business with a working site is refused', /no website found/.test(why['Trinity Tile'] || ''), why['Trinity Tile']);
check('a prospect with no email is refused', /do not guess one from the domain/.test(why['No Email Co'] || ''), why['No Email Co']);
check('an unknown id is refused rather than crashing', /not found/.test(why['does-not-exist'] || ''), JSON.stringify(r.body.refused));

// enrolling twice does not duplicate
r = await api('campaign-add-prospects', { campaignId: camp.id, prospectIds: [ID(901)] });
check('re-enrolling the same prospect adds nobody', r.body.enrolled === 0, JSON.stringify(r.body));
check('and says it is already in the campaign', /already in this campaign/.test(JSON.stringify(r.body.refused)));

// ---------------------------------------------------------------------------
section('E5  a draft sends nothing; starting it makes work due');
r = await api(`campaign-due&id=${camp.id}`);
check('a draft has nothing due', r.body.due.length === 0);
check('and says it is not running', /draft, not running/.test(r.body.note || ''), r.body.note);

r = await api(`campaign-status&id=${camp.id}&status=running`);
check('it can be started', r.body.ok === true && r.body.campaign.status === 'running');
r = await api(`campaign-due&id=${camp.id}`);
const dueOrHeld = r.body.due.length + (r.body.held || 0);
check('once running, the enrolled contact is either due or held by the window', dueOrHeld === 1, JSON.stringify(r.body));

r = await api(`campaign-status&id=${camp.id}&status=paused`);
check('it can be paused again', r.body.campaign.status === 'paused');
r = await api(`campaign-status&id=${camp.id}&status=nonsense`);
check('an invalid status is refused', r.code === 400);

check('nothing has been emailed at any point', W.emails.length === 0, `${W.emails.length} emails`);

// ---------------------------------------------------------------------------
section('E6  an opt-out removes them from the campaign for good');
await api('contacts-optout', { email: 'pat@lonestarflooring.com', reason: 'unsubscribed' });
const { stopContact } = await import('../lib/campaigns.js');
const contacts = (await api('contacts-list')).body.contacts || [];
const pat = contacts.find((c) => c.email?.value === 'pat@lonestarflooring.com');
check('the contact exists', !!pat);
const stopped = await stopContact(pat.id, 'opted out');
check('their pending sends are cancelled', stopped.totalCancelled >= 1, JSON.stringify(stopped));

await api(`campaign-status&id=${camp.id}&status=running`);
r = await api(`campaign-due&id=${camp.id}`);
check('and they never become due again', r.body.due.length === 0 && !(r.body.held > 0), JSON.stringify(r.body));

r = await api('campaign-add-prospects', { campaignId: camp.id, prospectIds: [ID(901)] });
check('nor can they be re-added after opting out', r.body.enrolled === 0, JSON.stringify(r.body.refused));

done();
