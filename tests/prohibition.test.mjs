// R9.8 — six things optimisation may never touch.
//
// R9.1 refuses to NAME any of them as the variable under test, and on its own
// that is close to useless: a variant's content is free text, so an experiment
// declared `variable: 'subject'` whose arms read "A new website for your
// business" and "Half price this week only" is a price experiment wearing a
// subject-line label, and the declared variable does not stop it.
//
// So this tests the two layers R9.1 does not reach:
//   LAYER 2 — what the arms actually say.
//   LAYER 3 — what the optimisation path may write, including on an undo.
//
// Layer 3 is here because of R9.7's revert: it takes a logged `before` value
// and hands it to an applier. Log a change against a suppression record, then
// "undo" it, and the ledger has become a way to write to suppression with none
// of suppression's own guards in the way.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  DOMAINS, domain, inspect, inspectVariant, inspectVariants,
  PROTECTED_KEYS, mayWrite, mayRevert, describe,
} from '../lib/prohibition.js';
import {
  CHANGE_KINDS, getBounds, setBounds, mayChange, recordChange, listChanges, revertChange,
} from '../lib/optimisation-log.js';
import { createExperiment, updateVariants, getExperiment } from '../lib/experiments.js';
import { HOLDOUT_ID } from '../lib/holdout.js';

const EID = 'exp-prohibit';
const reset = async () => {
  await store.set(`experiment:${EID}`, '').catch(() => {});
  await store.set('optimisation:log', '').catch(() => {});
  await store.set('optimisation:bounds', '').catch(() => {});
};

// ---------------------------------------------------------------------------
section('P1  the six are written down, each with its reason');
check('there are six', DOMAINS.length === 6, String(DOMAINS.length));
for (const id of ['consent', 'suppression', 'price', 'promise', 'sender', 'budget']) {
  const d = domain(id);
  check(`${id} is declared`, !!d);
  check(`${id} states the rule`, !!d && typeof d.rule === 'string' && d.rule.length > 20);
  check(`${id} states why`, !!d && typeof d.why === 'string' && d.why.length > 20);
}
check('an unknown domain is not invented', domain('deliverability') === null);
check('describe() hands out copies, not the frozen originals', (() => {
  const a = describe();
  if (!Array.isArray(a) || !a.length) return false;
  a[0].rule = 'tampered';
  const d = domain(a[0].id);
  return !!d && d.rule !== 'tampered';
})());

// ---------------------------------------------------------------------------
section('P2  content: each domain is detected in copy someone would actually write');

// price
check('a dollar amount', inspect('A new site for $1,500').ok === false);
check('named in words', inspect('Only 500 dollars to get started').ok === false);
check('a percentage off', inspect('25% off if you reply this week').ok === false);
check('the word discount', inspect('I can offer a discount on the build').ok === false);
check('something given free', inspect('Your first month free when you sign up').ok === false);
check('and it is attributed to price', (() => {
  const f = inspect('A new site for $1,500').findings;
  return f.length > 0 && f.every((x) => x.domain === 'price');
})());

// promise
check('a guarantee', inspect('Guaranteed to bring you more calls').ok === false);
check('a ranking claim', inspect('We will get you to #1 on Google').ok === false);
check('risk-free', inspect('It is completely risk-free').ok === false);
check('a multiplier', inspect('3x more leads in the first month').ok === false);
check('a named result', inspect('This will double your bookings').ok === false);
check('and it is attributed to promise', (() => {
  const f = inspect('Guaranteed to bring you more calls').findings;
  return f.length > 0 && f.some((x) => x.domain === 'promise');
})());

// sender
check('on behalf of someone else', inspect('Writing on behalf of a local agency').ok === false);
check('a platform identity', inspect('This is from the Google Business team').ok === false);
check('a platform role', inspect('I am a Yelp partner specialist').ok === false);
check('and it is attributed to the sender', inspect('This is from the Google Business team').findings.some((f) => f.domain === 'sender'));

