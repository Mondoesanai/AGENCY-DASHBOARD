// GitHub repo lookup for the SEO agent + revision pipeline.
// Needs GITHUB_TOKEN (fine-grained PAT, Contents: read/write, Metadata: read).

const GH = 'https://api.github.com';

export function githubConfigured() {
  return !!process.env.GITHUB_TOKEN;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'inspiring-websites-dashboard',
  };
}

// Live list of every repo the token can see, newest push first. No cache —
// a repo created seconds ago must show up immediately.
export async function listRepos({ limit = 300 } = {}) {
  if (!process.env.GITHUB_TOKEN) return { ok: false, error: 'GITHUB_TOKEN not set', repos: [] };
  const repos = [];
  try {
    for (let page = 1; page <= 4 && repos.length < limit; page++) {
      const r = await fetch(`${GH}/user/repos?per_page=100&sort=pushed&page=${page}&affiliation=owner,collaborator,organization_member`, {
        headers: headers(),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return { ok: false, error: `github ${r.status}: ${t.slice(0, 140)}`, repos };
      }
      const batch = await r.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const x of batch) {
        repos.push({
          full_name: x.full_name,
          name: x.name,
          private: !!x.private,
          pushed_at: x.pushed_at,
          description: x.description || '',
          default_branch: x.default_branch || 'main',
          homepage: x.homepage || '',
        });
      }
      if (batch.length < 100) break;
    }
  } catch (e) {
    return { ok: false, error: 'github: ' + (e.message || e), repos };
  }
  return { ok: true, repos };
}

const slugPart = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\.(vercel\.app|netlify\.app|com|net|org|co|io|dev|app|us|biz)$/g, '')
    .replace(/[^a-z0-9]+/g, '');

// Best-guess repo for a site URL. Matches on collapsed slug, then homepage, then
// loose contains. Returns { match, score, candidates }.
export async function findRepoForUrl(url) {
  const { ok, repos, error } = await listRepos();
  if (!ok) return { ok: false, error, match: null };
  const target = slugPart(url);
  if (!target) return { ok: true, match: null, candidates: [] };

  const scored = repos
    .map((r) => {
      const rn = slugPart(r.name);
      const hp = slugPart(r.homepage);
      let score = 0;
      if (rn === target) score = 100;
      else if (hp && hp === target) score = 95;
      else if (rn && (rn.includes(target) || target.includes(rn)) && Math.abs(rn.length - target.length) <= 6) score = 70;
      else if (hp && (hp.includes(target) || target.includes(hp))) score = 60;
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    ok: true,
    match: scored[0] && scored[0].score >= 70 ? scored[0].full_name : null,
    best: scored[0] || null,
    candidates: scored.slice(0, 5).map((r) => ({ full_name: r.full_name, score: r.score })),
  };
}
