/**
 * The marketing site's publish guard and its record of the live commit, for
 * the one publish job both deploy paths reach (.github/workflows/deploy.yml,
 * `deploy-marketing`: after Test passes, and the site lane of a site-only push).
 *
 *   bun run scripts/site-deploy.ts guard    # after the build, before the S3 sync
 *   bun run scripts/site-deploy.ts record   # after the sync, before the invalidation
 *
 * The record is an empty-ish object per publish in the site's own bucket,
 * `_site-deploy/<commit>` (and `_site-deploy/live.txt`, the same commit for a
 * person: https://plannotator.ai/_site-deploy/live.txt). The guard reads it by
 * listing the prefix, which the deploy role can already do (the sync lists the
 * bucket), so it needs no new permission. The sync excludes the prefix, so its
 * --delete never removes the record.
 *
 * The guard (an automatic run; a manual run publishes what it was asked to,
 * with a warning when that is older):
 *  - no record yet: publish;
 *  - the commit is in the history of a live one (GitHub's compare says
 *    "behind"): never publish, an older tree would replace a newer one;
 *  - the same commit is live, or nothing the site is built from (SITE_INPUTS)
 *    changed since the live one: do not publish it again;
 *  - otherwise (newer with a site change, a live commit off main's history, a
 *    record naming more than one commit after an interrupted publish): publish.
 * Anything it cannot read (the listing, GitHub's compare, git) fails the job,
 * so nothing is published on a doubt and the run shows red.
 *
 * It runs with the deploy's AWS credentials in the environment, so it imports
 * nothing but Node's own modules. scripts/site-lane.test.ts guards it.
 */
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BUCKET = 'plannotator-marketing';
export const LIVE_PREFIX = '_site-deploy/';
export const LIVE_FILE = `${LIVE_PREFIX}live.txt`;

/**
 * What the site is built from (an extended regular expression, also the one
 * deploy.yml's detect-changes greps with): its own folder, the shared packages
 * and skills it imports (scripts/site-lane.test.ts walks its imports), what
 * installs its dependencies, and how it is published.
 */
export const SITE_INPUTS = '^(apps/marketing/|apps/skills/|packages/|patches/|bun\\.lock$|package\\.json$|bunfig\\.toml$|\\.github/workflows/deploy\\.yml$)';
const SITE_INPUTS_RE = new RegExp(SITE_INPUTS);
export const siteInput = (path: string) => SITE_INPUTS_RE.test(path);

const SHA = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 9);

/** The commits the record names as live: the keys `_site-deploy/<40 hex>` of an `aws s3api list-objects-v2` answer. */
export function liveCommits(listing: unknown): string[] {
  const contents = (listing as { Contents?: unknown } | null)?.Contents;
  if (contents === undefined || contents === null) return [];
  if (!Array.isArray(contents)) throw new Error('the bucket listing is not the shape expected');
  const out: string[] = [];
  for (const o of contents) {
    const key = (o as { Key?: unknown } | null)?.Key;
    if (typeof key !== 'string' || !key.startsWith(LIVE_PREFIX)) continue;
    const sha = key.slice(LIVE_PREFIX.length);
    if (SHA.test(sha)) out.push(sha);
  }
  return out.sort();
}

export type GuardInput = {
  candidate: string;
  live: string[];
  /** A manual run (workflow_dispatch): it publishes what it was asked to. */
  manual: boolean;
  /** GitHub's compare of `<live>...<candidate>`: ahead, behind, identical or diverged. */
  order: (live: string) => Promise<string>;
  /** Whether a path the site is built from differs between the live commit and the candidate. */
  siteChanged: (live: string) => Promise<boolean>;
};

export type Verdict = { publish: boolean; why: string };

const ORDERS = new Set(['ahead', 'behind', 'identical', 'diverged']);

