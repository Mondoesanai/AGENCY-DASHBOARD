// R9.8 — six things optimisation may never touch, enforced at three layers.
//
// R9.1 already refuses to NAME any of these as the variable under test. That
// is the easy half, and on its own it is close to useless, because a variant's
// content is free text. An experiment declared as `variable: 'subject'` whose
// two arms read "A new website for your business" and "Half price this week
// only" is a price experiment wearing a subject-line label. Nothing about the
// declared variable stops it. So the prohibition has to be enforced where the
// variation actually lives:
//
//   LAYER 1 — the declared variable.   (R9.1, lib/experiments.js)
//   LAYER 2 — the variant's content.   (here: inspect())
//   LAYER 3 — the write boundary.      (here: mayWrite())
//
// Layer 3 exists because of the undo. R9.7's revert path takes a logged
// `before` value and hands it to an applier — which means that if anything
// ever logged a change against a suppression record or the pricing settings,
// reverting it would write there, through a path with none of those domains'
// own guards on it. The ledger must not become a second way to write to them.
//
// Why these six and not a longer list. Each one has the same shape: varying it
// does not test a message, it tests whether a rule applies to some of the
// people on the list.
//
//  CONSENT      — testing a weaker basis tests whether the law covers half the
//                 list. There is also no honest version of claiming consent in
//                 copy ("as you requested") when none was given.
//  SUPPRESSION  — an opt-out is a standing instruction from a person. The
//                 mechanism must be identical for everyone, which means the
//                 opt-out line comes from settings and never from an arm.
//  PRICE        — quoting different numbers to comparable prospects is a
//                 commercial decision made by the owner, not a message test.
//  PROMISES     — "guaranteed #1 on Google" is not a wording variant; it is a
//                 different offer, and the one that wins is the one that
//                 overpromises. The cost lands on delivery, weeks later.
//  SENDER       — CAN-SPAM requires an accurate identity. Varying it varies
//                 whether the message is lawful.
//  BUDGET       — a limit the owner set is a control, not a parameter to
//                 optimise around.

export const DOMAINS = Object.freeze([
  {
    id: 'consent',
    label: 'Consent',
    rule: 'No experiment may vary the basis on which someone is contacted, or claim a consent that was not given.',
    why: 'Testing a weaker basis is testing whether the law applies to half your list.',
  },
  {
    id: 'suppression',
    label: 'Opting out',
    rule: 'The opt-out instruction is taken from settings and is identical in every arm.',
    why: 'An opt-out is a standing instruction from a person. A variant that rewords it is varying whether it works.',
  },
  {
    id: 'price',
    label: 'Price',
    rule: 'No arm may name a price, a discount, or anything free that the other arms do not.',
    why: 'Quoting different numbers to comparable prospects is the owner\'s commercial decision, not a message test.',
  },
  {
    id: 'promise',
    label: 'What is promised',
    rule: 'No arm may guarantee an outcome or name a result the offer does not include.',
    why: 'The arm that overpromises wins the test and loses the client, and the bill arrives at delivery.',
  },
  {
    id: 'sender',
    label: 'Who it is from',
    rule: 'One sender identity, from settings. No arm may imply a different person, business or platform.',
    why: 'CAN-SPAM requires an accurate identity, so varying it varies whether the message is lawful.',
  },
  {
    id: 'budget',
    label: 'Spending limits',
    rule: 'Nothing in the optimisation path may change a spending limit, in either direction.',
    why: 'A budget is a control the owner set. Optimising around it removes the control.',
  },
]);

export const domain = (id) => DOMAINS.find((d) => d.id === id) || null;

// ---------------------------------------------------------------------------
// Layer 2 — content
// ---------------------------------------------------------------------------
//
// These patterns are deliberately blunt and will occasionally refuse a
// harmless sentence. That trade is the right way round: the cost of a false
// refusal is rewording one arm, and the cost of a miss is a price experiment
// running for a month against real prospects. Every refusal names the domain
// and the phrase, so rewording takes seconds.

