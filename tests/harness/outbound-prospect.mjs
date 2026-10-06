// A prospect who genuinely belongs in the outbound segment.
//
// R19.5 added a segment gate to `maySend`: proactive outreach goes only to an
// established business with a VERIFIED website of its own. Tests about other
// parts of the send path — unsubscribe headers, idempotency, timeouts,
// integrity — build a contact as a means to an end, and a contact with no
// website evidence is now correctly refused before any of that is reached.
//
// This is the evidence those fixtures were always implying. It is a real
// `verifyWebsite` result shape, not a bypass: a test that wants to prove the
// gate refuses somebody builds a contact WITHOUT this.

import { WEB_STATUS } from '../../lib/discovery.js';

/**
 * The website check a discovered, verified business carries.
 *
 * `checkedAt` is recent on purpose — `mergeInto` keeps the newer check, and a
 * fixture dated zero would lose to anything already on the record.
 */
export const verifiedOwnSite = (host = 'verified-prospect.example') => ({
  status: WEB_STATUS.PRESENT,
  attempted: `https://${host}`,
  checkedAt: Date.now(),
  signals: ['business name', 'town name'],
  observation: 'the site loads and matches this business',
});

/** The listing fields that make a business read as a going concern. */
export const establishedFields = () => ({
  phone: '+15557770900',
  address: '12 Mill Street, Springfield',
  openingHours: 'Mo-Fr 09:00-17:00',
});

/** Everything `upsertContact` needs for a contact in the outbound segment. */
export function outboundProspectInput(extra = {}) {
  return {
    source: 'discovery',
    websiteCheck: verifiedOwnSite(),
    ...establishedFields(),
    ...extra,
  };
}
