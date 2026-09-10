// Create / update / delete a client site, plus builder notes and the
// "what we did this month" changelog. All writes require CRON_SECRET.
import { store } from '../lib/store.js';
import {
  saveSiteConfig, deleteSiteConfig, getSiteConfig, slugify, listSites,
  hostKey, slugForHost, rememberHost,
} from '../lib/registry.js';

const normEvent = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

async function readList(key) {
  const raw = await store.get(key).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// Store a "former client" record when a site is removed because the client left.
// body.churn: { reason: 'cancelled'|'test'|..., leftDate: 'YYYY-MM-DD', note }
async function recordChurn(slug, churn) {
  if (!churn || !churn.reason || churn.reason === 'test' || churn.reason === 'mistake') return;
  const cfg = (await getSiteConfig(slug)) || {};
  const startedAt = cfg.startedAt || cfg.addedAt || Date.now();
  const left = Date.parse(churn.leftDate) || Date.now();
  const monthsActive = Math.max(1, Math.round((left - startedAt) / (30 * 864e5)));
  const rec = {
    slug,
    name: cfg.name || slug,
    client: cfg.client || '',
    reason: String(churn.reason).slice(0, 30),
    note: String(churn.note || '').slice(0, 300),
    leftDate: new Date(left).toISOString().slice(0, 10),
    startedAt,
    monthsActive,
    priceMonthly: cfg.priceMonthly || 0,
    setupFee: cfg.setupFee || 0,
    leadSource: cfg.leadSource || '',
    lifetimeRevenue: (cfg.setupFee || 0) + (cfg.priceMonthly || 0) * monthsActive,
    recordedAt: Date.now(),
  };
  await store.set(`churn:${slug}`, JSON.stringify(rec));
  await store.sadd('churn:index', slug);
}

// Turn a plain-English "what counts as a conversion" description into a real
// event name + setup instructions, by looking at the site's actual HTML.
async function analyzeConversion({ site, description }) {
  const desc = String(description || '').trim();
  if (!desc) return { ok: false, error: 'describe the action first' };

  let html = '';
  try {
    const r = await fetch(site.url, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
    html = (await r.text()).slice(0, 45000);
  } catch {
    html = '';
  }
  // pull the interactive bits so the model has a compact view
  const bits = (html.match(/<(a|button|form|input)[^>]*>[^<]{0,60}/gi) || []).slice(0, 120).join('\n');

  const fallback = () => {
    const name = normEvent(desc) || 'conversion';
    return {
      ok: true,
      ai: false,
      event_name: name,
      needs_data_track: true,
      instruction: `Add data-track="${name}" to the element the visitor clicks for "${desc}". Then this event will count.`,
      explanation: `Saved "${name}" as a counted conversion. The tracker already auto-detects phone / text / email / WhatsApp / booking / review links and form submits — if "${desc}" is one of those it will just work. Otherwise add the data-track attribute above.`,
    };
  };

  if (!process.env.ANTHROPIC_API_KEY) return fallback();
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    return fallback();
  }
  try {
    const client = new Anthropic();
    const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
    const sys =
      'You configure conversion tracking for a small analytics tool. The tracker fires an ' +
      '"event" and AUTO-DETECTS these without any setup: phone links (event "call"), sms ("text"), ' +
      'mailto ("email"), WhatsApp ("whatsapp"), Calendly/Cal.com/Acuity/booking links ("booking"), ' +
      'Google-review / "leave a review" links ("review-click"), Google-Maps links ("directions"), ' +
      'and any form submit ("form-<name>"). For anything else the site owner adds data-track="name" ' +
      'to the element. Given the owner\'s plain-English description and a slice of the page HTML, ' +
      'return ONLY minified JSON: {"event_name":string (short kebab slug),"needs_data_track":boolean,' +
      '"matched_element":string (short description of the element you found, or ""),' +
      '"instruction":string (exact, copy-pasteable thing for the web developer to do — or ' +
      '"Nothing to do — it is auto-detected." ),"explanation":string (1-2 plain sentences for a ' +
      'non-technical owner)}.';
    const user = `Business: ${site.name}\nURL: ${site.url}\nOwner wants to count as a conversion: "${desc}"\n\nInteractive elements on the page:\n${bits || '(could not fetch the page)'}`;
    const r = await client.messages.create({
      model,
      max_tokens: 700,
      system: sys,
      messages: [{ role: 'user', content: user }],
    });
    const txt = r.content.find((b) => b.type === 'text')?.text || '';
    const j = JSON.parse(txt.replace(/^```json\s*|\s*```$/g, '').trim());
    j.event_name = normEvent(j.event_name) || normEvent(desc) || 'conversion';
    return { ok: true, ai: true, ...j };
  } catch {
    return fallback();
  }
}

function authed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}` || req.query.secret === secret || (req.body && req.body.secret === secret);
}

async function readNotes(slug) {
  const n = await store.get(`notes:${slug}`).catch(() => null);
  return typeof n === 'string' ? n : '';
}
async function readLog(slug) {
  const raw = await store.get(`changelog:${slug}`).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad secret' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    body = {};
  }
  const action = body.action || 'save';

  try {
    if (action === 'save') {
      let slug = (body.slug || slugify(body.url || body.name || '')).trim();
      if (!slug) return res.status(400).json({ ok: false, error: 'need a url or name' });
      // if this exact site already exists (added before, OR auto-registered by
      // the tracker) reuse THAT slug so we update one entry instead of forking a
      // duplicate. Only do this for brand-new adds (no explicit body.slug).
      if (!body.slug && body.url) {
        const existing = await slugForHost(body.url).catch(() => null);
        if (existing) slug = existing;
        else {
          const wantHost = hostKey(body.url);
          const auto = (await listSites()).find((s) => s.source === 'auto' && hostKey(s.url) === wantHost);
          if (auto) slug = auto.slug;
        }
      }
      const pass = (k) => body[k] !== undefined;
      const patch = {
        url: body.url,
        name: body.name || slug,
        client: body.client || '',
        email: body.email || '',
        phone: body.phone || '',
        priceMonthly: body.priceMonthly,
        setupFee: body.setupFee,
        startedAt: body.startedAt,
        trialEnds: body.trialEnds,
        billingDay: body.billingDay,
        autoSend: body.autoSend,
        leadValue: body.leadValue,
        reviewUrl: body.reviewUrl || '',
        conversionEvents: body.conversionEvents,
      };
      // only forward these when the caller sent them (modal vs settings vs API)
      for (const k of ['leadSource', 'leadSourceDate', 'repo', 'seoAgent', 'agentAutoMerge', 'agentKeywords', 'agentBudget', 'agentCap', 'revisionsAuto']) {
        if (pass(k)) patch[k] = body[k];
      }

      // brand-new site, no repo given → try to auto-find it on GitHub
      let repoMatch = null;
      const before = await getSiteConfig(slug).catch(() => null);
      if (!patch.repo && !(before && before.repo) && (body.url || (before && before.url))) {
        try {
          const { findRepoForUrl } = await import('../lib/github.js');
          const g = await findRepoForUrl(body.url || before.url);
          if (g && g.ok && g.match) {
            patch.repo = g.match;
            repoMatch = g.match;
          }
        } catch {
          /* github optional */
        }
      }

      const cfg = await saveSiteConfig(slug, patch);
      return res.status(200).json({ ok: true, site: cfg, repoMatch });
    }

    if (action === 'delete') {
      if (!body.slug) return res.status(400).json({ ok: false, error: 'need slug' });
      await recordChurn(body.slug, body.churn);
      await deleteSiteConfig(body.slug);
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete-many') {
      const slugs = Array.isArray(body.slugs) ? body.slugs.filter(Boolean).slice(0, 50) : [];
      if (!slugs.length) return res.status(400).json({ ok: false, error: 'need slugs' });
      const churnMap = body.churn && typeof body.churn === 'object' ? body.churn : {};
      for (const slug of slugs) {
        await recordChurn(slug, churnMap[slug]);
        await deleteSiteConfig(slug);
      }
      return res.status(200).json({ ok: true, removed: slugs.length });
    }

    if (action === 'merge') {
      const keep = slugify(body.keep || '');
      const drop = slugify(body.drop || '');
      if (!keep || !drop || keep === drop) return res.status(400).json({ ok: false, error: 'need keep + drop' });
      // pull config/ancillary data off the "drop" site onto "keep" (visitor
      // counters already live under whichever slug — we don't move those)
      const [dcfg, kcfg] = await Promise.all([getSiteConfig(drop), getSiteConfig(keep)]);
      const src = dcfg || {};
      const patch = {};
      for (const f of ['url', 'name', 'client', 'email', 'phone', 'priceMonthly', 'setupFee',
        'startedAt', 'trialEnds', 'billingDay', 'leadValue', 'reviewUrl', 'autoSend']) {
        if (src[f] !== undefined && src[f] !== '' && src[f] !== null && !(kcfg && kcfg[f])) patch[f] = src[f];
      }
      if (src.conversionEvents?.length && !(kcfg && kcfg.conversionEvents?.length))
        patch.conversionEvents = src.conversionEvents.join(', ');
      if (!patch.url && kcfg?.url) patch.url = kcfg.url;
      await saveSiteConfig(keep, patch);
      // move notes / changelog / expenses only if keep doesn't already have them
      for (const k of ['notes', 'changelog', 'expenses', 'baseline']) {
        const [s, d] = await Promise.all([store.get(`${k}:${drop}`), store.get(`${k}:${keep}`)]);
        if (s && !d) await store.set(`${k}:${keep}`, s);
      }
      // point both hostnames at the kept slug
      if (src.url) await rememberHost(src.url, keep);
      if (kcfg?.url || patch.url) await rememberHost(kcfg?.url || patch.url, keep);
      await deleteSiteConfig(drop);
      return res.status(200).json({ ok: true, keep });
    }

    if (action === 'expense-add' || action === 'expense-del') {
      // slug '_business' => company overhead not tied to a client
      const slug = body.slug === '_business' ? '_business' : slugify(body.slug || '');
      if (!slug) return res.status(400).json({ ok: false, error: 'need slug' });
      const key = `expenses:${slug}`;
      const list = await readList(key);
      if (action === 'expense-add') {
        const amt = Math.max(0, Number(String(body.amount).replace(/[^0-9.]/g, '')) || 0);
        if (!amt) return res.status(400).json({ ok: false, error: 'need amount' });
        list.push({
          amount: amt,
          label: String(body.label || 'expense').slice(0, 80),
          kind: String(body.kind || 'other').slice(0, 24),
          date: (body.date && String(body.date).slice(0, 10)) || new Date().toISOString().slice(0, 10),
          recurring: !!body.recurring,
        });
        while (list.length > 300) list.shift();
      } else if (Number.isInteger(body.index) && body.index >= 0 && body.index < list.length) {
        list.splice(body.index, 1);
      }
      await store.set(key, JSON.stringify(list));
      return res.status(200).json({ ok: true, expenses: list });
    }

    if (action === 'notes') {
      if (!body.slug) return res.status(400).json({ ok: false, error: 'need slug' });
      await store.set(`notes:${body.slug}`, String(body.notes || '').slice(0, 8000));
      return res.status(200).json({ ok: true });
    }

    if (action === 'changelog-add') {
      if (!body.slug || !body.text) return res.status(400).json({ ok: false, error: 'need slug + text' });
      const log = await readLog(body.slug);
      log.push({ date: new Date().toISOString().slice(0, 10), text: String(body.text).slice(0, 300) });
      while (log.length > 60) log.shift();
      await store.set(`changelog:${body.slug}`, JSON.stringify(log));
      return res.status(200).json({ ok: true, changelog: log });
    }

    if (action === 'analyze-conversion') {
      const site = (await listSites()).find((s) => s.slug === body.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      const result = await analyzeConversion({ site, description: body.description });
      if (result.ok && body.save !== false && result.event_name) {
        const cfg = (await getSiteConfig(body.slug)) || {};
        const list = new Set([...(cfg.conversionEvents || []), result.event_name]);
        await saveSiteConfig(body.slug, { conversionEvents: [...list].join(', ') });
      }
      return res.status(200).json(result);
    }

    if (action === 'changelog-del') {
      const log = await readLog(body.slug);
      if (Number.isInteger(body.index) && body.index >= 0 && body.index < log.length) log.splice(body.index, 1);
      await store.set(`changelog:${body.slug}`, JSON.stringify(log));
      return res.status(200).json({ ok: true, changelog: log });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

export { readNotes, readLog };
