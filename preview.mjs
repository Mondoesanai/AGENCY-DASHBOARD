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

process.env.CRON_SECRET = process.env.PREVIEW_PASSWORD || 'preview';
process.env.OUTREACH_WEBHOOK_KEY = 'preview-hook-key';
process.env.UNSUBSCRIBE_SECRET = 'preview-unsub-key';

const remote = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (remote) {
  console.error('\nREFUSED: a remote store is configured in this shell, and the preview seeds demo data.');
  console.error('Unset KV_REST_API_URL / KV_REST_API_TOKEN / UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.\n');
  process.exit(1);
}

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

const api = await startLocalApi({ port: PORT });

console.log(`
  ───────────────────────────────────────────────────────────
   LOCAL PREVIEW — fixture data, in-memory store
   ${api.origin}
   password: ${process.env.CRON_SECRET}
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
