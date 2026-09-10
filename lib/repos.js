// Admin-only. Lists the GitHub repos the token can see, and (with ?match=<url>)
// the best guess for a given site URL. Powers the "find / pick repo" control.
import { listRepos, findRepoForUrl, githubConfigured } from './github.js';

export async function reposHandler(req, res) {
  if (!githubConfigured())
    return res.status(200).json({ ok: false, error: 'GITHUB_TOKEN not set in Vercel yet', repos: [] });

  const matchUrl = req.query.match;
  const [{ ok, repos, error }, guess] = await Promise.all([
    listRepos(),
    matchUrl ? findRepoForUrl(matchUrl).catch(() => null) : Promise.resolve(null),
  ]);

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    ok,
    error: ok ? undefined : error,
    repos: (repos || []).map((r) => ({
      full_name: r.full_name,
      private: r.private,
      pushed_at: r.pushed_at,
      description: r.description,
    })),
    match: guess && guess.ok ? guess.match : null,
    candidates: guess && guess.ok ? guess.candidates : [],
  });
}
