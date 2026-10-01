// R2.3 / R2.9 — the Acquisition screens.
// Render functions are pure, so these drive them directly and assert on what a
// person would actually read. The recurring theme: empty must never be dressed
// up as a finished zero, and nothing may claim an integration it does not have.
import { check, section, done } from './world.mjs';
import {
  TABS, renderShell, renderBody, renderContacts, renderIntake,
  renderProspects, renderAcqSettings, renderReadiness, renderCampaigns, fieldCell, SEGMENT_LABEL,
} from '../public/acquisition.js';

const has = (html, s) => String(html).includes(s);

// ---------------------------------------------------------------------------
section('A1  the section has the six workflows, not a placeholder');
check('six tabs', TABS.length === 6, String(TABS.length));
check('contacts, intake, prospects, campaigns, inbox and settings', TABS.map((t) => t.id).join(',') === 'contacts,intake,prospects,campaigns,inbox,settings', TABS.map((t) => t.id).join(','));
const shell = renderShell('contacts');
check('the shell marks the active tab', /data-acq="contacts" class="on"/.test(shell), shell.slice(0, 200));
check('and leaves a body to fill', has(shell, 'id="acqBody"'));

// ---------------------------------------------------------------------------
section('A2  empty is "we have not looked", never a confident zero');
let html = renderContacts({ contacts: [] });
check('no contacts says so plainly', has(html, 'No contacts yet'));
check('and says where they would come from', /Add contacts/.test(html));
check('it does not render an empty table that looks like a result', !has(html, '<table'));

html = renderProspects({ prospects: [] });
check('no prospects says nothing has been searched', has(html, 'Nothing searched yet'));
check('and explicitly distinguishes that from "none exist"', /not the same as there being no businesses/.test(html));
check('discovery is still offered', has(html, 'acqDiscoverBtn'));

html = renderProspects({ loading: true });
check('loading is its own state', has(html, 'Loading prospects'));

// ---------------------------------------------------------------------------
section('A3  the prospect list reports observations, not conclusions');
const prospects = [
  { name: 'Lone Star Flooring', city: 'Dallas', industry: 'flooring', qualification: { segment: 'no-site-found' }, web: { observation: "I couldn't find a website linked from your OpenStreetMap listing." }, evidence: { sourceUrl: 'https://www.openstreetmap.org/node/1' } },
  { name: 'Metroplex Floors', city: 'Plano', industry: 'flooring', qualification: { segment: 'has-site' }, web: { observation: 'The listed website loads and matches this business (business name).' }, evidence: {} },
];
html = renderProspects({ prospects, targetingStatus: 'draft', attribution: '© OpenStreetMap contributors, ODbL 1.0' });
check('the not-found segment is labelled as "No website found"', has(html, SEGMENT_LABEL['no-site-found']));
check('the label says FOUND, not "has no website"', !/has no website/i.test(html));
check("the exact observation wording is shown to the operator", has(html, "couldn&#39;t find a website linked"));
check('a working site is a separate segment', has(html, SEGMENT_LABEL['has-site']));
check('segment counts are summarised', /No website found: 1/.test(html));
check('the OSM source link is offered as evidence', has(html, 'openstreetmap.org/node/1'));
check('the licence attribution is displayed', has(html, 'ODbL'));
check('a draft targeting state is called out', /Targeting is still a draft/.test(html));
check('and it states discovery never contacts anyone', /never contacts anyone/.test(html));

// ---------------------------------------------------------------------------
section('A4  low-confidence OCR is marked, never silently used');
check('a clean field renders plainly', fieldCell({ value: 'info@acme.com', needsReview: false }) === 'info@acme.com');
check('a shaky field is flagged for a human', /check/.test(fieldCell({ value: 'tnfo@acme.com', needsReview: true })));
check('an empty field is a dash, not a blank lie', /—/.test(fieldCell(null)));
check('values are HTML-escaped', /&lt;script&gt;/.test(fieldCell({ value: '<script>' })));

html = renderIntake({ scan: { note: 'Nothing has been saved yet.', cards: [{ name: { value: 'Pat Lee' }, email: { value: 'pat@x.com', needsReview: true }, review: [{ field: 'email' }] }] } });
check('the scan result says nothing is saved yet', /Nothing has been saved yet/.test(html));
check('fields needing a check are named', /Unsure about: email/.test(html));
check('and saving is an explicit button, not automatic', has(html, 'acqCommitCards'));
check('the relationship question is asked, not assumed', has(html, 'Where did you meet them?'));
check('"same networking group" is offered as distinct from having met', /we have not met/.test(html));

