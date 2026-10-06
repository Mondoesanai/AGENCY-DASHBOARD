// Receives tracking beacons from t.js and rolls them into daily counters.
// Cost: $0 — it's just your own function writing to your own KV store.
import '../lib/boot.js'; // patches console to redact secrets — must be first
import { guardSharedStore } from '../lib/environment.js';
import { store, dayKey } from '../lib/store.js';
import { slugify, slugForHost, rememberHost, matchExistingSite } from '../lib/registry.js';

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// For the site id: if the tracker sent a hostname (has a dot), turn it into a
// clean slug ("one-more-thing-gold.vercel.app" -> "one-more-thing-gold").
// If the owner set an explicit data-site="my-slug", keep it as-is.
function cleanSlug(s) {
  const raw = String(s || 'unknown').toLowerCase().trim();
  if (raw.includes('.')) return slugify(raw) || 'unknown';
  return (
    raw
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unknown'
  );
}

function refHost(ref) {
  if (!ref) return 'direct';
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '');
    if (!h) return 'direct';
    if (/google\./.test(h)) return 'google';
    if (/bing\./.test(h)) return 'bing';
    if (/duckduckgo/.test(h)) return 'duckduckgo';
    if (/facebook|fb\.com|instagram|t\.co|twitter|x\.com|linkedin|youtube|tiktok/.test(h))
      return 'social';
    return h;
  } catch {
    return 'other';
  }
}

