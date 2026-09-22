// Create / update / delete a client site, plus builder notes and the
// "what we did this month" changelog. All writes require CRON_SECRET.
import { store } from '../lib/store.js';
import {
  saveSiteConfig, deleteSiteConfig, getSiteConfig, slugify, listSites,
  hostKey, slugForHost, rememberHost, matchExistingSite,
} from '../lib/registry.js';
import { fetchHomepageCandidates, patchHtml } from '../lib/conversions-setup.js';
import { commitChangeset } from '../lib/github.js';

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

// Turn a plain-English "what counts as a conversion" description into an
// actual data-track attribute committed to the site's repo — not just an
// instruction for a human to go implement later (which was the old
// behavior, and nobody ever actually went and did it). Falls back to a
// manual instruction only when there's no repo, no match found on the
// homepage (it's probably on a different page), or the commit itself fails.
async function analyzeConversion({ site, description }) {
  const desc = String(description || '').trim();
  if (!desc) return { ok: false, error: 'describe the action first' };
  const key = process.env.ANTHROPIC_API_KEY;

  const manualFallback = async (why) => {
    const name = normEvent(desc) || 'conversion';
    let explanation = `Saved "${name}" as a counted conversion.`;
    let instruction = `Add data-track="${name}" to the element the visitor clicks for "${desc}". Then this event will count.`;
    if (key && !why) {
      // still worth a quick AI read of the live page for a better instruction,
      // even when we can't commit it ourselves (no repo, or it's not on the homepage)
      try {
        const r = await fetch(site.url, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
        const html = (await r.text()).slice(0, 45000);
        const bits = (html.match(/<(a|button|form|input)[^>]*>[^<]{0,60}/gi) || []).slice(0, 120).join('\n');
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: key });
        const resp = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system:
            'You configure conversion tracking for a small analytics tool. Given the owner\'s plain-English description and a slice of the page HTML, find the matching element and return ONLY minified JSON: {"matched_element":string (short description, or ""),"instruction":string (exact, copy-pasteable instruction for a developer),"explanation":string (1-2 plain sentences for a non-technical owner)}.',
          messages: [{ role: 'user', content: `Business: ${site.name}\nURL: ${site.url}\nOwner wants to count as a conversion: "${desc}"\n\nInteractive elements:\n${bits || '(could not fetch the page)'}` }],
        });
        const txt = (resp.content || []).find((b) => b.type === 'text')?.text || '';
        const j = JSON.parse(txt.replace(/^```json\s*|\s*```$/g, '').trim());
        if (j.instruction) instruction = j.instruction;
        if (j.explanation) explanation = j.explanation;
      } catch {
        /* keep the plain fallback text above */
      }
    }
    return {
      ok: true,
      ai: !!key,
      event_name: name,
      needs_data_track: true,
      instruction,
      explanation: `${explanation}${why ? ' ' + why : ''}`,
    };
  };

  if (!key) return manualFallback();
  if (!site.repo) return manualFallback('This site has no GitHub repo linked yet, so it can\'t be added automatically — a developer needs to add it by hand.');

  try {
    const fetched = await fetchHomepageCandidates(site);
    if (!fetched.ok || !fetched.home || !fetched.candidates.length) {
      return manualFallback('Nothing matched on the homepage — it may be on a different page.');
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    const list = fetched.candidates.map((c, i) => `${i}. <${c.tag}> "${c.text}"${c.href ? ` href="${c.href}"` : ''}`).join('\n');
    const r = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:
        'You match a plain-English description of a website action to one specific element in a numbered list. Return ONLY JSON: {"index": number or null (null if nothing on this list matches), "event_name": "short-kebab-slug"}.',
      messages: [{ role: 'user', content: `Description: "${desc}"\n\nElements:\n${list}` }],
    });
    const txt = (r.content || []).find((b) => b.type === 'text')?.text || '';
    const j = JSON.parse(txt.replace(/^```json\s*|\s*```$/g, '').trim());
    if (j.index == null || !fetched.candidates[j.index]) {
      return manualFallback('Nothing on the homepage matched that description — it may be on a different page, or already auto-detected.');
    }
    const eventName = normEvent(j.event_name) || normEvent(desc) || 'conversion';
    const { html: patched, applied } = patchHtml(fetched.html, fetched.candidates, [{ index: j.index, event_name: eventName }]);
    if (!applied.length) return manualFallback();
    const res = await commitChangeset(site.repo, {
      files: [{ path: fetched.home, content: patched }],
      message: `Add conversion tracking: ${desc}`.slice(0, 100),
      branchPrefix: 'conv-setup',
      autoMerge: !!site.agentAutoMerge,
      body: `Added \`data-track="${applied[0].name}"\` on "${applied[0].text}" per the request: "${desc}"\n\n_Automated conversion-tracking setup._`,
    });
    return {
      ok: true,
      ai: true,
      committed: true,
      event_name: applied[0].name,
      matched_element: applied[0].text,
      instruction: 'Nothing to do — it was just added automatically.',
      explanation: `Found "${applied[0].text}" on the homepage and tagged it — it'll start counting the next time someone clicks it.${res?.prUrl ? ` (${res.prUrl})` : ''}`,
    };
  } catch (e) {
    return manualFallback('Something went wrong trying to add it automatically (' + (e.message || e) + ') — falling back to a manual instruction.');
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
          // still nothing? fall back to the loose match (custom domain vs.
          // .vercel.app of a site already being tracked) so "Add site" can
          // never create a second entry for one you're already on.
          else {
            const fuzzy = await matchExistingSite(body.url).catch(() => null);
            if (fuzzy) slug = fuzzy;
          }
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
      // these are already real slugs from the dashboard (STATE.sites[].slug) —
      // do NOT run them through slugify() again. slugify() is a URL->slug
      // normalizer (strips .com/.vercel.app etc.); re-applying it to an
      // already-computed slug mangles it into a DIFFERENT, nonexistent key
      // (e.g. "setapartmovement.com" -> "setapartmovement"), so the merge
      // silently operated on the wrong records instead of the real ones.
      const keep = String(body.keep || '').trim();
      const drop = String(body.drop || '').trim();
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
