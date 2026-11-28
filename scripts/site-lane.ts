/**
 * The site lane (.github/workflows/deploy.yml, job `site-lane`): a push to main
 * whose commits change only the marketing site publishes it after the site's
 * own checks, without waiting for the Test workflow.
 *
 *   bun run scripts/site-lane.ts range   # before the install: is the push site-only?
 *   bun run scripts/site-lane.ts tests   # after the install: the site's tests, or why not
 *
 * "Site-only" is decided over every commit since the last main commit whose
 * Test run passed (pushRange in scripts/ci-affected.ts, the base deploy.yml's
 * detect-changes and a push's Test plan use), never only the pushed commit: a
 * newer push replaces a waiting Test run and a failed run's commits are tested
 * by the next, so the range holds every commit Test has not passed yet. The
 * push is site-only when every path in that range is
 *  - under apps/marketing/ and light (PUSH_LIGHT, so not one of the site files
 *    the product fetches at runtime, PUSH_RUNTIME_SITE: those wait for Test), or
 *  - a docs path that is light and that the site is not built from (docs/,
 *    adr/, root Markdown...: they cannot change the published tree),
 * and at least one is a site file. Anything the site is built from outside its
 * folder (SITE_INPUTS in scripts/site-deploy.ts: the shared packages and
 * skills it imports, the lockfile, a manifest, patches) is not: such a range
 * deploys after Test as before. No base (no earlier passed run, an API error,
 * a base the pushed commit does not contain), the repo variable SITE_LANE=off
 * or CI_AFFECTED=off: not site-only either.
 *
 * The site's checks are then the plan a PR with the same change would get
 * (scripts/ci-affected.ts): when that plan would run everything (a manifest, a
 * tsconfig, deleted code, an import it cannot resolve...) or a heavy lane, the
 * push is not site-only after all. Otherwise the lane runs every test file
 * under apps/marketing/ (security-build.test.ts among them) and the tests the
 * change reaches, with the site's build; the tree-scanning tests and the core
 * guards are left to Test, which still runs on the push. scripts/site-lane.test.ts
 * guards this file.
 */
import { appendFileSync } from 'node:fs';
import {
  PUSH_RUNTIME_SITE, buildGraph, changesBetween, plan, pushLight, pushRange, repoRoot, testFiles, type Change, type Plan, type RepoApi,
} from './ci-affected';
import { domList } from './ci-test-lane';
import { siteInput } from './site-deploy';

export const SITE = 'apps/marketing/';

/**
 * Why this path keeps a range off the site lane, or null when the lane may take
 * it. `light` is PUSH_LIGHT's verdict; the site-file and SITE_INPUTS checks do not
 * rest on it, so widening PUSH_LIGHT (say, to the skills, which are Markdown) can
 * never let a file the site is built from onto the lane.
 */
export function offLane(path: string, light: (path: string) => boolean = pushLight): string | null {
  if (PUSH_RUNTIME_SITE.some((r) => r.test(path))) return 'a site file the product fetches at runtime (PUSH_RUNTIME_SITE)';
  if (path.startsWith(SITE)) return light(path) ? null : 'a site file that is not light';
  if (siteInput(path)) return 'outside apps/marketing, among what the site is built from (SITE_INPUTS)';
  if (!light(path)) return 'neither the site nor the docs';
  return null;
}

/** Whether the lane takes a range: every path on it, and at least one site file. */
export function laneRange(changes: Change[]): { eligible: true } | { eligible: false; why: string } {
  if (!changes.length) return { eligible: false, why: 'nothing changed since the last passed Test run' };
  for (const c of changes) {
    const why = offLane(c.path);
    if (why) return { eligible: false, why: `${c.path}: ${why}` };
  }
  if (!changes.some((c) => c.path.startsWith(SITE))) return { eligible: false, why: 'no site file changed' };
  return { eligible: true };
}

/** The test files the lane runs for a range's plan: every site test, and the tests the change reaches. */
export function laneTests(p: Plan, siteTests: string[], dom: Set<string> = new Set(domList())): { eligible: true; unit: string[]; dom: string[] } | { eligible: false; why: string } {
  if (p.mode === 'all') return { eligible: false, why: `a PR with this change would run everything (${p.reasons[0] ?? 'no reason given'})` };
  const heavy = p.unit.lanes.filter((l) => !l.startsWith('unit-'));
  if (heavy.length) return { eligible: false, why: `the change reaches a heavy lane (${heavy.join(', ')})` };
  const reached = new Set(p.tests.filter((t) => t.why === 'changed' || t.why === 'reached').map((t) => t.path));
  const unit = new Set([...p.unit.files.filter((f) => reached.has(f)), ...siteTests.filter((f) => !dom.has(f))]);
  const domFiles = new Set([...p.dom.files.filter((f) => reached.has(f)), ...siteTests.filter((f) => dom.has(f))]);
  return { eligible: true, unit: [...unit].sort(), dom: [...domFiles].sort() };
}