export default async function handler(req, res) {
  // R18.2 — refuse to run against the live database from a non-production
  // deployment. Preview shares production's KV (see lib/environment.js).
  if (guardSharedStore(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // R7.8 — the scheduler webhook. It lives on this public function because
  // Calendly cannot authenticate with the dashboard password, so the SIGNATURE
  // is the only thing standing between a stranger's HTTP request and a record
  // the owner plans their week around. An unverified payload is refused, and
  // with no signing key configured nothing is trusted at all.
  // R6.6 / R11.5 — delivery receipts, bounces, complaints and unsubscribes from
  // the sending provider. Same discipline as the booking hook, through the one
  // shared helper so a second webhook cannot implement three of the four checks.
  // R6.9 — the unsubscribe link from a cold email. It lives on this public
  // function because someone who wants to stop hearing from us must never be
  // asked to authenticate, and because the 12-function limit leaves nowhere
  // else. GET renders a confirmation page and changes NOTHING: mail clients
  // and security scanners fetch links in messages, so a GET that unsubscribed
  // would let a scanner opt people out silently. POST performs it, which is
  // also exactly what RFC 8058 one-click sends.
  // R6.14 — inbound SMS from a prospect. Public because a carrier posts here,
  // and STOP must work whatever else is broken. The reply is returned as
  // TwiML, which is what Twilio expects; an empty <Response/> sends nothing.
  if (req.query?.hook === 'sms') {
    // R18.1 — VERIFY BEFORE READING. This hook had no signature check at all,
    // and that defeated the entire R17.2 fix.
    //
    // R17.2 made the web form grant nothing, on the grounds that only a message
    // FROM the handset proves possession — "the one thing a web page cannot
    // fake". But the channel carrying that proof was itself unauthenticated, so
    // anyone could POST `From=<somebody else's number>&Body=PREVIEW` here and
    // be granted PROMOTIONAL consent for a number they do not own. Worse than
    // the hole it was meant to close: the web form only ever created a pending
    // record, this granted the real thing.
    //
    // Fails closed without TWILIO_AUTH_TOKEN, which `verifyTwilioSignature`
    // already does. An inbound message that cannot be verified must not grant
    // consent, suppress a number, or queue a reply — and with no provider
    // configured there are no real inbound messages to lose.
    const { verifyTwilioSignature, claimEventOnce } = await import('../lib/webhooks.js');
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const v = verifyTwilioSignature({
      header: req.headers['x-twilio-signature'],
      url: `${proto}://${host}${req.url || ''}`,
      params: body,
      authToken: process.env.TWILIO_AUTH_TOKEN,
    });
    if (!v.ok) return res.status(401).json({ ok: false, error: v.reason });

    // Carriers retry. Without this, a retried inbound is processed again: a
    // second consent record, a second queued draft, a second conversation
    // entry. STOP is idempotent, so the retry that matters least is the only
    // one that was safe before.
    const sid = String(body.MessageSid || body.SmsSid || '');
    if (sid) {
      const once = await claimEventOnce('sms-inbound', sid);
      if (!once.fresh) {
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
        return res.status(200).send('<Response/>');
      }
    }

    const { handleInboundSms } = await import('../lib/sms-inbound.js');
    const out = await handleInboundSms({
      from: body.From || '',
      body: body.Body || '',
      business: process.env.OUTREACH_BUSINESS_NAME || '',
      supportEmail: process.env.OWNER_EMAIL || '',
    });
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    const esc = (t) => String(t || '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
    return res.status(200).send(out.reply ? `<Response><Message>${esc(out.reply)}</Message></Response>` : '<Response/>');
  }

  if (req.query?.unsub) {
    const { handleUnsubscribe, confirmPage, verifyToken } = await import('../lib/unsubscribe.js');
    const q = req.query || {};
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const address = String(body.e || q.e || '');
    const token = String(body.t || q.t || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      // do not leak whether an address is on the list: an invalid token still
      // renders the same page, and still does nothing
      return res.status(200).send(confirmPage({ address, token, done: false }));
    }
    const out = await handleUnsubscribe({ address, token });
    return res.status(out.ok ? 200 : 400).send(confirmPage({ address, token, done: true, ok: out.ok, message: out.message }));
  }

  // R13.4 — SMS delivery receipts.
  //
  // `applyDeliveryReceipt` existed, was tested, and had no caller: the one
  // thing it keeps apart — accepted by the provider versus actually delivered
  // to a handset — could therefore never be learned. A message the carrier
  // took and then failed to deliver stayed "accepted" forever, which is the
  // exact failure that function's own comment warns about: a number that is
  // silently failing looks healthy for a week.
  //
  // Public, because a carrier posts here and cannot authenticate. That makes
  // the signature the only thing standing between this and a stranger marking
  // a client's messages as failed, so it is verified before anything is read.
  if (req.query?.hook === 'sms-status') {
    const { verifyTwilioSignature, claimEventOnce } = await import('../lib/webhooks.js');
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    // Twilio signs the full URL it posted to, including the query string
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const url = `${proto}://${host}${req.url || ''}`;

    const v = verifyTwilioSignature({
      header: req.headers['x-twilio-signature'],
      url, params: body,
      authToken: process.env.TWILIO_AUTH_TOKEN,
    });
    if (!v.ok) return res.status(401).json({ ok: false, error: v.reason });

    const providerId = String(body.MessageSid || body.SmsSid || '');
    const status = String(body.MessageStatus || body.SmsStatus || '');
    if (!providerId || !status) return res.status(400).json({ ok: false, error: 'MessageSid and MessageStatus are required' });

    // Carriers retry. The same receipt applied twice is harmless for a state
    // change, but it would duplicate history entries, and a retried `failed`
    // after a later `delivered` would walk the state backwards.
    const once = await claimEventOnce('sms-status', `${providerId}:${status}`);
    if (!once.fresh) return res.status(200).json({ ok: true, duplicate: true });

    const { applyDeliveryReceipt } = await import('../lib/sms-send.js');
    const out = await applyDeliveryReceipt({
      providerId, status,
      errorCode: body.ErrorCode ? String(body.ErrorCode) : null,
    });
    // 200 even when nothing matched: a receipt for a message we do not hold is
    // not an error the carrier can act on, and a non-200 makes it retry forever
    return res.status(200).json(out);
  }

  if (req.query?.hook === 'delivery') {
    const { acceptWebhook } = await import('../lib/webhooks.js');
    const { applyDeliveryEvent } = await import('../lib/outreach-email.js');
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    let event = {};
    try { event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch { event = {}; }

    const verdict = await acceptWebhook({
      scope: 'delivery',
      header: req.headers['x-webhook-signature'],
      rawBody,
      signingKey: process.env.OUTREACH_WEBHOOK_KEY,
      eventId: event.id || event.event_id,
      subject: event.email ? String(event.email).toLowerCase() : null,
      stamp: Number(event.at || event.timestamp) || Date.now(),
    });
    if (!verdict.accept) return res.status(verdict.status).json({ ok: verdict.status === 200, error: verdict.reason });

    const out = await applyDeliveryEvent({
      type: event.type,
      email: event.email,
      hard: event.hard !== false,
      campaignId: event.campaignId || null,
    });
    return res.status(out.ok ? 200 : 400).json(out);
  }

  // R17.1 — the web/QR opt-in. Public for the same reason the unsubscribe link
  // is public: the person giving permission is not a user of this system and
  // must never be asked to authenticate.
  //
  // The terms are served from the same function that records them, so the text
  // somebody agrees to and the text stored with their consent cannot drift.
  if (req.query?.hook === 'optin-terms') {
    const { publishedTerms, OPTIN_KEYWORD } = await import('../lib/optin-public.js');
    const { getSettings } = await import('../lib/settings.js');
    const { smsReadiness } = await import('../lib/sms-outreach.js');
    const s = await getSettings().catch(() => null);

    // R18.1 — the page must not promise that texting a keyword will work when
    // there is no number to text, no webhook pointed here, or no approved
    // campaign. Somebody who texts PREVIEW into a void gets no confirmation and
    // no preview, and concludes the business is broken — having already given
    // their number. `smsReadiness` already knows all three; the page just has to
    // be told, and the terms are still returned so the page can show what the
    // programme WILL be.
    const readiness = await smsReadiness().catch(() => ({ ready: false, blockers: [{ code: 'unknown', text: 'readiness could not be checked' }] }));
    return res.status(200).json({
      ok: true,
      terms: publishedTerms({ business: s?.business?.name || undefined }),
      keyword: OPTIN_KEYWORD,
      // The page branches on this. Deliberately not a list of blocker text:
      // those name internal environment variables and are for the owner, not
      // for a prospect standing in a shop.
      smsLive: readiness.ready === true,
      to: readiness.ready ? (process.env.TWILIO_SMS_FROM || null) : null,
    });
  }

  if (req.query?.hook === 'optin') {
    // GET renders nothing and changes nothing. A scanner or a link preview
    // fetching this must never enrol somebody, which is the same rule the
    // unsubscribe link follows in the opposite direction.
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'POST only — a fetched link must never enrol anyone' });
    }
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});

    // R17.2 — a public write needs a ceiling. Without one, this endpoint is a
    // free way to fill KV with pending records, and a way to hammer the number
    // of a person somebody dislikes. Two limits, because they stop different
    // abuses: per-number stops one victim being targeted repeatedly, per-caller
    // stops one source enumerating many numbers.
    const { rateLimit } = await import('../lib/ratelimit.js');
    const caller = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const perNumber = await rateLimit(`optin:num:${String(body.phone || '').replace(/\D/g, '')}`, { max: 3, windowSec: 3600 });
    const perCaller = await rateLimit(`optin:ip:${caller}`, { max: 10, windowSec: 3600 });
    // FAIL CLOSED on a store outage. Enrolment is a new permission being
    // created; an outage is the one moment when nothing about it can be checked
    // — not the suppression list, not how many times this number has already
    // been submitted. Refusing costs somebody a retry. Allowing it creates a
    // permission record nobody could verify. STOP is unaffected: it arrives at
    // `?hook=sms`, which is not rate-limited by anything.
    if (perNumber.degraded || perCaller.degraded) {
      return res.status(503).json({
        ok: false,
        error: 'we cannot sign anyone up at the moment — please try again shortly',
        retryable: true,
      });
    }
    if (!perNumber.ok || !perCaller.ok) {
      // One message for both, so the response cannot be used to tell which limit
      // was hit and therefore whether a number has been submitted before.
      return res.status(429).json({ ok: false, error: 'too many requests — please try again later' });
    }

    const { recordWebOptIn, OPTIN_KEYWORD } = await import('../lib/optin-public.js');
    const { getSettings } = await import('../lib/settings.js');
    const s = await getSettings().catch(() => null);
    const out = await recordWebOptIn({
      phone: body.phone,
      name: body.name,
      agreed: body.agreed === true,
      pageUrl: body.pageUrl,
      business: s?.business?.name || undefined,
      // No contact lookup: the form grants nothing, so there is nothing to
      // attach, and looking a number up here would make the endpoint able to
      // confirm whether we hold somebody.
    });
    // Never echo back whether the number was already known, and never say that
    // a suppressed number was suppressed: both would turn this public form into
    // a way of testing whether we hold a given person.
    return res.status(out.ok ? 200 : 400).json(
      out.ok
        ? { ok: true, pending: true, keyword: OPTIN_KEYWORD, to: process.env.TWILIO_SMS_FROM || null }
        : { ok: false, error: out.needsPerson ? 'that number cannot be signed up here' : out.error, why: out.why || undefined },
    );
  }

  // R19.1/R19.2 — the branded preview-request page.
  //
  // Public for the same reason the opt-in and unsubscribe pages are: the person
  // using it is a prospect, not a user of this system, and must never be asked
  // to authenticate.
  //
  // `slots` reads genuine availability. It returns `connected: false` rather
  // than an empty list when no calendar is configured, because an empty list
  // reads as "fully booked" and the page has to be able to say the honest
  // thing instead: this is a call request, not a confirmed appointment.
  if (req.query?.hook === 'slots') {
    const { getScheduler } = await import('../lib/scheduling.js');
    const { consentCopy } = await import('../lib/request-sms.js');
    const sched = await getScheduler({});
    const out = await sched.availability({ visitorTz: String(req.query.tz || '') || null });
    return res.status(200).json({
      ok: true,
      connected: out.connected !== false,
      provider: sched.name,
      reason: out.reason || null,
      // The page quotes a maximum number of texts. It comes from here so the
      // number shown is the number `claimRequestText` actually enforces.
      smsConsent: consentCopy({}),
      // Absolute instants. The page renders them in the visitor's own zone; the
      // server does not guess what that is.
      slots: (out.slots || []).map((s) => ({ startAt: s.startAt, minutes: s.minutes, kind: s.kind })),
      timezone: out.timezone || null,
      previewLeadHours: out.rules?.previewLeadHours ?? null,
    });
  }

  // An opaque prefill reference. The CRM may already know this business, and
  // retyping it is friction — but the reference is a random id, NEVER the
  // contact id and never anything personal, so a shared or guessed link cannot
  // reveal somebody else's details. Only business-level fields come back.
  if (req.query?.hook === 'prefill') {
    const { readPrefill } = await import('../lib/preview-request.js');
    const out = await readPrefill(String(req.query.ref || ''));
    return res.status(200).json(out);
  }

  if (req.query?.hook === 'request') {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'POST only — a fetched link must never book anything' });
    }
    const body = typeof req.body === 'string'
      ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
      : (req.body || {});

    // Same ceiling and same fail-closed rule as the opt-in write: a public
    // endpoint that creates records needs a limit, and an outage is the one
    // moment when nothing about a submission can be checked.
    const { rateLimit } = await import('../lib/ratelimit.js');
    const caller = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const perCaller = await rateLimit(`req:ip:${caller}`, { max: 12, windowSec: 3600 });
    const perEmail = await rateLimit(`req:em:${String(body.email || '').toLowerCase()}`, { max: 4, windowSec: 3600 });
    if (perCaller.degraded || perEmail.degraded) {
      return res.status(503).json({ ok: false, error: 'we cannot take requests at the moment — please try again shortly', retryable: true });
    }
    if (!perCaller.ok || !perEmail.ok) {
      return res.status(429).json({ ok: false, error: 'too many requests — please try again later' });
    }

    const { submitRequest } = await import('../lib/preview-request.js');
    const out = await submitRequest(body, { ip: caller });
    return res.status(out.ok ? 200 : (out.status || 400)).json(out);
  }

  if (req.query?.hook === 'booking') {
    const { verifyCalendlySignature, handleBookingWebhook } = await import('../lib/bookings.js');
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const v = verifyCalendlySignature({
      header: req.headers['calendly-webhook-signature'],
      rawBody,
      signingKey: process.env.CALENDLY_WEBHOOK_KEY,
    });
    if (!v.ok) return res.status(401).json({ ok: false, error: v.reason });
    let event = {};
    try { event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch { event = {}; }
    const out = await handleBookingWebhook({ event, verified: true });
    return res.status(out.ok ? 200 : 400).json(out);
  }

  let d = {};
  try {
    d = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    d = {};
  }
  // also accept querystring (pixel fallback)
  if (req.method === 'GET') d = { ...req.query };

  // bare GET with no site id => a human is checking the endpoint is reachable
  if (req.method === 'GET' && !d.s) {
    return res
      .status(200)
      .json({ ok: true, message: 'Tracker endpoint is reachable. Beacons POST here from t.js.' });
  }

  // hostname the beacon came from — prefer the real origin, fall back to the id
  let host = '';
  try {
    host = new URL(d.u || '').hostname;
  } catch {
    host = String(d.s || '');
  }
  // one host = one slug: if this host is already known (e.g. it was "Added" in
  // the UI, or auto-registered earlier), route this beacon to that same slug.
  // If it's a host we've never seen, check whether it's really just an
  // alternate hostname (custom domain vs. raw .vercel.app) of a site we
  // already track before creating a brand new entry — this is what stops
  // the same project from ending up registered twice.
  const slug =
    (await slugForHost(host || d.s).catch(() => null)) ||
    (host && (await matchExistingSite(host).catch(() => null))) ||
    cleanSlug(d.s);
  if (slug === 'unknown') return res.status(400).json({ ok: false, error: 'missing site id' });

  const type = d.e === 'ev' ? 'ev' : d.e === 'dur' ? 'dur' : 'pv';
  const path = String(d.p || '/').slice(0, 120);
  const width = Number(d.w) || 0;
  const day = dayKey();

  const ua = req.headers['user-agent'] || '';
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';
  // cookieless daily-rotating visitor id (privacy friendly)
  const visitor = hash(ip + '|' + ua + '|' + day + '|' + slug);

  const p = `site:${slug}`;
  const tasks = [store.pfadd(`${p}:day:${day}:uv`, visitor)];

  // auto-register the site on ANY beacon (pageview or event) so it shows up on
  // the dashboard within seconds of the snippet going live — no "Add site" needed.
  let origin = '';
  try {
    origin = new URL(d.u || '').origin;
  } catch {
    origin = '';
  }
  tasks.push(store.sadd('registry:slugs', slug));
  tasks.push(
    store.set(
      `meta:${slug}`,
      JSON.stringify({ slug, url: origin || `https://${slug}`, lastSeen: Date.now() })
    )
  );
  if (host) tasks.push(rememberHost(host, slug)); // seed the host->slug index

  // UTM-derived source (from t.js, persisted for the session) wins when
  // present — it's more precise than referrer alone (distinguishes paid vs
  // organic on the same domain). Falls back to referrer classification.
  const utmSrc = String(d.src || '').slice(0, 40);
  const source = utmSrc || refHost(d.r);

  if (type === 'pv') {
    tasks.push(store.incr(`${p}:day:${day}:pv`));
    tasks.push(store.zincr(`${p}:day:${day}:paths`, path));
    tasks.push(store.zincr(`${p}:day:${day}:refs`, source));
    if (width) {
      tasks.push(store.incr(`${p}:day:${day}:${width < 768 ? 'mobile' : 'desktop'}`));
    }
  } else if (type === 'dur') {
    // engaged seconds on a page — for the "Time on site" metric
    const secs = Math.max(0, Math.min(1800, Math.round(Number(d.d) || 0)));
    if (secs > 0) {
      tasks.push(store.incr(`${p}:day:${day}:dursum`, secs));
      tasks.push(store.incr(`${p}:day:${day}:durcnt`));
    }
  } else {
    const name = cleanSlug(d.n || 'click') || 'click';
    tasks.push(store.incr(`${p}:day:${day}:ev:${name}`));
    tasks.push(store.zincr(`${p}:day:${day}:events`, name));
    // which channel this specific conversion-worthy click came from — "lead
    // source" isn't just where traffic comes from, it's where the actual
    // enquiries come from, which can be a very different ranking.
    tasks.push(store.zincr(`${p}:day:${day}:leadsrc`, source));
  }

  try {
    await Promise.all(tasks);
  } catch {
    /* never break the client site over analytics */
  }

  // A client's on-page star-rating widget can submit the actual rating/name/
  // text here (name === "submit-review") so it's kept somewhere real, not just
  // counted as a click. No client site did this before — the widget existed
  // but never sent its content anywhere.
  if (type === 'ev' && String(d.n || '') === 'submit-review' && d.rt) {
    const rating = Math.max(1, Math.min(5, Math.round(Number(d.rt)) || 0));
    if (rating) {
      const review = {
        rating,
        name: String(d.rn || '').replace(/[<>]/g, '').trim().slice(0, 60),
        text: String(d.rx || '').replace(/[<>]/g, '').trim().slice(0, 600),
        path,
        at: Date.now(),
      };
      try {
        const raw = await store.get(`reviews:${slug}`);
        const list = (() => {
          try {
            const a = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
            return Array.isArray(a) ? a : [];
          } catch {
            return [];
          }
        })();
        list.push(review);
        await store.set(`reviews:${slug}`, JSON.stringify(list.slice(-200)));
      } catch {
        /* never break the client site over review storage */
      }
    }
  }

  res.status(200).json({ ok: true });
}