// suppression
check('restating the opt-out', inspect('Reply STOP and I will leave you alone').ok === false);
check('the word unsubscribe', inspect('You can unsubscribe at the bottom').ok === false);
check('reworded opting out', inspect('Just say the word and we will take you off the list').ok === false);
check('and it is attributed to opting out', inspect('You can unsubscribe at the bottom').findings.some((f) => f.domain === 'suppression'));

// consent
check('a claimed request', inspect('Following up on your enquiry from last week').ok === false);
check('a claimed opt-in', inspect('You signed up for updates from us').ok === false);
check('a claimed basis', inspect("You're receiving this because you visited our site").ok === false);
check('and it is attributed to consent', inspect('You signed up for updates from us').findings.some((f) => f.domain === 'consent'));

// A finding that cannot name its prohibition is a refusal with no reason, and
// a refusal with no reason gets worked around rather than fixed. So EVERY
// detector must resolve to one of the declared six — this is what catches a
// pattern quietly attributed to a domain that does not exist.
const BATTERY = [
  'A new site for $1,500', 'Only 500 dollars to start', '25% off this week', 'I can offer a discount',
  'Your first month free', 'cheaper than anyone', 'Guaranteed to bring more calls', 'We promise results',
  'We will get you to #1 on Google', '3x more leads', 'This will double your bookings', 'It is risk-free',
  'Writing on behalf of a local agency', 'from the Google Business team', 'I am a Yelp partner specialist',
  'my colleague will reach out', 'You can unsubscribe at the bottom', 'Reply STOP to be left alone',
  'opting out is easy', 'we will take you off the list', 'Following up on your enquiry',
  'You signed up for updates', 'per your request last month', "You're receiving this because you visited",
];
const all = BATTERY.flatMap((s) => inspect(s).findings);
check('the battery produces findings', all.length >= BATTERY.length, String(all.length));
check('every detector resolves to one of the declared six', all.every((f) => !!domain(f.domain)),
  JSON.stringify([...new Set(all.filter((f) => !domain(f.domain)).map((f) => f.domain))]));
check('so every finding can state its rule', all.every((f) => typeof f.rule === 'string' && f.rule.length > 20));
check('and its reason', all.every((f) => typeof f.why === 'string' && f.why.length > 20));
check('and a human-readable label', all.every((f) => typeof f.label === 'string' && f.label.length > 2 && f.label !== f.domain + '-off'));
check('all six domains are reachable by some detector', (() => {
  const seen = new Set(all.map((f) => f.domain));
  // budget is the one domain with no content detector: a variant cannot name a
  // spending limit, so it is enforced only at the write boundary (P6)
  return DOMAINS.filter((d) => d.id !== 'budget').every((d) => seen.has(d.id));
})(), JSON.stringify([...new Set(all.map((f) => f.domain))]));
check('and every battery line was caught by at least one', BATTERY.every((s) => inspect(s).findings.length > 0),
  JSON.stringify(BATTERY.filter((s) => inspect(s).findings.length === 0)));

// and copy that is actually allowed must pass, or the check is a wall
check('a plain subject line passes', inspect('A quick question about your website').ok === true, JSON.stringify(inspect('A quick question about your website').findings));
check('a real opening passes', inspect('I built a preview of a new site for your business and wanted to show you.').ok === true);
check('a real call to action passes', inspect('Worth a look? I can send the link over.').ok === true);
check('mentioning a website is not a promise', inspect('Your site could work harder for you.').ok === true);
check('empty content is not a finding', inspect('').ok === true && inspect(null).ok === true && inspect(undefined).ok === true);

check('a finding names the phrase, not just the domain', (() => {
  const f = inspect('Guaranteed results').findings;
  return f.length > 0 && typeof f[0].phrase === 'string' && /guarantee/i.test(f[0].phrase);
})());
check('every finding carries the rule and the reason', inspect('Half price this week').findings.every((f) => f.rule && f.why));
check('two domains in one sentence are both reported', (() => {
  const f = inspect('Guaranteed #1 on Google for $500').findings;
  return new Set(f.map((x) => x.domain)).size === 2;
})(), JSON.stringify(inspect('Guaranteed #1 on Google for $500').findings.map((f) => f.domain)));

