// Refreshes src/data/oss-stars.json, the star counts the Spaces header shows
// (the total beside "Open source" and each repository's count in its
// drop-down). Run it by hand and commit the file:
//
//   bun apps/marketing/scripts/oss-stars.ts
//
// It reads public data from the GitHub REST API: unauthenticated, or with
// GITHUB_TOKEN when the environment has one (sent only to api.github.com,
// never printed or written). The site build never calls GitHub for this: it
// reads the committed file, so a build is the same on every machine and does
// not fail when GitHub is slow or rate-limited.
//
// The set: the repositories in REPOS, plus every public repository of each
// organisation in ORGS that is not a fork.
//
// It writes nothing, and exits non-zero, when an organisation lists no
// repositories or the total falls more than 20% below the committed one
// (snapshotRefusal); `--force` lets a real drop through.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOssStars, snapshotRefusal } from '../src/lib/oss-stars';

const REPOS = ['backnotprop/plannotator'];
const ORGS = ['plannotator'];

const API = 'https://api.github.com';
const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'plannotator-site-stars',
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

interface Repo {
  full_name: string;
  stargazers_count: number;
  fork: boolean;
  private: boolean;
}

async function get<T>(url: string): Promise<{ body: T; next: string | null }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url.replace(API, '')}`);
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  return { body: (await res.json()) as T, next };
}

const stars = new Map<string, number>();
const orgRepos: Record<string, number> = {};
const file = join(import.meta.dir, '../src/data/oss-stars.json');

for (const name of REPOS) {
  const { body } = await get<Repo>(`${API}/repos/${name}`);
  stars.set(body.full_name.toLowerCase(), body.stargazers_count);
}

for (const org of ORGS) {
  let url: string | null = `${API}/orgs/${org}/repos?type=public&per_page=100`;
  orgRepos[org] = 0;
  while (url) {
    const page: { body: Repo[]; next: string | null } = await get<Repo[]>(url);
    for (const repo of page.body) {
      if (repo.fork || repo.private) continue;
      stars.set(repo.full_name.toLowerCase(), repo.stargazers_count);
      orgRepos[org] += 1;
    }
    url = page.next;
  }
}

const ranked = [...stars].sort((a, b) => b[1] - a[1]);
const snapshot = {
  total: ranked.reduce((sum, [, n]) => sum + n, 0),
  repoCount: ranked.length,
  fetchedAt: new Date().toISOString().slice(0, 10),
  set: { repos: REPOS, orgs: ORGS, rule: 'listed repos plus every public non-fork repo of each org' },
  repos: ranked.map(([repo, n]) => ({ repo, stars: n })),
};

const previous = existsSync(file) ? readOssStars(readFileSync(file, 'utf8')) : null;
const refusal = snapshotRefusal({ total: snapshot.total, orgRepos }, previous, process.argv.includes('--force'));
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
const text = `${JSON.stringify(snapshot, null, 2)}\n`;
if (!readOssStars(text)) {
  console.error('The snapshot would not be readable by the page; nothing written.');
  process.exit(1);
}
writeFileSync(file, text);
console.log(`${snapshot.total} stars across ${snapshot.repoCount} repositories (${snapshot.fetchedAt}).`);