// ---------------------------------------------------------------------------
// In the lane job

const SHA = /^[0-9a-f]{40}$/;

function output(lines: Record<string, string>) {
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(''));
}

function verdict(eligible: boolean, why: string) {
  const text = eligible ? why : `not site-only, so the site deploys after Test passes: ${why}`;
  console.log(text);
  console.log(`::notice title=Site lane: ${eligible ? 'publishing after the site checks' : 'not this push'}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Site lane:** ${text}\n\n`);
}

/** A push's verdict: the range since the last passed Test run, and whether the lane takes it. */
export async function decideRange(env: NodeJS.ProcessEnv = process.env, api?: RepoApi, repo = repoRoot): Promise<
  { eligible: true; base: string; head: string; changes: Change[] } | { eligible: false; why: string; changes?: Change[] }
> {
  if ((env.SITE_LANE ?? '').trim().toLowerCase() === 'off') return { eligible: false, why: 'the repo variable SITE_LANE is off' };
  const range = await pushRange(env, api, repo);
  if ('why' in range) return { eligible: false, why: range.why };
  const changes = changesBetween(range.base, range.head, repo);
  const r = laneRange(changes);
  return r.eligible ? { eligible: true, ...range, changes } : { eligible: false, why: r.why, changes };
}

async function ciRange(env: NodeJS.ProcessEnv = process.env) {
  const r = await decideRange(env);
  if (r.changes) {
    console.log('Every path changed since the last main commit whose Test run passed:');
    for (const c of r.changes) console.log(`  ${c.status}\t${c.path}${offLane(c.path) ? `   <- ${offLane(c.path)}` : ''}`);
  }
  if (!r.eligible) {
    verdict(false, r.why);
    return output({ eligible: 'false' });
  }
  verdict(true, `every commit since ${r.base.slice(0, 9)}, the last one whose Test run passed, changes only the site (and docs it is not built from)`);
  output({ eligible: 'true', base: r.base, sha: r.head });
}

export function ciTests(env: NodeJS.ProcessEnv = process.env) {
  const base = (env.BASE ?? '').trim();
  if (!SHA.test(base)) throw new Error(`BASE is not a commit id: ${JSON.stringify(base)}`);
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.toString().trim();
  const g = buildGraph();
  const p = plan(g, { changes: changesBetween(base, head), docsOnly: false });
  const siteTests = testFiles(g).filter((f) => f.startsWith(SITE));
  const r = laneTests(p, siteTests);
  if (!r.eligible) {
    verdict(false, r.why);
    return output({ eligible: 'false' });
  }
  console.log(`The site's checks: ${r.unit.length} test files${r.dom.length ? ` and ${r.dom.length} DOM test files` : ''}:`);
  for (const f of [...r.unit, ...r.dom]) console.log(`  ${f}`);
  output({ eligible: 'true', unit_tests: JSON.stringify(r.unit), dom_tests: JSON.stringify(r.dom) });
}

/**
 * The command line. Never fails on a doubt: any error is the answer "not
 * site-only" (eligible=false), and the site deploys after Test. Returns the exit code.
 */
export async function cli(cmd: string | undefined, steps: { range?: () => Promise<void>; tests?: () => void } = {}): Promise<number> {
  const { range = () => ciRange(), tests = () => ciTests() } = steps;
  if (cmd === 'range') {
    try { await range(); } catch (e) {
      verdict(false, `the lane could not decide: ${(e as Error).message.split('\n')[0]}`);
      output({ eligible: 'false' });
    }
    return 0;
  }
  if (cmd === 'tests') {
    try { tests(); } catch (e) {
      verdict(false, `the lane could not plan the site's tests: ${(e as Error).message.split('\n')[0]}`);
      output({ eligible: 'false' });
    }
    return 0;
  }
  console.error('usage: bun run scripts/site-lane.ts range|tests');
  return 2;
}

if (import.meta.main) process.exit(await cli(process.argv[2]));