const PATTERNS = [
  // price: an amount, a discount, or anything offered free
  { d: 'price', re: /(?:\$|US\$)\s?\d/i, what: 'a currency amount' },
  { d: 'price', re: /\b\d+\s*(?:dollars|bucks|usd)\b/i, what: 'a currency amount' },
  { d: 'price', re: /\b\d{1,3}\s*%\s*(?:off|discount|cheaper|less)\b/i, what: 'a discount' },
  { d: 'price', re: /\b(?:discount|half[- ]price|cut price|special rate|introductory rate|waive[ds]?|no charge|free (?:month|build|site|website|website build|trial|setup))\b/i, what: 'a price or discount' },
  // "a free month" and "the first month free" are the same offer; a detector
  // that only reads one word order is a detector someone reorders around
  { d: 'price', re: /\b(?:for free|free of charge|(?:month|build|site|website|setup|trial)s?\s+(?:is\s+|are\s+)?free)\b/i, what: 'something offered free' },
  { d: 'price', re: /\b(?:cheaper|cheapest|lowest price|beat (?:any|their) price)\b/i, what: 'a price claim' },

  // promise: a guarantee, or a named result
  { d: 'promise', re: /\b(?:guarantee[ds]?|guaranteeing|risk[- ]free|money[- ]back|no[- ]risk)\b/i, what: 'a guarantee' },
  { d: 'promise', re: /\b(?:we|I)\s+promise\b/i, what: 'a promise' },
  { d: 'promise', re: /\b(?:#\s?1|number one|top (?:spot|of (?:google|search)))\b/i, what: 'a ranking claim' },
  { d: 'promise', re: /\b\d+\s?x\s+(?:more|the)\b/i, what: 'a multiplier claim' },
  { d: 'promise', re: /\b(?:double|triple|\d{2,}%\s*more)\s+(?:your\s+)?(?:leads|calls|bookings|revenue|traffic|customers)\b/i, what: 'a named result' },
  { d: 'promise', re: /\b(?:will|guaranteed to)\s+(?:rank|double|triple|get you)\b/i, what: 'a named result' },

  // sender: implying a different person, business or platform
  { d: 'sender', re: /\b(?:on behalf of|representing)\b/i, what: 'a different sender' },
  { d: 'sender', re: /\bfrom (?:the )?(?:google|yelp|facebook|meta|angi|thumbtack|nextdoor|bbb)\b/i, what: 'a platform identity' },
  { d: 'sender', re: /\b(?:google|yelp|facebook|meta|angi|thumbtack|bbb)\s+(?:team|support|partner|specialist|representative|verification)\b/i, what: 'a platform identity' },
  { d: 'sender', re: /\b(?:my colleague|our (?:agency|team) partner)\b/i, what: 'a different sender' },

  // suppression: an arm must not restate or reword the opt-out
  { d: 'suppression', re: /\bunsubscrib\w*/i, what: 'the opt-out instruction' },
  { d: 'suppression', re: /\bopt(?:ing)?[- ]out\b/i, what: 'the opt-out instruction' },
  { d: 'suppression', re: /\breply\s+(?:with\s+)?["']?stop\b/i, what: 'the opt-out instruction' },
  { d: 'suppression', re: /\b(?:remove|take) (?:you|me) (?:off|from) (?:the |my |our )?list\b/i, what: 'the opt-out instruction' },

  // consent: claiming a consent that was not given
  { d: 'consent', re: /\b(?:you|as you) (?:requested|asked|signed up|opted in|agreed)\b/i, what: 'a claimed consent' },
  { d: 'consent', re: /\b(?:per|further to) your (?:request|enquiry|inquiry|enquiry form)\b/i, what: 'a claimed consent' },
  { d: 'consent', re: /\b(?:you're|you are) (?:receiving|getting) this because you\b/i, what: 'a claimed consent' },
  { d: 'consent', re: /\b(?:following up on|replying to) your (?:form|request|message|enquiry|inquiry)\b/i, what: 'a claimed consent' },
];

/**
 * Inspect one piece of variant content.
 *
 * Returns every finding, not just the first — someone fixing a variant should
 * see all of it in one pass rather than discovering the next one on resubmit.
 */
export function inspect(text = '') {
  const s = String(text == null ? '' : text);
  const findings = [];
  if (!s.trim()) return { ok: true, findings };

  for (const p of PATTERNS) {
    const m = s.match(p.re);
    if (!m) continue;
    const d = domain(p.d);
    if (findings.some((f) => f.domain === p.d && f.phrase === m[0])) continue;
    findings.push({
      domain: p.d,
      label: d ? d.label : p.d,
      what: p.what,
      phrase: m[0],
      rule: d ? d.rule : '',
      why: d ? d.why : '',
    });
  }
  return { ok: findings.length === 0, findings };
}

/** Every string an arm carries, inspected together. */
export function inspectVariant(variant = {}) {
  const parts = [];
  for (const k of ['label', 'subject', 'opening', 'body', 'cta', 'callToAction', 'content', 'text']) {
    if (variant && typeof variant[k] === 'string') parts.push({ field: k, text: variant[k] });
  }
  const findings = [];
  for (const part of parts) {
    for (const f of inspect(part.text).findings) findings.push({ ...f, field: part.field });
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Inspect a whole set of arms. The refusal message names the arm, the field
 * and the phrase, because "prohibited content" with nothing else in it is a
 * message that gets worked around rather than fixed.
 */
export function inspectVariants(variants = []) {
  const list = Array.isArray(variants) ? variants : [];
  const findings = [];
  for (const v of list) {
    const r = inspectVariant(v);
    for (const f of r.findings) findings.push({ ...f, variantId: v && v.id ? v.id : '(unnamed)' });
  }
  if (!findings.length) return { ok: true, findings };
  const f = findings[0];
  return {
    ok: false,
    findings,
    error:
      `Arm "${f.variantId}" varies ${f.label.toLowerCase()} — its ${f.field} contains ${f.what} ("${f.phrase}"). ` +
      `${f.rule} ${f.why}` +
      (findings.length > 1 ? ` (${findings.length - 1} other prohibited ${findings.length === 2 ? 'phrase' : 'phrases'} in this set.)` : ''),
  };
}

// ---------------------------------------------------------------------------
// Layer 3 — the write boundary
// ---------------------------------------------------------------------------
//
// Storage namespaces the optimisation path may never write to, whatever it
// thinks it is doing. Matched on prefix so a per-address or per-contact key
// under any of them is covered.

export const PROTECTED_KEYS = Object.freeze([
  { prefix: 'suppress:', domain: 'suppression' },
  { prefix: 'consent:', domain: 'consent' },
  { prefix: 'settings:business', domain: 'price' },   // pricing AND sender identity live here
  { prefix: 'budget:', domain: 'budget' },
  { prefix: 'optout:', domain: 'suppression' },
  { prefix: 'unsubscribe:', domain: 'suppression' },
]);

/**
 * May the optimisation path write to this key?
 *
 * Fails closed on anything it cannot read as a key: an unreadable target is
 * not a safe target, and "we could not tell what this was, so we wrote it" is
 * how the interesting outages happen.
 */
export function mayWrite(key) {
  if (typeof key !== 'string' || !key.trim()) {
    return { ok: false, reason: 'a write with no readable target cannot be checked against the prohibitions, so it is refused' };
  }
  const k = key.trim().toLowerCase();
  const hit = PROTECTED_KEYS.find((p) => k.startsWith(p.prefix));
  if (!hit) return { ok: true };
  const d = domain(hit.domain);
  return {
    ok: false,
    domain: hit.domain,
    reason:
      `"${key}" holds ${d ? d.label.toLowerCase() : hit.domain}, which the optimisation path may never write. ` +
      `${d ? d.rule : ''} ${d ? d.why : ''}`.trim(),
  };
}

/**
 * Is this change safe to revert?
 *
 * A revert writes a previous value back, so it is a write like any other and
 * gets the same check. Without this, the ledger is a way to write to a
 * protected namespace while bypassing that namespace's own guards.
 */
export function mayRevert(entry) {
  if (!entry) return { ok: false, reason: 'there is no change to revert' };
  return mayWrite(entry.target == null ? '' : String(entry.target));
}

/** For the interface: the six, with their reasons. */
export const describe = () => DOMAINS.map((d) => ({ ...d }));