// ---------------------------------------------------------------------------
section('A5  CSV preview promises what import will do');
html = renderIntake({ csvPreview: { willImport: 12, skipped: [{ reason: 'invalid email' }] } });
check('the preview states the count', /12 row\(s\) would be imported/.test(html));
check('it says nothing is written yet', /Nothing has been written yet/.test(html));
check('skipped rows give a reason', /invalid email/.test(html));
check('importing is a separate explicit action', has(html, 'acqCommitCsv'));

// ---------------------------------------------------------------------------
section('A6  pricing is shown as unset, never as zero');
let state = {
  settings: { pricing: { configured: false, buildPrice: null, monthlyFee: null, includes: ['Hosting', 'Unlimited revisions'] }, targeting: { status: 'draft', source: 'development assumption', geography: { label: 'DFW' }, weeklyVolume: 25, exclusions: { minYearsInBusiness: 2 }, industries: [{ label: 'Flooring' }] } },
  pricingBlocker: 'Pricing is not set (build price and monthly fee missing), so no message may quote a price.',
  readiness: { provider: 'instantly', connected: false, ready: false, blockers: [{ text: 'No Instantly API key.' }, { text: 'No separate sending domain configured.' }] },
};
html = renderAcqSettings(state);
check('the unset price shows a "not set" placeholder, not 0', /placeholder="not set"/.test(html));
check('the value is empty rather than 0', !/value="0"/.test(html));
check('the blocker is shown', /no message may quote a price/.test(html));
check('what the monthly fee covers is listed', /Unlimited revisions/.test(html));
check('targeting draft status is visible', /Status: <b>draft<\/b>/.test(html));
check('and framed as not a decision to contact anyone', /not a decision to contact anyone/.test(html));
check('confirming targeting is a deliberate separate button', has(html, 'acqConfirmTargeting'));

state.settings.pricing = { configured: true, buildPrice: 2500, monthlyFee: 197, includes: [] };
html = renderAcqSettings(state);
check('a configured price says messages may quote it', /may quote this/.test(html));
check('and the real figures are shown', /value="2500"/.test(html) && /value="197"/.test(html));

// ---------------------------------------------------------------------------
section('A7  a disconnected provider never reads as connected (R2.9)');
html = renderReadiness({ provider: 'instantly', connected: false, ready: false, blockers: [{ text: 'No Instantly API key.' }] });
check('it says not connected', /not connected/.test(html));
check('it does not say ready', !/>ready</.test(html));
check('the blockers are listed for the owner', /No Instantly API key/.test(html));
check('and it states sending cannot happen', /cannot send/.test(html));
check('while making clear these are decisions, not bugs', /none of it is a bug/.test(html));

html = renderReadiness({ provider: 'instantly', connected: true, ready: false, blockers: [{ text: 'Outreach has not been switched on.' }] });
check('connected-but-not-activated is its own state', /connected, not activated/.test(html));

html = renderReadiness({ provider: 'instantly', connected: true, ready: true, blockers: [] });
check('only a fully ready provider says sending is live', /Sending is live/.test(html));

// ---------------------------------------------------------------------------
section('A8  the body router covers every tab');
for (const t of TABS) {
  const out = renderBody(t.id, { contacts: [], prospects: [], settings: state.settings, readiness: state.readiness });
  check(`${t.id} renders something`, typeof out === 'string' && out.length > 40, t.id);
  check(`${t.id} does not render "undefined"`, !/undefined/.test(out), out.slice(0, 120));
}
check('an unknown tab is handled', /Unknown tab/.test(renderBody('nope', {})));

// ---------------------------------------------------------------------------
section('A9  an opted-out contact stays visible, with its state');
html = renderContacts({ contacts: [
  { id: '1', name: { value: 'Pat' }, email: { value: 'pat@x.com' }, optedOutAt: Date.now() },
  { id: '2', name: { value: 'Sam' }, email: { value: 'sam@x.com' }, emailStatus: 'hard_bounce' },
  { id: '3', name: { value: 'Dana' }, email: { value: 'dana@x.com' } },
] });
check('an opted-out contact is shown as opted out', /opted out/.test(html));
check('a bounced address is shown as bounced', /bounced/.test(html));
check('a usable one is shown as emailable', /emailable/.test(html));
check('and it explains why opted-out records are kept', /deleting the record would lose the opt-out/.test(html));

