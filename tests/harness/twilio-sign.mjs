// Build a correctly signed inbound-SMS request for the real collect handler.
//
// R18.1 — `/api/collect?hook=sms` now verifies the Twilio signature, because
// without it anyone could POST `From=<somebody else's number>&Body=PREVIEW` and
// be granted promotional consent for a number they do not own. Several tests
// predate that check and posted unsigned; rather than loosening the handler for
// them, they sign properly here.
//
// The signature is Twilio's documented scheme: the full URL the request was
// posted to, then every POST parameter sorted by name and concatenated without
// separators, HMAC-SHA1 with the auth token, base64.
import crypto from 'node:crypto';

export const TEST_AUTH_TOKEN = 'test-auth-token';

export function twilioSignature(url, params, token = TEST_AUTH_TOKEN) {
  const data = Object.keys(params || {}).sort()
    .reduce((acc, k) => acc + k + String(params[k] ?? ''), String(url));
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

/**
 * A request object shaped the way `api/collect.js` reads one, already signed.
 *
 * Sets `process.env.TWILIO_AUTH_TOKEN` is the CALLER's job — the handler fails
 * closed without it, which is itself behaviour worth testing, so this helper
 * does not quietly set it.
 */
export function signedInboundReq(params, { host = 'localhost', path = '/api/collect?hook=sms' } = {}) {
  const url = `https://${host}${path}`;
  return {
    method: 'POST',
    url: path,
    query: { hook: 'sms' },
    body: { ...params },
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': host,
      'x-twilio-signature': twilioSignature(url, params),
    },
  };
}
