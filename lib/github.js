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

// ---- read/write for the SEO agent -----------------------------------------

async function gh(path, opts = {}) {
  const r = await fetch(GH + path, { headers: headers(), ...opts, signal: AbortSignal.timeout(opts.timeout || 15000) });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(`github ${r.status} ${path}: ${(typeof body === 'object' && body?.message) || String(body).slice(0, 160)}`);
  return body;
}

export async function repoInfo(repo) {
  const r = await gh(`/repos/${repo}`);
  return { defaultBranch: r.default_branch || 'main', private: r.private, homepage: r.homepage || '' };
}

// flat list of every file path in the repo (default branch)
export async function listFiles(repo, branch) {
  const b = branch || (await repoInfo(repo)).defaultBranch;
  let ref;
  try {
    ref = await gh(`/repos/${repo}/git/ref/heads/${b}`);
  } catch (e) {
    if (/git repository is empty/i.test(e.message || '')) {
      const err = new Error(`"${repo}" has no code pushed to it yet — push the site's files to GitHub first, then run the agent again.`);
      err.repoEmpty = true;
      throw err;
    }
    throw e;
  }
  const tree = await gh(`/repos/${repo}/git/trees/${ref.object.sha}?recursive=1`);
  return {
    branch: b,
    baseSha: ref.object.sha,
    files: (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path),
    truncated: !!tree.truncated,
  };
}

export async function getFileContent(repo, path, branch) {
  try {
    const r = await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}${branch ? `?ref=${branch}` : ''}`);
    if (r && r.content) return Buffer.from(r.content, 'base64').toString('utf8');
    return null;
  } catch {
    return null;
  }
}

// Commit a set of {path, content} changes to a NEW branch and open a PR against
// the default branch. If autoMerge, merge it immediately. Returns {branch, prUrl, merged}.
export async function commitChangeset(repo, { files, message, branchPrefix = 'seo-agent', autoMerge = false, body = '' }) {
  if (!files || !files.length) throw new Error('no files to commit');
  const { defaultBranch } = await repoInfo(repo);
  const baseRef = await gh(`/repos/${repo}/git/ref/heads/${defaultBranch}`);
  const baseSha = baseRef.object.sha;
  const baseCommit = await gh(`/repos/${repo}/git/commits/${baseSha}`);

  // build blobs + a new tree
  const treeItems = [];
  for (const f of files) {
    const blob = await gh(`/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' }),
    });
    treeItems.push({ path: f.path.replace(/^\/+/, ''), mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(`/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeItems }),
  });
  const commit = await gh(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
  });
  const branch = `${branchPrefix}/${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  await gh(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });

  let prUrl = null;
  let merged = false;
  try {
    const pr = await gh(`/repos/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: message, head: branch, base: defaultBranch, body: body || 'Automated SEO improvement from the Inspiring Websites agent.' }),
    });
    prUrl = pr.html_url;
    if (autoMerge) {
      await gh(`/repos/${repo}/pulls/${pr.number}/merge`, {
        method: 'PUT',
        body: JSON.stringify({ merge_method: 'squash' }),
      });
      merged = true;
    }
  } catch (e) {
    // PR creation can fail on repos with no PR support; fall back to direct commit on default branch
    if (autoMerge) {
      await gh(`/repos/${repo}/git/refs/heads/${defaultBranch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      merged = true;
    } else {
      throw e;
    }
  }
  return { branch, prUrl, merged, commit: commit.sha };
}