export async function guard({ candidate, live, manual, order, siteChanged }: GuardInput): Promise<Verdict> {
  if (!SHA.test(candidate)) throw new Error(`the commit to publish is not a commit id: ${JSON.stringify(candidate)}`);
  const c = short(candidate);
  if (manual) {
    const older: string[] = [];
    for (const l of live) if ((await order(l).catch(() => 'unknown')) === 'behind') older.push(short(l));
    return { publish: true, why: older.length ? `a manual run: publishing ${c} as asked, although it is older than the live ${older.join(', ')}` : `a manual run: publishing ${c}` };
  }
  if (!live.length) return { publish: true, why: `no live commit is recorded: publishing ${c}` };
  const orders = new Map<string, string>();
  for (const l of live) {
    const o = await order(l);
    if (!ORDERS.has(o)) throw new Error(`GitHub's compare of ${short(l)}...${c} answered ${JSON.stringify(o)}`);
    orders.set(l, o);
  }
  const newer = live.find((l) => orders.get(l) === 'behind');
  if (newer) return { publish: false, why: `not publishing ${c}: it is older than the live ${short(newer)} (in its history), and an older tree must never replace a newer one` };
  if (live.length > 1) return { publish: true, why: `the record names ${live.length} live commits (an interrupted publish) and none is newer than ${c}: publishing` };
  const l = live[0]!;
  const o = orders.get(l)!;
  if (o === 'identical') return { publish: false, why: `${c} is already live: nothing to publish` };
  if (o === 'diverged') return { publish: true, why: `the live ${short(l)} is not in ${c}'s history (a manual deploy of another ref): publishing ${c}` };
  if (await siteChanged(l)) return { publish: true, why: `${c} is newer than the live ${short(l)} and changes what the site is built from: publishing` };
  return { publish: false, why: `nothing the site is built from changed between the live ${short(l)} and ${c}: not publishing it again` };
}

/** The record's keys to delete once `candidate` is recorded: every other commit key. */
export const staleKeys = (live: string[], candidate: string) => live.filter((l) => l !== candidate).map((l) => `${LIVE_PREFIX}${l}`);

// ---------------------------------------------------------------------------
// In the deploy job

function run(cmd: string[], what: string): string {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${what} failed: ${r.stderr.toString().trim().split('\n').pop() ?? ''}`);
  return r.stdout.toString();
}

function listLive(): string[] {
  const out = run(['aws', 's3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', LIVE_PREFIX, '--output', 'json'], 'listing the live record').trim();
  return liveCommits(out ? JSON.parse(out) : {});
}

async function compareStatus(base: string, head: string, env = process.env): Promise<string> {
  const res = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/compare/${base}...${head}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub's compare of ${short(base)}...${short(head)} answered ${res.status}`);
  return String(((await res.json()) as { status?: unknown }).status);
}

function siteChangedSince(live: string, candidate: string): boolean {
  run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', live], `fetching ${short(live)}`);
  return run(['git', 'diff', '--name-only', live, candidate], 'the diff from the live commit').split('\n').some((p) => p && siteInput(p));
}

function output(lines: Record<string, string>) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(''));
}

function summary(text: string) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function ciGuard() {
  const candidate = (process.env.CANDIDATE ?? '').trim();
  const live = listLive();
  console.log(`Live now: ${live.length ? live.join(', ') : 'none recorded'}`);
  const v = await guard({
    candidate, live,
    manual: process.env.EVENT_NAME === 'workflow_dispatch',
    order: (l) => compareStatus(l, candidate),
    siteChanged: async (l) => siteChangedSince(l, candidate),
  });
  console.log(v.why);
  console.log(`::notice title=Marketing site: ${v.publish ? 'publishing' : 'not publishing'} ${short(candidate)}::${v.why}`);
  summary(`**Marketing site:** ${v.why}`);
  output({ publish: String(v.publish) });
}

function ciRecord() {
  const candidate = (process.env.CANDIDATE ?? '').trim();
  if (!SHA.test(candidate)) throw new Error(`the published commit is not a commit id: ${JSON.stringify(candidate)}`);
  const file = join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'site-deploy-')), 'live.txt');
  writeFileSync(file, `${candidate}\n`);
  // The new record first, then the old one: an interrupted record names two commits, never none.
  for (const key of [`${LIVE_PREFIX}${candidate}`, LIVE_FILE]) {
    run(['aws', 's3', 'cp', file, `s3://${BUCKET}/${key}`, '--content-type', 'text/plain; charset=utf-8', '--cache-control', 'no-cache'], `recording ${key}`);
  }
  for (const key of staleKeys(listLive(), candidate)) run(['aws', 's3', 'rm', `s3://${BUCKET}/${key}`], `removing ${key}`);
  console.log(`::notice title=Marketing site live::plannotator.ai serves ${candidate}`);
  summary(`**Marketing site live:** ${candidate} (https://plannotator.ai/${LIVE_FILE})`);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'guard') await ciGuard();
    else if (cmd === 'record') ciRecord();
    else {
      console.error('usage: bun run scripts/site-deploy.ts guard|record');
      process.exit(2);
    }
  } catch (e) {
    console.error(`::error title=Marketing site::${(e as Error).message.split('\n')[0]}`);
    process.exit(1);
  }
}