// ---------------------------------------------------------------------------
section('A10  the campaigns screen leads with whether anything can be sent');
let c = renderCampaigns({ campaigns: [], readiness: { ready: false, blockers: [{ text: 'No Instantly API key.' }, { text: 'Outreach has not been switched on.' }] } });
check('it says plainly that nothing can be sent', /Nothing can be sent yet/.test(c));
check('it lists the blockers', /No Instantly API key/.test(c) && /switched on/.test(c));
check('but makes clear you can still build and preview', /composing is safe, sending is what is gated/.test(c));
check('no campaigns says what a campaign is', /A campaign is a message plus a cadence/.test(c));
check('and that creating one sends nothing', /campaigns start as drafts/.test(c));
check('the cadence limits are stated before you type', /capped at 2 \(1 for warm\)/.test(c));

c = renderCampaigns({
  campaigns: [{ id: 'c1', name: 'DFW flooring', type: 'cold-no-site-found', cadence: { gapDays: 4, followUps: 2 }, status: 'draft' }],
  readiness: { ready: true, blockers: [] },
});
check('a ready provider says sending is live', /Sending is live/.test(c));
check('the campaign type is shown in words', /Cold — no website found/.test(c));
check('the cadence is shown in words', /intro \+ 2, 4d apart/.test(c));
check('a draft offers Start', /data-act="running"/.test(c));
c = renderCampaigns({ campaigns: [{ id: 'c1', name: 'x', type: 'cold-no-site-found', cadence: { gapDays: 4, followUps: 2 }, status: 'running' }], readiness: { ready: true, blockers: [] } });
check('a running campaign offers Pause', /data-act="paused"/.test(c) && />\s*Pause/.test(c));

