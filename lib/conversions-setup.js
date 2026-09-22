// One-time, automatic conversion-tracking setup for a newly added site.
//
// Until now, "what counts as a conversion" only ever got fixed by a human:
// the tracker auto-detects a narrow, hardcoded set of patterns (tel:/sms:/
// mailto:/WhatsApp/booking-tool/review links, and form submits), and the
// "analyze conversion" helper in the dashboard only ever hands back an
// INSTRUCTION for a developer to manually add data-track="..." to some
// element — nothing ever actually commits that. So any site whose real
// conversion action is a plain button ("Join the community", "RSVP",
// "Donate", "Sign up") that doesn't happen to be a <form> submit just never
// gets counted, silently, until someone notices and manually intervenes.
//
// This scans the homepage for interactive elements the tracker's built-in
// patterns don't already cover, asks a cheap model which ones represent a
// real conversion (not plain navigation), and commits data-track attributes
// onto exactly those elements — a surgical string insertion into the
// existing HTML, never an LLM rewrite of the file, so there is no way for
// this to alter anything else in the page.
import { listFiles, getFileContent, commitChangeset } from './github.js';

// Mirrors the tracker's own built-in detection (lib/tracker.js) — anything
// that already auto-counts shouldn't be tagged again.
function alreadyAutoDetected(href) {
  if (!href) return false;
  return (
    /^tel:/i.test(href) ||
    /^sms:/i.test(href) ||
    /^mailto:/i.test(href) ||
    /wa\.me|api\.whatsapp|whatsapp\.com/i.test(href) ||
    /calendly\.com|acuityscheduling|cal\.com|squareup\.com\/appointments/i.test(href) ||
    /writereview|g\.page\/.+\/review|search\.google\.com\/local\/writereview/i.test(href) ||
    /maps\.google|google\.[a-z.]+\/maps|goo\.gl\/maps/i.test(href)
  );
}

export function extractCandidates(html) {
  const out = [];
  const re = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [full, tag, attrs, inner] = m;
    if (/data-track\s*=/i.test(attrs)) continue; // already tracked
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
    const href = hrefMatch ? hrefMatch[1] : '';
    if (alreadyAutoDetected(href)) continue;
    if (/^#/.test(href) === false && href && /^(https?:)?\/\//i.test(href) === false && /^\//.test(href) === false && !/^javascript:/i.test(href)) {
      // relative in-page anchors like "#pricing" are fine to consider; leave everything else through
    }
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text || text.length < 2) continue; // icon-only / empty — nothing for the model to reason about
    out.push({ tag: tag.toLowerCase(), text, href, openTagEnd: m.index + 1 + tag.length, fullLength: full.length });
  }
  return out;
}

async function classifyCandidates(site, candidates, key) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const list = candidates.map((c, i) => `${i}. <${c.tag}> "${c.text}"${c.href ? ` href="${c.href}"` : ''}`).join('\n');
  const r = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system:
      'You set up conversion tracking for a small business or organization website. Given a numbered list of buttons/links, pick ONLY the ones where a visitor clicking it is a real, countable outcome for the business — booking, signing up, joining, donating, applying, subscribing, requesting something, RSVPing, contacting them. NOT plain navigation (menu items, "learn more", social icons, in-page anchors, logo/home links). Return ONLY JSON.',
    messages: [
      {
        role: 'user',
        content: `Business: ${site.name} — ${site.url}\n\nElements:\n${list}\n\nJSON: {"conversions":[{"index":number,"event_name":"short-kebab-slug describing the action, e.g. join-community, rsvp, donate"}]}`,
      },
    ],
  });
  const usd = +(((r.usage?.input_tokens || 0) / 1e6) * 1 + ((r.usage?.output_tokens || 0) / 1e6) * 5).toFixed(5);
  const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let selections = [];
  try {
    let s = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    selections = JSON.parse(s).conversions || [];
  } catch {
    selections = [];
  }
  return { selections, usd };
}

export function patchHtml(html, candidates, selections) {
  const seen = new Set();
  const ordered = selections
    .map((s) => ({ ...s, cand: candidates[s.index] }))
    .filter((s) => s.cand && !seen.has(s.index) && seen.add(s.index))
    .sort((a, b) => b.cand.openTagEnd - a.cand.openTagEnd); // rightmost first so earlier offsets stay valid
  let out = html;
  const applied = [];
  for (const s of ordered) {
    const name = String(s.event_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `cta-${s.index}`;
    const pos = s.cand.openTagEnd;
    out = out.slice(0, pos) + ` data-track="${name}"` + out.slice(pos);
    applied.push({ name, text: s.cand.text });
  }
  return { html: out, applied };
}

// Shared by the automatic first-run pass and the manual "Figure it out"
// fallback below, so both work off the same repo-sourced homepage content
// and the same candidate list.
export async function fetchHomepageCandidates(site) {
  if (!site.repo) return { ok: false, error: 'no GitHub repo linked yet' };
  let tree;
  try {
    tree = await listFiles(site.repo);
  } catch (e) {
    return { ok: false, error: 'could not read repo: ' + (e.message || e) };
  }
  const htmlFiles = tree.files.filter((p) => /\.(html?|njk|liquid)$/i.test(p));
  const home = htmlFiles.find((p) => /(^|\/)index\.html?$/i.test(p)) || htmlFiles[0];
  if (!home) return { ok: true, home: null };
  const html = await getFileContent(site.repo, home, tree.branch);
  if (!html) return { ok: true, home: null };
  return { ok: true, home, html, branch: tree.branch, candidates: extractCandidates(html).slice(0, 40) };
}

export async function autoTagConversions(site, { spend } = {}) {
  const key = process.env.ANTHROPIC_API_KEY_AGENT || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'no Anthropic key set' };
  const fetched = await fetchHomepageCandidates(site);
  if (!fetched.ok) return fetched;
  const { home, html, candidates } = fetched;
  if (!home) return { ok: true, tagged: 0, note: 'no HTML file found to scan' };
  if (!candidates.length) return { ok: true, tagged: 0, note: 'nothing untracked found on the homepage' };

  let selections = [];
  try {
    const r = await classifyCandidates(site, candidates, key);
    selections = r.selections;
    if (spend) await spend(r.usd);
  } catch (e) {
    return { ok: false, error: 'classification failed: ' + (e.message || e) };
  }
  if (!selections.length) return { ok: true, tagged: 0, note: 'nothing on the homepage looked like a real conversion' };

  const { html: patched, applied } = patchHtml(html, candidates, selections);
  if (!applied.length || patched === html) return { ok: true, tagged: 0 };

  try {
    const res = await commitChangeset(site.repo, {
      files: [{ path: home, content: patched }],
      message: 'Auto-tag conversion tracking on primary CTAs',
      branchPrefix: 'conv-setup',
      autoMerge: !!site.agentAutoMerge,
      body:
        `Added conversion tracking to ${applied.length} element${applied.length === 1 ? '' : 's'} the tracker wasn't already counting:\n\n` +
        applied.map((a) => `- \`data-track="${a.name}"\` on "${a.text}"`).join('\n') +
        `\n\n_Automated conversion-tracking setup — one-time, on first run for this site._`,
    });
    return { ok: true, tagged: applied.length, applied, pr: res };
  } catch (e) {
    return { ok: false, error: 'commit failed: ' + (e.message || e) };
  }
}