// ---------------------------------------------------------------------------
section('P3  a variant is inspected in every field it carries, and the refusal is usable');
let r = inspectVariant({ id: 'b', subject: 'A quick question', body: 'It is money-back guaranteed.' });
check('the body is inspected, not only the subject', r.ok === false);
check('and the finding names the field', r.findings.length > 0 && r.findings[0].field === 'body', JSON.stringify(r.findings));
check('a clean variant passes every field', inspectVariant({ id: 'a', subject: 'A quick question', body: 'I built you a preview.', cta: 'Want the link?' }).ok === true);
check('a variant with no strings is not a finding', inspectVariant({ id: 'a', weight: 1 }).ok === true);
check('a non-object is survivable', inspectVariant(null).ok === true && inspectVariant(undefined).ok === true);

r = inspectVariants([
  { id: 'a', subject: 'A quick question about your website' },
  { id: 'b', subject: 'Half price this week only' },
]);
check('a set with one bad arm is refused', r.ok === false);
check('the refusal names the arm', /"b"/.test(r.error), r.error);
check('names the field', /subject/.test(r.error), r.error);
check('quotes the phrase', /Half price/i.test(r.error), r.error);
check('states the rule', /owner's commercial decision|may name a price/i.test(r.error), r.error);
check('and says why it matters', /commercial decision|not a message test/i.test(r.error), r.error);
check('a clean set passes', inspectVariants([{ id: 'a', subject: 'A quick question' }, { id: 'b', subject: 'One thought on your site' }]).ok === true);
check('a non-array is survivable', inspectVariants(null).ok === true);
check('several bad phrases are counted, not just the first', (() => {
  const x = inspectVariants([{ id: 'a', subject: 'Guaranteed #1' }, { id: 'b', subject: '50% off' }]);
  return x.findings.length >= 2 && /other prohibited/.test(x.error);
})());

// ---------------------------------------------------------------------------
section('P4  layer 2 is enforced at creation — through the real module');
await reset();
let out = await createExperiment({
  id: EID,
  variable: 'subject',
  hypothesis: 'shorter subject lines get more replies',
  variants: [
    { id: 'a', subject: 'A quick question about your website', weight: 1 },
    { id: 'b', subject: 'Half price this week only', weight: 1 },
  ],
});
check('a price hidden in a subject-line experiment is refused', out.ok === false, JSON.stringify(out));
check('the refusal is marked as a prohibition, not a validation slip', out.code === 'prohibited', String(out.code));
check('it names the arm and the phrase', /"b"/.test(out.error || '') && /Half price/i.test(out.error || ''), out.error);
check('and the findings come back for the interface', Array.isArray(out.findings) && out.findings.length > 0);
check('NOTHING was stored', (await getExperiment(EID)) == null, 'a refused experiment must not exist');

out = await createExperiment({
  id: EID,
  variable: 'opening',
  variants: [
    { id: 'a', opening: 'I built a preview of a new site for your business.', weight: 1 },
    { id: 'b', opening: 'We guarantee more calls within 30 days.', weight: 1 },
  ],
});
check('a guarantee in an opening-sentence experiment is refused', out.ok === false, JSON.stringify(out));
check('attributed to what is promised', (out.findings || []).some((f) => f.domain === 'promise'), JSON.stringify(out.findings));
check('still nothing stored', (await getExperiment(EID)) == null);

out = await createExperiment({
  id: EID,
  variable: 'subject',
  variants: [
    { id: 'a', subject: 'A quick question about your website', weight: 1 },
    { id: 'b', subject: 'One thought on your site', weight: 1 },
  ],
});
check('a legitimate subject-line experiment is allowed through', out.ok === true, JSON.stringify(out));
const made = await getExperiment(EID);
check('and it is stored', !!made);
check('with the holdout kept', !!made && made.variants.some((v) => v.id === HOLDOUT_ID));

// ---------------------------------------------------------------------------
section('P5  layer 2 is enforced at the edit — the likeliest place it gets added');
// an experiment that was clean when created is the one whose arms get "improved"
const before = await getExperiment(EID);
check('the fixture is running clean', !!before);
out = await updateVariants(EID, [
  { id: 'a', subject: 'A quick question about your website', weight: 1 },
  { id: 'b', subject: 'Guaranteed to double your bookings', weight: 1 },
  { id: HOLDOUT_ID, weight: 1 },
]);
check('an edit that adds a guarantee is refused', out.ok === false, JSON.stringify(out));
check('marked as a prohibition', out.code === 'prohibited', String(out.code));
const after = await getExperiment(EID);
check('and the stored arms are UNCHANGED', JSON.stringify(after && after.variants) === JSON.stringify(before && before.variants));
check('the refusal was not logged as a change', (await listChanges({ kind: CHANGE_KINDS.VARIANTS_CHANGED })).length === 0);

out = await updateVariants(EID, [
  { id: 'a', subject: 'A quick question about your website', weight: 1 },
  { id: 'b', subject: 'One thought on your site', weight: 2 },
  { id: HOLDOUT_ID, weight: 1 },
]);
check('a clean edit still applies', out.ok === true, JSON.stringify(out));
check('and is logged', (await listChanges({ kind: CHANGE_KINDS.VARIANTS_CHANGED })).length === 1);

// ---------------------------------------------------------------------------
section('P6  layer 3: the write boundary');
check('there are protected namespaces', PROTECTED_KEYS.length >= 4);
check('suppression is protected', mayWrite('suppress:email:someone@example.com').ok === false);
check('phone suppression too', mayWrite('suppress:phone:+15555550123').ok === false);
check('consent records', mayWrite('consent:someone@example.com').ok === false);
check('the business settings, which hold pricing and sender identity', mayWrite('settings:business').ok === false);
check('budgets', mayWrite('budget:settings').ok === false);
check('and a reservation under budgets', mayWrite('budget:res:abc').ok === false);
check('the refusal names the domain', mayWrite('suppress:email:x@y.com').domain === 'suppression');
check('and states the rule and the reason', (() => {
  const w = mayWrite('budget:settings');
  return /spending limit|control the owner set/i.test(w.reason || '');
})(), mayWrite('budget:settings').reason);
check('an experiment key is not protected', mayWrite('experiment:exp-1').ok === true);
check('nor the ledger itself', mayWrite('optimisation:log').ok === true);
check('case does not get you past it', mayWrite('SUPPRESS:email:x@y.com').ok === false);
check('nor does leading whitespace', mayWrite('  suppress:email:x@y.com').ok === false);

// fails closed: an unreadable target is not a safe target
check('no key is refused', mayWrite('').ok === false);
check('a missing key is refused', mayWrite(undefined).ok === false && mayWrite(null).ok === false);
check('a non-string key is refused', mayWrite({ key: 'suppress:x' }).ok === false && mayWrite(42).ok === false);
check('and says why it could not be checked', /cannot be checked against the prohibitions/.test(mayWrite('').reason || ''), mayWrite('').reason);

check('mayRevert checks the entry\'s target', mayRevert({ target: 'suppress:email:x@y.com' }).ok === false);
check('a normal entry may be reverted', mayRevert({ target: 'experiment:exp-1' }).ok === true);
check('an entry with no target is refused', mayRevert({ target: null }).ok === false);
check('and so is no entry at all', mayRevert(null).ok === false && mayRevert(undefined).ok === false);

// ---------------------------------------------------------------------------
section('P7  layer 3 is enforced on the undo — through the real ledger');
await reset();
// the attack this closes: get something into the ledger pointed at a protected
// namespace, then use the undo to write there
const logged = await recordChange({
  kind: CHANGE_KINDS.WEIGHTS_CHANGED,
  actor: 'owner',
  target: 'suppress:email:someone@example.com',
  before: { suppressed: false },
  after: { suppressed: true },
  reason: 'a change pointed at a suppression record',
});
check('the entry exists', logged.ok === true && !!logged.entry);
let applied = false;
let rev = await revertChange(logged.entry && logged.entry.id, async () => { applied = true; return { ok: true }; });
check('reverting it is REFUSED', rev.ok === false, JSON.stringify(rev));
check('marked as a prohibition', rev.code === 'prohibited', String(rev.code));
check('the applier was never called, so nothing was written', applied === false);
check('the reason names the namespace', /suppress:email:someone@example\.com/.test(rev.error || ''), rev.error);
const stillThere = (await listChanges({ limit: 10 })).find((c) => c.id === (logged.entry && logged.entry.id));
check('the entry was not marked reverted', !!stillThere && stillThere.reverted === false, JSON.stringify(stillThere));

// a change against an ordinary target still reverts, or the guard is a wall
const ordinary = await recordChange({
  kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner', target: 'experiment:exp-ok',
  before: { w: 1 }, after: { w: 2 }, reason: 'an ordinary change',
});
let appliedOrdinary = false;
rev = await revertChange(ordinary.entry && ordinary.entry.id, async () => { appliedOrdinary = true; return { ok: true }; });
check('an ordinary change still reverts', rev.ok === true, JSON.stringify(rev));
check('and its applier ran', appliedOrdinary === true);

// ---------------------------------------------------------------------------
section('P8  the hole R9.8 found: automation may not widen its own bounds');
await reset();
// with automation off, nothing automatic happens at all — so turn it ON, which
// is the only state in which this check does any work
await setBounds({ allowAutomaticChanges: true, maxChangesPerWeek: 99, maxWeightShiftPerChange: 1 });
let b = await getBounds();
check('the fixture has automation enabled', b.allowAutomaticChanges === true);
check('an ordinary automatic change is now permitted', (await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'automatic', weightShift: 0.05 })).ok === true);

