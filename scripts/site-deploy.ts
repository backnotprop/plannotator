/**
 * The marketing site's publish guard and its record of the live commit, for
 * the one publish job both deploy paths reach (.github/workflows/deploy.yml,
 * `deploy-marketing`: after Test passes, and the site lane of a site-only push).
 *
 *   bun run scripts/site-deploy.ts guard    # after the build: publish this commit or not
 *   bun run scripts/site-deploy.ts mark     # the guard said publish: add it to the record, before the sync
 *   bun run scripts/site-deploy.ts record   # after the sync: live.txt names it, older records go
 *
 * The record is a small object per published commit in the site's own bucket,
 * `_site-deploy/<commit>` (and `_site-deploy/live.txt`, the same commit for a
 * person: https://plannotator.ai/_site-deploy/live.txt). A commit is added
 * before its sync and the older ones are removed after it, so a publish cut
 * short leaves both named, never only the older one. The guard reads it by
 * listing the prefix, which the deploy role can already do (the sync lists the
 * bucket), so it needs no new permission. The sync excludes the prefix, so its
 * --delete never removes the record.
 *
 * The guard (an automatic run; a manual run publishes what it was asked to,
 * with a warning when that is older):
 *  - no record: publish, with a warning annotation (expected once, on the
 *    first publish with a record; any other time something removed it);
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

function run(cmd: string[], what: string, cwd?: string): string {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', cwd });
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

/**
 * Whether a path the site is built from differs between the live commit and the
 * candidate (checked out in `repo`). --no-renames: a rename prints both paths, so
 * a site page moved out of apps/marketing still counts as a site change.
 */
export function siteChangedSince(live: string, candidate: string, repo?: string, fetchLive = true): boolean {
  if (fetchLive) run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', live], `fetching ${short(live)}`, repo);
  return run(['git', 'diff', '--no-renames', '--name-only', live, candidate], 'the diff from the live commit', repo).split('\n').some((p) => p && siteInput(p));
}

/** A manual run (deploy.yml hands the guard `EVENT_NAME: ${{ github.event_name }}`). */
export const isManual = (env: NodeJS.ProcessEnv) => env.EVENT_NAME === 'workflow_dispatch';

export type GuardIo = { listLive: () => string[]; order: (live: string, candidate: string) => Promise<string>; siteChanged: (live: string, candidate: string) => boolean };

/** The guard step: its verdict, and the lines it prints (a warning annotation when no record is found). */
export async function runGuard(env: NodeJS.ProcessEnv, io: GuardIo): Promise<{ verdict: Verdict; lines: string[] }> {
  const candidate = (env.CANDIDATE ?? '').trim();
  const live = io.listLive();
  const lines = [`Live now: ${live.length ? live.join(', ') : 'none recorded'}`];
  // Needed once, for the first publish with a record. Any other time something
  // removed the record (a sync from a deploy.yml older than the record): this
  // run publishes without the never-older check, and records again.
  if (!live.length) lines.push(`::warning title=Marketing site: no live record::No ${LIVE_PREFIX}<commit> record in the bucket, so the never-older check cannot run for this publish. Expected only on the first publish after the record was added; otherwise something removed it (a sync from an older deploy.yml?).`);
  const verdict = await guard({
    candidate, live, manual: isManual(env),
    order: (l) => io.order(l, candidate),
    siteChanged: async (l) => io.siteChanged(l, candidate),
  });
  lines.push(verdict.why, `::notice title=Marketing site: ${verdict.publish ? 'publishing' : 'not publishing'} ${short(candidate)}::${verdict.why}`);
  return { verdict, lines };
}

function output(lines: Record<string, string>) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(''));
}

function summary(text: string) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function ciGuard() {
  const { verdict, lines } = await runGuard(process.env, { listLive, order: (l, c) => compareStatus(l, c), siteChanged: (l, c) => siteChangedSince(l, c) });
  for (const l of lines) console.log(l);
  summary(`**Marketing site:** ${verdict.why}`);
  output({ publish: String(verdict.publish) });
}

function candidateOf(env = process.env): string {
  const candidate = (env.CANDIDATE ?? '').trim();
  if (!SHA.test(candidate)) throw new Error(`the commit to publish is not a commit id: ${JSON.stringify(candidate)}`);
  return candidate;
}

function put(key: string, candidate: string) {
  const file = join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'site-deploy-')), 'live.txt');
  writeFileSync(file, `${candidate}\n`);
  run(['aws', 's3', 'cp', file, `s3://${BUCKET}/${key}`, '--content-type', 'text/plain; charset=utf-8', '--cache-control', 'no-cache'], `recording ${key}`);
}

/**
 * Before the sync: add this commit to the record. From here on the bucket may
 * hold its tree, so a publish cut short (a failed step, a cancelled run) leaves
 * a record naming both commits, and the guard refuses anything older than
 * either: at worst a missed publish, never an older tree.
 */
function ciMark() {
  const candidate = candidateOf();
  put(`${LIVE_PREFIX}${candidate}`, candidate);
}

/** After the sync and the content types: the commit is live; live.txt names it and the older records go. */
function ciRecord() {
  const candidate = candidateOf();
  put(LIVE_FILE, candidate);
  for (const key of staleKeys(listLive(), candidate)) run(['aws', 's3', 'rm', `s3://${BUCKET}/${key}`], `removing ${key}`);
  console.log(`::notice title=Marketing site live::plannotator.ai serves ${candidate}`);
  summary(`**Marketing site live:** ${candidate} (https://plannotator.ai/${LIVE_FILE})`);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'guard') await ciGuard();
    else if (cmd === 'mark') ciMark();
    else if (cmd === 'record') ciRecord();
    else {
      console.error('usage: bun run scripts/site-deploy.ts guard|mark|record');
      process.exit(2);
    }
  } catch (e) {
    console.error(`::error title=Marketing site::${(e as Error).message.split('\n')[0]}`);
    process.exit(1);
  }
}
