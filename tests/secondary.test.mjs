// R9.3 — delivery, bounces, complaints, opt-outs, filtered clicks.
//
// These answer a different question from R9.2's ladder. That one asks *did the
// message work?*; this asks *did it arrive, and did it do harm?* The failure
// mode being guarded against is combining them: a variant that gets more
// replies AND more complaints has not won anything, and any system that nets
// one off against the other will eventually recommend the message that
// generates the most complaints.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  SECONDARY, DIRECTION, HARM_KINDS, secondaryFor,
  classifyClick, recordSecondary, recordSecondaryEverywhere,
  secondaryBreakdown, harmWarnings,
} from '../lib/secondary.js';
import { createExperiment, setExperimentState, assign, tally } from '../lib/experiments.js';

const EID = 'exp-secondary';
const reset = async () => { await store.set(`experiment:${EID}`, '').catch(() => {}); };

// ---------------------------------------------------------------------------
section('S1  each signal says which direction it points');
check('all seven are defined', SECONDARY.length === 7, String(SECONDARY.length));
for (const s of SECONDARY) {
  check(`${s.id} has a direction`, Object.values(DIRECTION).includes(s.direction), s.direction);
  check(`${s.id} explains what it means`, s.means.length > 40, s.means);
}
check('complaints are harm', secondaryFor('complained').harmful === true);
check('opt-outs are harm', secondaryFor('opted-out').harmful === true);
check('and those are the only two', HARM_KINDS.join(',') === 'complained,opted-out', HARM_KINDS.join(','));
check('a hard bounce is NOT harm — it is list quality', secondaryFor('bounced-hard').harmful === false);
check('and says so', /list quality, not message quality/.test(secondaryFor('bounced-hard').means));
check('a soft bounce does not suppress anyone', /[Nn]ot a reason to suppress/.test(secondaryFor('bounced-soft').means), secondaryFor('bounced-soft').means);
check('delivery is not an achievement', /does not mean anyone saw it/.test(secondaryFor('delivered').means));
check('a complaint is flagged as the one that ends domains', /ends sending domains/.test(secondaryFor('complained').means));
// opens are deliberately absent — they are not even a secondary outcome
check('an open is not a secondary outcome at all', !SECONDARY.some((s) => /open/i.test(s.id)), SECONDARY.map((s) => s.id).join(','));

// ---------------------------------------------------------------------------
section('S2  a machine click is not a click');
const base = { deliveredAt: 1_700_000_000_000, linksInMessage: 3, clickedLinks: 1, userAgent: 'Mozilla/5.0 (Macintosh) Safari/605' };

let c = classifyClick({ ...base, at: base.deliveredAt + 4 * 3600_000 });
check('a normal click hours later looks human', c.kind === 'click-human' && c.machine === false, JSON.stringify(c));
check('and the note refuses to call it interest', /not evidence of interest/.test(c.note));

// the shape signals, which matter more than the user agent
c = classifyClick({ ...base, at: base.deliveredAt + 2000 });
check('a click two seconds after delivery is a machine', c.machine === true, JSON.stringify(c));
check('and says why', /faster than a person opens mail/.test(c.reasons.join(' ')));

c = classifyClick({ ...base, at: base.deliveredAt + 4 * 3600_000, clickedLinks: 3 });
check('every link opened at once is a machine', c.machine === true, JSON.stringify(c));
check('and says what gave it away', /every link in the message/.test(c.reasons.join(' ')));

c = classifyClick({ ...base, at: base.deliveredAt + 4 * 3600_000, userAgent: 'ProofPoint-Scanner/2.0' });
check('a self-identifying scanner is a machine', c.machine === true);
c = classifyClick({ ...base, at: base.deliveredAt + 4 * 3600_000, userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
check('a bot user agent is a machine', c.machine === true);

// a weak signal must not decide on its own
c = classifyClick({ at: base.deliveredAt + 4 * 3600_000, deliveredAt: base.deliveredAt, userAgent: '', linksInMessage: 1, clickedLinks: 1 });
check('a missing user agent alone does not make it a machine', c.machine === false, JSON.stringify(c));
check('but it is noted', /no user agent/.test(c.reasons.join(' ')));
c = classifyClick({ at: base.deliveredAt + 2000, deliveredAt: base.deliveredAt, userAgent: '', linksInMessage: 1, clickedLinks: 1 });
check('a missing user agent PLUS a two-second click is a machine', c.machine === true, JSON.stringify(c));
check('a click with no delivery time to compare against is not assumed machine',
  classifyClick({ at: Date.now(), userAgent: 'Mozilla/5.0 Safari', linksInMessage: 1, clickedLinks: 1 }).machine === false);

// ---------------------------------------------------------------------------
section('S3  recording goes to the arm, with its direction attached');
await reset();
await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }] });
await setExperimentState(EID, 'running');
await assign({ experimentId: EID, contactId: 'sec-1' });

let out = await recordSecondary({ experimentId: EID, contactId: 'sec-1', kind: 'complained' });
check('a complaint is recorded', out.ok === true, JSON.stringify(out));
check('marked as harm', out.harmful === true && out.direction === DIRECTION.HARM);
check('and the direction travels with the stored record', out.outcome.evidence.harmful === true);
check('an invented kind is refused', (await recordSecondary({ experimentId: EID, contactId: 'sec-1', kind: 'vibes' })).ok === false);

await recordSecondary({ experimentId: EID, contactId: 'sec-1', kind: 'delivered' });
await recordSecondary({ experimentId: EID, contactId: 'sec-1', kind: 'click-filtered' });

