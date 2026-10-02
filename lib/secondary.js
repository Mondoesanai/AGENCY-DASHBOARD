// R9.3 — delivery, bounces, complaints, opt-outs, filtered clicks.
//
// These answer a different question from the primary outcomes, and the
// difference is the whole design. R9.2's ladder asks *did the message work?*
// This asks *did it arrive, and did it do harm?* — and the two must never be
// combined into one score, because a variant can win on replies while doing
// damage that costs the sending domain.
//
// Three rules:
//
//  1. A HARM SIGNAL NEVER IMPROVES A VARIANT'S STANDING.
//     Complaints and opt-outs are not "negative conversions" to be netted off
//     against replies. They are reported alongside, with their own direction,
//     and `harmful: true` on the record. A comparison that subtracts one from
//     the other is a comparison that will eventually recommend the message
//     that generates the most complaints, as long as it also gets more replies.
//
//  2. DELIVERY IS A DENOMINATOR, NOT AN ACHIEVEMENT.
//     "3 replies from 50 sent" is wrong if only 20 arrived. Delivery is
//     tracked so a rate can be computed over what was actually delivered —
//     and when delivery is unknown, the honest denominator is `sent`, said out
//     loud, rather than quietly pretending the two are the same.
//
//  3. A CLICK FROM A MACHINE IS NOT A CLICK.
//     Corporate security appliances and link scanners open every URL in every
//     message, often within seconds and often all of them at once. Counting
//     those as engagement makes the most aggressively-filtered recipients look
//     like the most interested ones. They are classified and counted apart.
//     (Not optimising for clicks at all is R9.4; being able to tell them apart
//     is the prerequisite.)

import { store } from './store.js';

export const DIRECTION = Object.freeze({
  HARM: 'harm',           // worse for us and worse for them
  DELIVERY: 'delivery',   // whether it arrived; not success or failure
  NEUTRAL: 'neutral',     // observed, means little on its own
});

export const SECONDARY = Object.freeze([
  {
    id: 'delivered',
    label: 'Delivered',
    direction: DIRECTION.DELIVERY,
    harmful: false,
    means: 'The provider accepted it and the receiving server took it. It does not mean anyone saw it.',
  },
  {
    id: 'bounced-hard',
    label: 'Hard bounce',
    direction: DIRECTION.DELIVERY,
    harmful: false,
    means: 'The address does not exist. This measures list quality, not message quality — a variant with more hard bounces was probably given worse addresses.',
  },
  {
    id: 'bounced-soft',
    label: 'Soft bounce',
    direction: DIRECTION.DELIVERY,
    harmful: false,
    means: 'A temporary condition — full mailbox, server busy. Not a reason to suppress anyone.',
  },
  {
    id: 'complained',
    label: 'Spam complaint',
    direction: DIRECTION.HARM,
    harmful: true,
    means: 'Someone pressed the spam button. This is the signal that ends sending domains, and it is the one secondary outcome that should stop an experiment on its own.',
  },
  {
    id: 'opted-out',
    label: 'Opt-out',
    direction: DIRECTION.HARM,
    harmful: true,
    means: 'They asked us to stop. Less severe than a complaint and the same direction: the message cost us a person.',
  },
  {
    id: 'click-human',
    label: 'Click (plausibly human)',
    direction: DIRECTION.NEUTRAL,
    harmful: false,
    means: 'A click that does not look automated. Still weak evidence — see R9.4 — and never a primary outcome.',
  },
  {
    id: 'click-filtered',
    label: 'Click (machine)',
    direction: DIRECTION.NEUTRAL,
    harmful: false,
    means: 'A scanner or security appliance opened the link. Counted separately so filtered recipients do not look like interested ones.',
  },
]);

export const secondaryFor = (id) => SECONDARY.find((s) => s.id === id) || null;
export const HARM_KINDS = Object.freeze(SECONDARY.filter((s) => s.harmful).map((s) => s.id));

// ---------------------------------------------------------------------------
// Telling a machine click from a person
// ---------------------------------------------------------------------------

/** User agents that announce themselves. Not exhaustive, and not relied on alone. */
const SCANNER_UA = /(bot|crawler|spider|scanner|proofpoint|mimecast|barracuda|symantec|forcepoint|microsoft office|ms-office|outlook-ios-?link|skypeuripreview|slackbot|googleimageproxy|yahoomailproxy|curl|wget|python-requests|headless)/i;

/**
 * Classify one click.
 *
 * The strongest signal is not the user agent — those can be anything — it is
 * SHAPE: a scanner opens every link in a message at once, within seconds of
 * delivery, before a human could plausibly have read it.
 *
 * @param {object} click
 * @param {number} click.at            when the click happened
 * @param {number} click.deliveredAt   when the message arrived
 * @param {string} click.userAgent
 * @param {number} click.linksInMessage how many distinct links the message had
 * @param {number} click.clickedLinks   how many were clicked in this burst
 */
