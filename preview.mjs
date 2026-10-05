// A local preview of the real dashboard, with demo data.
//
//   node preview.mjs          then open http://localhost:3190
//
// WHAT THIS IS. The real `api/` handlers and the real `public/` page, served
// from your machine against an IN-MEMORY store. Every number on screen comes
// from the real modules; none of it touches production, and nothing can be
// sent to anyone.
//
// WHY NOT A VERCEL PREVIEW. The project's Preview environment currently shares
// production's database credentials (`KV_REST_API_*`, `KV_URL`, `REDIS_URL`
// are scoped to Production AND Preview), and `/api/admin?do=auto-poke` runs
// before the password gate. A preview deployment would therefore be able to
// run the real automation against live client data. Until Preview has its own
// store, this is the safe way to look at the thing.
//
// EVERYTHING HERE IS FIXTURE DATA. The clients, contacts, cards and
// conversations below are invented. Addresses use `.example`, numbers use the
// 555-02xx range, and no provider is connected — so the SMS composer will
// correctly refuse to send, which is itself part of what there is to see.

// ---------------------------------------------------------------------------
// NO PASSWORD, AND WHY THAT IS SAFE HERE
//
// `CRON_SECRET` is deliberately NOT set. `lib/auth.js` then reports mode
// 'open' — but only because it also checks that VERCEL/VERCEL_ENV are absent,
// which they can never be on a deployment. So this is not a bypass bolted on
// for convenience: it is the existing local-development posture, and the
// production path is untouched and still enforced.
//
// Three things are checked before the server starts. If any of them fails the
// preview refuses to run rather than starting something unsafe:
//
//   1. no deployment environment — VERCEL/VERCEL_ENV absent
//   2. no remote storage configured — nothing can reach production data
//   3. no outbound provider credentials present — nothing can be sent
//
// The page cannot turn authentication off: it asks the server what the mode
// is and does as it is told. There is no query parameter, header or flag a
// browser could send to get the same effect.
// ---------------------------------------------------------------------------
delete process.env.CRON_SECRET;

const refuse = (why, fix) => {
  console.error(`\n  REFUSED TO START — ${why}\n`);
  console.error(`  ${fix}\n`);
  console.error('  The preview runs without a password, so it will only start when it can');
  console.error('  prove it is isolated. This check failing is the check working.\n');
  process.exit(1);
};

if (process.env.VERCEL || process.env.VERCEL_ENV) {
  refuse(
    'this looks like a deployment environment (VERCEL is set).',
    'The no-password preview is for a local machine only. Never run it on a deployment.'
  );
}

const remoteStore = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_URL', 'REDIS_URL']
  .filter((k) => process.env[k]);
if (remoteStore.length) {
  refuse(
    `remote storage is configured in this shell (${remoteStore.join(', ')}).`,
    'The preview seeds sample data and must never write to your real database. Unset those variables, or run it in a clean shell.'
  );
}

const providerKeys = ['INSTANTLY_API_KEY', 'RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM']
  .filter((k) => process.env[k]);
if (providerKeys.length) {
  refuse(
    `outbound provider credentials are present in this shell (${providerKeys.join(', ')}).`,
    'The preview must not be able to reach a real provider. Unset those variables, or run it in a clean shell.'
  );
}

// Signing keys that only exist so the local webhook/unsubscribe paths are
// exercisable. They are fixed, local, and worthless off this machine.
process.env.OUTREACH_WEBHOOK_KEY = 'preview-local-only-hook-key';
process.env.UNSUBSCRIBE_SECRET = 'preview-local-only-unsub-key';

const PORT = Number(process.env.PORT) || 3190;
const { store } = await import('./lib/store.js');
const { startLocalApi } = await import('./tests/harness/local-api.mjs');

const DAY = 24 * 3600e3;
const NOW = Date.now();
const F = (v) => ({ value: v, confidence: 0.93, source: 'card' });