// ---------------------------------------------------------------------------
section('S4  harm is reported apart, never netted off');
let b = secondaryBreakdown(await tally(EID));
check('the breakdown is produced', b.ok === true);
const arm = b.arms.find((a) => a.counts.complained > 0);
check('the arm carries its counts', !!arm, JSON.stringify(b.arms));
check('harm events are counted on their own', arm?.harmEvents === 1, String(arm?.harmEvents));
check('and the harmful kinds are named', arm?.harmKinds?.includes('complained'));
check('every kind is present, zero rather than absent', b.arms.every((a) => Object.keys(a.counts).length === 7));
check('the kinds table explains each one', b.kinds.length === 7 && b.kinds.every((k) => !!k.means));

// the rule
const text = JSON.stringify(b);
check('there is no net figure', !/"net"/i.test(text), text.slice(0, 160));
check('no health score', !/"score"/i.test(text));
check('no winner', !/"winner"/i.test(text));
check('and it says harm is never netted off the primary outcomes', /never netted off/.test(b.note));
check('spelling out that more replies AND more complaints is not a win', /has not won anything/.test(b.note));

// ---------------------------------------------------------------------------
section('S5  delivery is a denominator, and an unknown one says so');
const withDelivery = b.arms.find((a) => a.counts.delivered > 0);
check('an arm with delivery uses delivered as the denominator', withDelivery?.denominator.basis === 'delivered', JSON.stringify(withDelivery?.denominator));
check('and reports delivery as known', withDelivery?.deliveryKnown === true);
const noDelivery = b.arms.find((a) => a.counts.delivered === 0);
check('an arm with no delivery events falls back to assigned', noDelivery?.denominator.basis === 'assigned', JSON.stringify(noDelivery?.denominator));
check('and says the two are not the same number', /are not the same number/.test(noDelivery?.deliveryNote || ''), noDelivery?.deliveryNote);
check('rather than silently pretending', noDelivery?.deliveryKnown === false);

// ---------------------------------------------------------------------------
section('S6  harm loud enough to stop for is stated, not left in a table');
let w = harmWarnings(b, { complaintRate: 0.001, optOutRate: 0.02 });
check('a complaint produces a warning', w.some((x) => x.kind === 'complained'), JSON.stringify(w));
check('marked critical', w.find((x) => x.kind === 'complained')?.severity === 'critical');
check('and says what is at stake', /ends sending domains/.test(w.find((x) => x.kind === 'complained')?.text || ''));

await assign({ experimentId: EID, contactId: 'sec-2' });
for (let i = 0; i < 5; i++) await recordSecondary({ experimentId: EID, contactId: 'sec-2', kind: 'opted-out' });
w = harmWarnings(secondaryBreakdown(await tally(EID)), { complaintRate: 0.5, optOutRate: 0.01 });
check('opt-outs above the threshold warn too', w.some((x) => x.kind === 'opted-out'), JSON.stringify(w));
check('at warn rather than critical', w.find((x) => x.kind === 'opted-out')?.severity === 'warn');
check('with thresholds that are arguments, not constants', harmWarnings(b, { complaintRate: 1, optOutRate: 1 }).length === 0);
check('an empty breakdown warns about nothing', harmWarnings({ ok: false }).length === 0);

// ---------------------------------------------------------------------------
section('S7  the real paths record these');
{
  // a delivery event fans out to the running arms
  const { applyDeliveryEvent } = await import('../lib/outreach-email.js');
  const { upsertContact, field } = await import('../lib/contacts.js');
  const { listOutcomes } = await import('../lib/experiments.js');
  const ADDR = 'secondary@lonestar.test';
  const made = await upsertContact({ source: 'discovery', name: field('Sec Test'), email: field(ADDR) });
  await assign({ experimentId: EID, contactId: made.contact.id });

  const before = (await listOutcomes(EID)).length;
  await applyDeliveryEvent({ type: 'complained', email: ADDR });
  const added = (await listOutcomes(EID)).slice(before);
  check('a real complaint event reaches the experiment', added.some((o) => o.kind === 'complained'), added.map((o) => o.kind).join(','));
  check('attributed to the contact\'s arm', added.find((o) => o.kind === 'complained')?.variantId != null);

  const before2 = (await listOutcomes(EID)).length;
  await applyDeliveryEvent({ type: 'bounced', email: ADDR, hard: false });
  const added2 = (await listOutcomes(EID)).slice(before2);
  check('a soft bounce is recorded as soft, not hard', added2.some((o) => o.kind === 'bounced-soft'), added2.map((o) => o.kind).join(','));

  // an OPEN must not become a secondary outcome (R9.4 arriving early)
  const before3 = (await listOutcomes(EID)).length;
  await applyDeliveryEvent({ type: 'opened', email: ADDR });
  const added3 = (await listOutcomes(EID)).slice(before3);
  check('an open records NO secondary outcome', added3.length === 0, added3.map((o) => o.kind).join(','));

  // and the click path classifies
  const { recordBookingLinkClick } = await import('../lib/bookings.js');
  const now = Date.now();
  const human = await recordBookingLinkClick(made.contact.id, { at: now, deliveredAt: now - 4 * 3600_000, userAgent: 'Mozilla/5.0 Safari', linksInMessage: 3, clickedLinks: 1 });
  check('a human-looking click is classified as such', human.machine === false, JSON.stringify(human.classification));
  check('and is still not a booking', human.isBooking === false);
  const bot = await recordBookingLinkClick(made.contact.id, { at: now, deliveredAt: now - 1500, userAgent: 'Mimecast-Scanner', linksInMessage: 3, clickedLinks: 3 });
  check('a scanner click is classified as a machine', bot.machine === true, JSON.stringify(bot.classification));
  const kinds = (await listOutcomes(EID)).map((o) => o.kind);
  check('both click kinds reach the experiment separately', kinds.includes('click-human') && kinds.includes('click-filtered'), kinds.join(','));
}

await reset();
done();