let m = await mayChange({ kind: CHANGE_KINDS.BOUNDS_CHANGED, actor: 'automatic' });
check('but changing the bounds is still refused', m.ok === false, JSON.stringify(m));
check('and says why: bounds that automation can widen are not bounds', /widen its own bounds has no bounds/.test(m.reason || ''), m.reason);
check('the owner may still change them', (await mayChange({ kind: CHANGE_KINDS.BOUNDS_CHANGED, actor: 'owner' })).ok === true);

// and the write path itself refuses, not only the advisory check — a caller
// that wrote first and logged afterwards would already have changed them
out = await setBounds({ maxChangesPerWeek: 1000, allowAutomaticChanges: true }, { by: 'automatic' });
check('setBounds refuses an automatic caller', out && out.ok === false, JSON.stringify(out));
b = await getBounds();
check('and the bounds are UNCHANGED', b.maxChangesPerWeek === 99, String(b.maxChangesPerWeek));
check('the refusal was not logged as a bounds change', (await listChanges({ kind: CHANGE_KINDS.BOUNDS_CHANGED })).every((c) => c.actor === 'owner'));

out = await setBounds({ maxChangesPerWeek: 4 }, { by: 'owner' });
check('the owner\'s change applies', !!out && out.maxChangesPerWeek === 4, JSON.stringify(out));

// ---------------------------------------------------------------------------
section('P9  a refusal is never reported as applied');
await reset();
out = await createExperiment({
  id: 'exp-honest', variable: 'subject',
  variants: [{ id: 'a', subject: 'Guaranteed #1 on Google', weight: 1 }],
});
check('a refused creation does not report ok', out.ok !== true);
check('and carries no experiment object to mistake for success', out.experiment === undefined);
await store.set('experiment:exp-honest', '').catch(() => {});

check('no refusal path returns a bare object that reads as truthy success', (() => {
  // the specific shape bug this guards: `{ ok: false }` returned where the
  // caller does `if (result)` rather than `if (result.ok)`
  const shapes = [
    inspectVariants([{ id: 'b', subject: '$500' }]),
    mayWrite('suppress:email:x@y.com'),
    mayRevert({ target: 'budget:settings' }),
  ];
  return shapes.every((s) => s && s.ok === false && (s.error || s.reason));
})());

done();