// ---- two clients ----------------------------------------------------------
const { saveSiteConfig } = await import('./lib/registry.js');
await saveSiteConfig('acme-roofing', { name: 'Acme Roofing', url: 'https://acme.example', seoAgent: true, repo: 'Mondoesanai/acme' });
await saveSiteConfig('beta-plumbing', { name: 'Beta Plumbing', url: 'https://beta.example', seoAgent: true, repo: '' });

// ---- a networking event: four cards, four different outcomes --------------
const { saveCards } = await import('./lib/card-intake.js');
const { ENCOUNTER, INTEREST } = await import('./lib/relationship.js');
const saved = await saveCards([
  { name: F('Jordan Hale'), businessName: F('Hale Flooring'), email: F('jordan@haleflooring.example'), phone: F('+12145550201'), website: F('https://haleflooring.example') },
  { name: F('Priya Raman'), businessName: F('Raman Roofing'), email: F('priya@ramanroofing.example'), phone: F('+12145550202') },
  { name: F('Chris Okafor'), businessName: F('Okafor HVAC'), email: F('chris@okaforhvac.example'), phone: F('+12145550203') },
  { name: F('Lee Chan'), businessName: F('Chan Landscaping'), email: F('lee@chanlandscaping.example'), phone: F('+12145550204'), website: F('https://chanlandscaping.example') },
], {
  relationship: 'met_in_person',
  event: 'Plano Chamber breakfast',
  collectedAt: new Date(NOW - 2 * DAY).toISOString(),
  meetingNotes: 'Plano Chamber breakfast',
  interactions: {
    0: { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.PREVIEW, requestedNextStep: 'send the preview', promisedFollowUpAt: NOW - DAY, notes: 'Owns a flooring company. Wants an easier way for customers to request quotes.' },
    1: { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.CONVERSATION, notes: 'Asked what it costs.' },
    2: { encounter: ENCOUNTER.SHARED_GROUP, networkingGroup: 'Plano BNI', notes: 'Same chapter. Never actually met.' },
    3: { encounter: ENCOUNTER.CONVERSATION, hasGoodWebsite: true, notes: 'Site already works well.' },
  },
});

// ---- a conversation in progress -------------------------------------------
const { record, CHANNEL, DIRECTION } = await import('./lib/conversations.js');
const jordan = saved[0].contact.id;
await record({ contactId: jordan, channel: CHANNEL.SMS, direction: DIRECTION.OUT, body: "Hey Jordan, it's Mondoe with Inspiring Websites — we met at the Plano Chamber breakfast. You mentioned wanting an easier way for customers to request quotes. Want me to send the preview here when it's ready?", by: 'owner', at: NOW - 6 * 3600e3, state: 'delivered' });
await record({ contactId: jordan, channel: CHANNEL.SMS, direction: DIRECTION.IN, body: 'Yes please — send it here.', at: NOW - 5 * 3600e3 });

// loopback only: not reachable from the network, which matters because there
// is no password on it
const api = await startLocalApi({ port: PORT, host: '127.0.0.1' });

console.log(`
  ───────────────────────────────────────────────────────────
   LOCAL PREVIEW — no password, sample data, in-memory store
   ${api.origin}
   bound to 127.0.0.1 only · not reachable from your network
  ───────────────────────────────────────────────────────────

   Worth looking at:
     Follow-ups    four people from one event, four different paths,
                   each with the reason, the next action and the date.
                   One preview promised and not built.
     Conversations Jordan's thread. Try "Check it" in the composer —
                   it will REFUSE, because a business card is not SMS
                   consent. That refusal is the feature.
     Acquisition   contacts, intake, prospects, campaigns, bookings.
     Automations   worker check-ins and the experiment ledger.

   Nothing here can reach production. No provider is connected, so
   nothing can be sent. Ctrl-C to stop.
`);

process.on('SIGINT', async () => { await api.stop(); process.exit(0); });
