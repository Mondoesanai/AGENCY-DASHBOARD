// Rule-based findings. $0, deterministic, specific. The monthly job feeds
// these into Claude to phrase them nicely + prioritise, but they stand on
// their own if the AI step is skipped.

const ms = (v) => (typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : '—');

export function buildFindings(audit, stats) {
  const f = [];
  const push = (severity, area, title, detail) => f.push({ severity, area, title, detail });

  if (audit && audit.ok) {
    const s = audit.scores;
    const c = audit.checks;
    const v = audit.vitals;

    if (s.seo < 90)
      push('high', 'SEO', `SEO score is ${s.seo}/100`, 'Search engines see fixable issues on the homepage. The items below are the usual cause.');
    if (!c.metaDescription)
      push('high', 'SEO', 'Missing or weak meta description', 'Add a 140–160 character description to each page — this is the grey text under the title in Google results and it drives click-through.');
    if (!c.title)
      push('high', 'SEO', 'Page title needs work', 'The <title> tag is missing, too short, or duplicated across pages. Each page should have a unique, keyword-led title.');
    if (!c.structuredData)
      push('med', 'SEO', 'No structured data', 'Add LocalBusiness / Organization JSON-LD so Google can show hours, phone, ratings and address directly in results.');
    if (!c.crawlable)
      push('high', 'SEO', 'Pages blocked from indexing', 'A robots rule or noindex tag is stopping Google from listing pages. Verify robots.txt and meta robots.');
    if (!c.hreflang && false) push('low', 'SEO', 'hreflang', '');

    if (s.performance < 80)
      push('high', 'Speed', `Performance score is ${s.performance}/100`, 'Slow pages lose mobile visitors and rank lower. Focus on the largest image and any render-blocking scripts.');
    if (v.lcp && v.lcp > 2500)
      push(v.lcp > 4000 ? 'high' : 'med', 'Speed', `Largest content loads in ${ms(v.lcp)}`, 'Aim for under 2.5s. Usually the hero image — compress it, serve WebP, and set width/height.');
    if (v.cls && v.cls > 0.1)
      push('med', 'Speed', `Layout shifts while loading (CLS ${v.cls.toFixed(2)})`, 'Content jumps as the page loads. Reserve space for images, embeds and fonts.');
    if (v.tbt && v.tbt > 300)
      push('low', 'Speed', `Scripts block interaction for ${ms(v.tbt)}`, 'Defer non-critical JavaScript so the page responds to taps sooner.');
    if (!c.modernImages)
      push('med', 'Speed', 'Images not in a modern format', 'Convert JP/PNG to WebP or AVIF — typically 30–50% smaller with no visible quality loss.');
    if (!c.imageSizing)
      push('low', 'Speed', 'Oversized images served to phones', 'Ship smaller image files to small screens instead of scaling a desktop-size file down.');
    if (!c.textCompression)
      push('low', 'Speed', 'Text assets not compressed', 'Enable Gzip/Brotli on HTML, CSS and JS.');

    if (s.accessibility < 90)
      push('med', 'Accessibility', `Accessibility score is ${s.accessibility}/100`, 'Fixing these also helps SEO and older visitors.');
    if (!c.contrast)
      push('med', 'Accessibility', 'Low colour contrast on some text', 'Light-grey text on white fails readability guidelines — darken it.');
    if (!c.imageAlt)
      push('low', 'Accessibility', 'Images missing alt text', 'Describe each meaningful image — screen readers and Google Images both use it.');
    if (!c.tapTargets)
      push('low', 'Accessibility', 'Tap targets too small / close together', 'Make buttons and links at least 48px and space them out on mobile.');
    if (!c.linkText)
      push('low', 'SEO', 'Vague link text ("click here")', 'Use descriptive link text — it tells Google what the destination page is about.');
    if (!c.https)
      push('high', 'Trust', 'Not fully served over HTTPS', 'Force HTTPS on every URL and asset.');
  } else {
    push('med', 'Audit', 'Could not reach the site for a scan', audit?.error || 'The automated SEO/speed scan failed. Check the URL is public and returns 200.');
  }

  if (stats) {
    const d = stats.deltas;
    if (!stats.hasData)
      push('low', 'Tracking', 'No visitor data yet', 'Add the one-line tracker snippet to this site to unlock visitor counts, traffic sources and conversions.');
    if (stats.hasData && stats.conversions === 0)
      push('high', 'Conversions', 'No tracked conversions in 30 days', 'Visitors arrive but nothing (call, form, booking) is firing. Confirm the phone number and form are real links, and make the primary call-to-action more prominent above the fold.');
    if (stats.hasData && d.visitors <= -20)
      push('high', 'Traffic', `Visitors down ${Math.abs(d.visitors)}% vs last month`, 'Check Google Search Console for lost rankings, and whether any external links pointing here broke.');
    if (stats.hasData && d.visitors >= 25)
      push('good', 'Traffic', `Visitors up ${d.visitors}% vs last month`, 'Momentum is building — a fresh page or post now compounds well.');
    const total = stats.device.mobile + stats.device.desktop;
    if (total > 30 && stats.device.mobile / total > 0.7 && audit?.ok && audit.scores.performance < 85)
      push('high', 'Speed', 'Mostly mobile visitors on a slow-on-mobile page', `${Math.round((stats.device.mobile / total) * 100)}% of traffic is on phones — the mobile speed issues above matter more than usual here.`);
    const top = stats.topPages?.[0];
    if (top && stats.topPages.length === 1 && stats.pageviews > 40)
      push('med', 'Content', 'Traffic only lands on one page', `Almost everything hits ${top.member}. Add internal links to other pages and give people a reason to go deeper.`);
    const direct = stats.sources?.find((s) => s.member === 'direct');
    const totalRef = (stats.sources || []).reduce((t, s) => t + s.score, 0);
    if (totalRef > 40 && direct && direct.score / totalRef > 0.85)
      push('low', 'SEO', 'Nearly all traffic is "direct"', 'Little is coming from Google search yet. Publishing location + service pages and getting the Google Business Profile linked will grow organic traffic.');
  }

  const rank = { high: 0, med: 1, good: 2, low: 3 };
  return f.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// Warm, outcome-framed version for the client email / report page.
// No jargon, no scores, always phrased as "here's what we're doing for you".
export function clientSuggestions(audit, stats) {
  const out = [];
  const add = (title, why) => out.push({ title, why });

  if (audit && audit.ok) {
    const c = audit.checks || {};
    const v = audit.vitals || {};
    const s = audit.scores || {};

    if (!c.metaDescription || s.seo < 90)
      add('Sharpen how your site shows up on Google', 'Tighter page titles and descriptions so more people click through from search results.');
    if (!c.structuredData)
      add('Add business details Google can read directly', 'So your hours, phone and location can appear right in the search listing.');
    if ((v.lcp && v.lcp > 2500) || s.performance < 85)
      add('Make pages load faster on phones', 'Most visitors are on mobile — a quicker load means fewer people leave before they see your offer.');
    if (!c.modernImages || !c.imageSizing)
      add('Optimise the images', 'Same look, much smaller files, so the site feels snappy everywhere.');
    if (s.accessibility < 90 || !c.contrast)
      add('Improve readability', 'Clearer text and easier navigation for every visitor, including older customers.');
  }

  if (stats && stats.hasData) {
    if (stats.conversions === 0)
      add('Make it easier for visitors to take action', 'Bigger, clearer "call" and "get a quote" buttons so more of your traffic turns into enquiries.');
    const totalRef = (stats.sources || []).reduce((t, x) => t + x.score, 0);
    const direct = (stats.sources || []).find((x) => x.member === 'direct');
    if (totalRef > 30 && direct && direct.score / totalRef > 0.8)
      add('Grow your Google search traffic', 'Add service and location pages so new customers can find you without knowing your name yet.');
    if (stats.topPages && stats.topPages.length === 1 && stats.pageviews > 40)
      add('Guide visitors deeper into the site', 'Add links and next steps so people explore more than just the front page.');
  }

  if (!out.length)
    add('Keep the momentum going', 'The site is in good shape — next we focus on fresh content to keep bringing new visitors in.');

  return out.slice(0, 5);
}

export function overallGrade(audit, stats) {
  if (!audit || !audit.ok) return null;
  const s = audit.scores;
  let score = s.seo * 0.4 + s.performance * 0.3 + s.accessibility * 0.15 + s.bestPractices * 0.15;
  if (stats?.hasData && stats.conversions === 0) score -= 8;
  if (stats?.hasData && stats.deltas.visitors >= 25) score += 4;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const letter =
    score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'F';
  return { score, letter };
}