// the preview block — the exact words, and the honest refusal
c = renderCampaigns({ campaigns: [], readiness: { ready: true, blockers: [] }, campaignPreview: { ok: true, message: { ok: true, subject: 'Couldn\'t find a website for Lone Star Flooring', body: 'Hi,\n\nI was looking up Lone Star Flooring...', mentionsPrice: true, mentionsPreview: false } } });
check('the preview shows the subject', /Couldn&#39;t find a website for Lone Star/.test(c));
check('and the body verbatim in a pre block', /acq-pre/.test(c) && /I was looking up Lone Star Flooring/.test(c));
check('it states whether a price is quoted', /Quotes your price/.test(c));
check('and whether a preview is mentioned', /No preview mentioned/.test(c));

c = renderCampaigns({ campaigns: [], readiness: { ready: true, blockers: [] }, campaignPreview: { ok: true, message: { ok: false, reason: 'no honest opening for this prospect (web status: verified-present)' } } });
check('a refusal to compose is shown as such', /No message can be written/.test(c));
check('with the reason', /verified-present/.test(c));
check('and framed as correct behaviour, not an error', /That is the system working/.test(c));

// ---------------------------------------------------------------------------
section('A11  prospects can be selected and enrolled, with honest limits');
html = renderProspects({
  prospects: [
    { id: 'p1', name: 'Has Email', city: 'Dallas', email: 'a@b.com', qualification: { segment: 'no-site-found' }, web: {}, evidence: {} },
    { id: 'p2', name: 'No Email', city: 'Plano', qualification: { segment: 'no-site-found' }, web: {}, evidence: {} },
  ],
  campaigns: [{ id: 'c1', name: 'DFW flooring' }],
});
check('a prospect with an email can be picked', /value="p1"[^>]*\/>/.test(html) && !/value="p1"[^>]*disabled/.test(html), html.match(/value="p1"[^>]*/)?.[0]);
check('a prospect with no email cannot be picked', /value="p2"[^>]*disabled/.test(html), html.match(/value="p2"[^>]*/)?.[0]);
check('and the reason is given', /do not guess an\s+address from a domain/.test(html.replace(/\s+/g, ' ')) || /do not guess/.test(html));
check('a campaign picker is offered', /pr_campaign/.test(html) && /pr_enrol/.test(html));
check('each prospect offers a message preview', /data-preview="p1"/.test(html));

html = renderProspects({ prospects: [{ id: 'p1', name: 'X', qualification: {}, web: {}, evidence: {} }], campaigns: [] });
check('with no campaigns it says to create one first', /Create a campaign first/.test(html));

// ---------------------------------------------------------------------------
section('A12  the replies screen leads with the mode, then what needs you');
const { renderInbox, KIND_LABEL, NEEDS_ATTENTION } = await import('../public/acquisition.js');

let inbox = renderInbox({ replies: [], replyMode: 'draft-only' });
check('the mode is stated first', /Reply mode: <b>draft-only<\/b>/.test(inbox), inbox.slice(0, 200));
check('draft-only explains that nothing goes without you', /Nothing is sent until you press send/.test(inbox));
check('empty says what will fill it', /No replies yet/.test(inbox));
check('and restates the pause guarantee', /pauses that contact's follow-ups the moment it arrives/.test(inbox));

inbox = renderInbox({ replies: [], replyMode: 'automatic' });
check('automatic mode is called out as the riskier one', /can go out without you reading them first/.test(inbox));
check('while stating the guards still apply', /Every guard still applies/.test(inbox));
check('and offers to switch back', /data-mode="draft-only"/.test(inbox));

const replies = [
  { id: 'r1', contactId: 'c1', fromName: 'Maple Co', kind: 'wants-call', at: Date.now(), text: 'call me', handled: false,
    draft: { body: 'Happy to talk.', status: 'awaiting-review', respectedInformationFirst: false } },
  { id: 'r2', contactId: 'c2', fromName: 'Nettle Co', kind: 'wants-details', at: Date.now(), text: 'send info first, how much', handled: false,
    draft: { body: "It's $2,500 to build.", status: 'awaiting-review', respectedInformationFirst: true } },
  { id: 'r3', contactId: 'c3', fromName: 'Olive Co', kind: 'ambiguous', at: Date.now(), text: 'who is this', handled: false,
    draft: { body: null, status: 'needs-a-person', reason: 'nothing in the approved knowledge base answers this' } },
  { id: 'r4', contactId: 'c4', fromName: 'Privet Co', kind: 'interested', at: Date.now(), text: 'yes', handled: false,
    draft: { body: null, status: 'withheld', withheldBecause: ['offers a discount'] } },
  { id: 'r5', contactId: 'c5', fromName: 'Auto Co', kind: 'auto-reply', at: Date.now(), text: 'out of office', handled: true, draft: {} },
];
inbox = renderInbox({ replies, replyMode: 'draft-only' });
check('it counts what is worth the owner\'s time', /4 reply\(ies\) worth your time/.test(inbox), inbox.match(/\d+ reply\(ies\) worth your time/)?.[0]);
check('an auto-reply is not counted as needing attention', !NEEDS_ATTENTION.has('auto-reply'));
check('each reply shows the prospect\'s own words', /call me/.test(inbox) && /who is this/.test(inbox));
check('a ready draft is shown in full', /Happy to talk\./.test(inbox));
check('and offers to send it', /data-send="r1"/.test(inbox));
check('"information first" is surfaced to the owner', /asked for information first, so no booking link/.test(inbox));
check('a draft that needs writing says so with the reason', /needs you to write it/.test(inbox) && /approved knowledge base/.test(inbox));
check('a withheld draft says what it contained', /Withheld because the draft offers a discount/.test(inbox), inbox.match(/Withheld[^<]*/)?.[0]);
check('every reply offers manual takeover', (inbox.match(/data-takeover=/g) || []).length === 5, String((inbox.match(/data-takeover=/g) || []).length));
check('a handled reply is marked handled', /handled<\/span>/.test(inbox));
check('kinds are shown in words, not codes', /Wants a call/.test(inbox) && KIND_LABEL['wants-call'] === 'Wants a call');

// a sent draft shows who approved it and offers no send button
inbox = renderInbox({ replies: [{ id: 'r6', contactId: 'c6', fromName: 'Sent Co', kind: 'interested', at: Date.now(), text: 'yes',
  draft: { body: 'thanks', status: 'sent', approvedBy: 'owner' } }], replyMode: 'draft-only' });
check('a sent draft records who approved it', /approved by owner/.test(inbox));
check('and cannot be sent again from the screen', !/data-send=/.test(inbox));

done();
