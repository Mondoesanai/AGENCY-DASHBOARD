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

// Site-improvement work, benefit-framed for the client. These are things WE do
// to the website. Shown on the report page as "what we're working on".
export function improvementsForClient(audit, stats) {
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
      add('Make pages load faster on phones', 'A quicker load means fewer people leave before they see your offer.');
    if (!c.modernImages || !c.imageSizing)
      add('Optimise the images', 'Same look, much smaller files, so the site feels snappy everywhere.');
    if (s.accessibility < 90 || !c.contrast)
      add('Improve readability', 'Clearer text and easier navigation for every visitor, including older customers.');
  }
  if (stats && stats.hasData) {
    if (stats.conversions === 0)
      add('Make the "call" and "quote" buttons stand out more', 'So more of your visitors actually reach out.');
    if (stats.topPages && stats.topPages.length === 1 && stats.pageviews > 40)
      add('Guide visitors deeper into the site', 'Add links and next steps so people explore past the front page.');
  }
  if (!out.length) add('Keep the site fresh', 'New content each month keeps bringing visitors in.');
  return out.slice(0, 4);
}

// Loose industry guess from the business name / URL, for a couple of tailored tips.
function industryOf(site) {
  const s = ((site && (site.name || '')) + ' ' + (site && (site.url || ''))).toLowerCase();
  if (/detail|car wash|auto|mobile wash/.test(s)) return 'detailing';
  if (/salon|barber|hair|nails|spa|lash|brow|beauty/.test(s)) return 'salon';
  if (/tax|bookkeep|account|cpa|payroll/.test(s)) return 'tax';
  if (/law|attorney|legal|counsel/.test(s)) return 'law';
  if (/dental|dentist|orthodon/.test(s)) return 'dental';
  if (/realtor|real estate|homes|properties|realty/.test(s)) return 'realtor';
  if (/roof|plumb|hvac|electric|landscap|contractor|construction|remodel|paint|clean/.test(s)) return 'contractor';
  if (/restaurant|cafe|coffee|bakery|kitchen|grill|eatery|bar /.test(s)) return 'restaurant';
  if (/gym|fitness|training|pilates|yoga|crossfit/.test(s)) return 'fitness';
  if (/church|ministry|movement|nonprofit|foundation/.test(s)) return 'ministry';
  return 'general';
}

const INDUSTRY_TIP = {
  detailing: { title: 'Text a before/after photo to every customer after the job', why: 'Ask them to share it — free word-of-mouth with a picture attached.' },
  salon: { title: 'Ask for the review while they\'re still in the chair, happy', why: 'Hand them your phone with the review page open — that\'s when they\'ll actually do it.' },
  tax: { title: 'Email past clients a "book early" reminder with the site link', why: 'Off-season contact keeps you top of mind before the rush.' },
  law: { title: 'Ask satisfied clients for a Google or Avvo review', why: 'In legal, reviews and reputation do most of the selling.' },
  dental: { title: 'Have front desk mention the site + reviews at checkout', why: 'A scripted 10-second ask at the desk lifts reviews more than anything online.' },
  realtor: { title: 'Send the site to every past client twice a year', why: 'Referrals and repeat business are your pipeline — stay in their inbox.' },
  contractor: { title: 'Put a yard sign + the website on the truck', why: 'The neighbours seeing the work are your next three jobs.' },
  restaurant: { title: 'Add the website link to your Google and Yelp profiles + table cards', why: 'People check the menu on their phone before they walk in.' },
  fitness: { title: 'Get 5 members to post a photo tagging you this month', why: 'Social proof from real members fills classes.' },
  ministry: { title: 'Ask the team to share the site from their own accounts', why: 'Reach comes from people, not the page — a coordinated share goes far.' },
  general: { title: 'Ask your 5 best customers to share the link once', why: 'A personal share from someone they trust beats any ad.' },
};

// Things the BUSINESS OWNER can do — no website work. Rotates weekly so the
// dashboard + email never show the same list two weeks running. No API key.
export function clientActions(audit, stats, site) {
  const hasData = stats && stats.hasData;
  const sources = (stats && stats.sources) || [];
  const totalRef = sources.reduce((t, x) => t + x.score, 0);
  const direct = sources.find((x) => x.member === 'direct');
  const searchLight =
    !totalRef || !sources.find((x) => x.member === 'google') || (direct && direct.score / (totalRef || 1) > 0.7);
  const mob = stats && stats.device ? stats.device.mobile : 0;
  const desk = stats && stats.device ? stats.device.desktop : 0;

  // always-on essentials (2 of these show every week)
  const core = [
    { title: 'Ask 3 recent happy customers for a Google review this week', why: 'Reviews are the #1 thing you can do for local ranking and trust.' },
    { title: 'Put the website link in your email signature and text replies', why: 'Every message you already send becomes a way to find and share your site.' },
    { title: 'Post the link on Facebook / Instagram with a recent photo', why: 'One real post a month keeps new visitors coming in.' },
    { title: 'Add the website to business cards, invoices, quotes and signage', why: 'Cheap to do once, works forever.' },
    { title: 'Reply to new website enquiries within 5–10 minutes', why: 'Speed wins the job — the first to call back usually gets it.' },
    { title: 'Ask every new customer "how did you find us?"', why: 'Tells us what\'s working so we can do more of it.' },
    { title: 'Share the link in local community / neighbourhood Facebook groups', why: 'Where the rules allow — that\'s where nearby customers look.' },
    { title: 'Send the site to past customers with a short "what\'s new" note', why: 'Repeat and referral business is the cheapest business you\'ll get.' },
    { title: 'Add photos + hours + services to your Google Business Profile', why: 'A complete profile gets picked over an empty one every time.' },
    { title: 'Pin your best review or a recent result to the top of your socials', why: 'First thing a new visitor sees should be proof you\'re good.' },
  ];

  // data-driven picks — industry tip first so it usually surfaces
  const situational = [INDUSTRY_TIP[industryOf(site)] || INDUSTRY_TIP.general];
  if (hasData && stats.conversions === 0)
    situational.push({ title: 'Do a test call + form fill on your own site this week', why: 'Make sure enquiries actually reach you — then push people to it hard.' });
  if (searchLight)
    situational.push({ title: 'Link your website from your Google Business Profile', why: 'Free, two minutes, and it feeds you steady local search traffic.' });
  if (mob + desk > 20 && mob / (mob + desk) > 0.7)
    situational.push({ title: 'Open your site on your own phone and time it', why: 'Most of your visitors are on mobile — if it feels slow to you, tell us.' });
  if (hasData && stats.deltas && stats.deltas.visitors >= 15)
    situational.push({ title: 'Momentum is up — keep the monthly photo post going', why: 'Consistency is what compounds traffic.' });

  // rotate: week number offsets which core items surface
  const week = Math.floor(Date.now() / 604800000);
  const rotated = core.slice(week % core.length).concat(core.slice(0, week % core.length));
  const out = [rotated[0], rotated[1], rotated[2], ...situational.slice(0, 2)];
  // de-dup by title, cap 5
  const seen = new Set();
  return out.filter((x) => x && !seen.has(x.title) && seen.add(x.title)).slice(0, 5);
}

// Back-compat alias — existing imports of clientSuggestions keep working
// (points at the owner-action list now).
export const clientSuggestions = clientActions;

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