export function classifyClick(click = {}) {
  const reasons = [];
  const ua = String(click.userAgent || '');

  if (SCANNER_UA.test(ua)) reasons.push(`the user agent identifies itself as automated (${ua.slice(0, 60)})`);

  const delta = click.deliveredAt && click.at ? click.at - click.deliveredAt : null;
  if (delta != null && delta >= 0 && delta < 10000) {
    reasons.push(`clicked ${Math.round(delta / 1000)}s after delivery, which is faster than a person opens mail`);
  }

  // every link at once is the signature of something walking the message
  if (click.linksInMessage > 1 && click.clickedLinks >= click.linksInMessage) {
    reasons.push(`every link in the message (${click.clickedLinks}) was opened in the same burst`);
  }

  if (!ua) reasons.push('no user agent was reported, so nothing identifies a browser');

  // "no user agent" alone is weak; it needs company before it decides anything
  const strong = reasons.filter((r) => !/no user agent/.test(r));
  const machine = strong.length > 0 || reasons.length >= 2;

  return {
    kind: machine ? 'click-filtered' : 'click-human',
    machine,
    reasons,
    // stated so a reader is not left thinking "human" means "interested"
    note: machine
      ? 'Counted as a machine click and kept out of the human column.'
      : 'Nothing marks this as automated. That is not evidence of interest — see R9.4.',
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record a secondary outcome against whichever experiment arm the contact is
 * in. Delegates storage to the experiments module so outcomes live in one
 * place, and refuses a kind that is not one of the seven.
 */
export async function recordSecondary({ experimentId, contactId, kind, at = Date.now(), evidence = null }) {
  const spec = secondaryFor(kind);
  if (!spec) return { ok: false, error: `"${kind}" is not a secondary outcome` };
  const { recordOutcome } = await import('./experiments.js');
  const out = await recordOutcome({
    experimentId,
    contactId,
    kind,
    at,
    evidence: { ...(evidence || {}), direction: spec.direction, harmful: spec.harmful },
  });
  return out.ok ? { ok: true, outcome: out.outcome, direction: spec.direction, harmful: spec.harmful } : out;
}

/** Fan one delivery event out to every running experiment. */
export async function recordSecondaryEverywhere({ contactId, kind, at = Date.now(), evidence = null }) {
  const results = [];
  try {
    const { listExperiments } = await import('./experiments.js');
    for (const exp of await listExperiments()) {
      if (exp.state !== 'running') continue;
      results.push(await recordSecondary({ experimentId: exp.id, contactId, kind, at, evidence }));
    }
  } catch { /* a delivery event must never fail because of an experiment */ }
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Secondary outcomes per arm, with harm kept visibly apart from everything
 * else, and the denominator question answered honestly.
 *
 * There is deliberately no "net" figure and no health score: both would have
 * to decide how many complaints a reply is worth.
 */
export function secondaryBreakdown(tallyResult) {
  if (!tallyResult?.ok) return { ok: false, error: tallyResult?.error || 'no tally' };

  const arms = (tallyResult.arms || []).map((arm) => {
    const counts = {};
    for (const s of SECONDARY) counts[s.id] = arm.outcomes?.[s.id] || 0;

    const delivered = counts.delivered;
    const assigned = arm.assigned || 0;
    const harm = HARM_KINDS.reduce((t, k) => t + counts[k], 0);

    return {
      variantId: arm.variantId,
      label: arm.label,
      assigned,
      counts,
      // harm is surfaced as its own figure, never folded into a score
      harmEvents: harm,
      harmKinds: HARM_KINDS.filter((k) => counts[k] > 0),
      // R9.3 rule 2 — say which denominator any rate would use, and whether
      // it is the honest one
      denominator: delivered > 0 ? { basis: 'delivered', value: delivered } : { basis: 'assigned', value: assigned },
      deliveryKnown: delivered > 0,
      deliveryNote: delivered > 0
        ? null
        : 'No delivery events have been seen for this arm, so any rate here is over what was ASSIGNED, not what arrived. Those are not the same number.',
    };
  });

  return {
    ok: true,
    experimentId: tallyResult.experimentId,
    arms,
    kinds: SECONDARY.map((s) => ({ id: s.id, label: s.label, direction: s.direction, harmful: s.harmful, means: s.means })),
    note:
      'Secondary outcomes say whether the message arrived and whether it did harm. They are never netted off against ' +
      'the primary outcomes: a variant that gets more replies AND more complaints has not won anything.',
  };
}

/**
 * Harm high enough to be worth stopping for.
 *
 * Returns a statement, not a decision — R9.9 owns auto-pause and its editable
 * thresholds. What this refuses to do is stay quiet: a complaint rate that
 * would end a sending domain is not something to leave in a counts table for
 * someone to notice.
 */
export function harmWarnings(breakdown, { complaintRate = 0.001, optOutRate = 0.02 } = {}) {
  if (!breakdown?.ok) return [];
  const out = [];
  for (const arm of breakdown.arms) {
    const base = arm.denominator.value || 0;
    if (base < 1) continue;
    const complaints = arm.counts.complained || 0;
    const optOuts = arm.counts['opted-out'] || 0;
    if (complaints / base > complaintRate) {
      out.push({
        variantId: arm.variantId,
        kind: 'complained',
        text: `${complaints} spam complaint${complaints === 1 ? '' : 's'} from ${base} ${arm.denominator.basis}. This is the signal that ends sending domains.`,
        severity: 'critical',
      });
    }
    if (optOuts / base > optOutRate) {
      out.push({
        variantId: arm.variantId,
        kind: 'opted-out',
        text: `${optOuts} opt-outs from ${base} ${arm.denominator.basis}. The message is costing people faster than it is winning them.`,
        severity: 'warn',
      });
    }
  }
  return out;
}
