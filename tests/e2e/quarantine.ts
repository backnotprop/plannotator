/**
 * Flaky browser tests, turned off in CI and kept runnable locally.
 *
 * tests/e2e/quarantine.json lists each test that failed in CI and then passed
 * on the same commit, or failed on unrelated PRs. One such failure fails a
 * whole merge train, so in CI (`CI` set) playwright.config.ts leaves these
 * tests out (`grepInvert`), with the later tests of the same serial spec that
 * need the state the flaky test leaves (`dependents`). Locally nothing is left
 * out, and `bun run test:e2e:quarantine` runs the specs that hold them
 * (scripts/e2e-quarantine.ts). Fix the test, prove it there (e.g.
 * `--repeat-each 5`), then remove its entry.
 *
 * scripts/e2e-quarantine.test.ts requires a reason and at least two failing
 * runs for each entry, so the list cannot grow silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type QuarantineEntry = {
  /** The spec's file name in tests/e2e, e.g. `inbox-pull-requests.spec.ts`. */
  spec: string;
  /** The test's own title (the string given to `test(...)`), not its describe titles. */
  title: string;
  /** A describe title the test must sit under, when the same title runs under several (one per phone). */
  describe?: string;
  /** What fails, from the CI log: the assertion and what it waits for. */
  why: string;
  /** The date (YYYY-MM-DD) of the first failure in the evidence. */
  firstSeen: string;
  /** Inbox window e2e run ids (GitHub Actions) where this test failed with no infrastructure cause. */
  evidence: number[];
  /** Later tests of the same serial spec that need the state this test leaves; left out with it. */
  dependents?: { title: string; why: string }[];
};

export const QUARANTINE_FILE = join(__dirname, 'quarantine.json');

export function quarantineEntries(file = QUARANTINE_FILE): QuarantineEntry[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { tests: QuarantineEntry[] }).tests;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches one test against Playwright's grep title: project, spec file,
 * describe titles, test title and tags, joined by spaces.
 */
export function testPattern(spec: string, title: string, describe?: string): RegExp {
  const under = describe ? `${escape(describe)} (?:.* )?` : '';
  return new RegExp(`(?:^| )${escape(spec)} (?:.* )?${under}${escape(title)}(?: @\\S+)*$`);
}

/** Every test the quarantine leaves out in CI: each entry and its dependents. */
export function quarantinedTests(entries = quarantineEntries()): { spec: string; title: string; describe?: string }[] {
  return entries.flatMap((entry) => [
    { spec: entry.spec, title: entry.title, describe: entry.describe },
    ...(entry.dependents ?? []).map((d) => ({ spec: entry.spec, title: d.title, describe: entry.describe })),
  ]);
}

/** The config's filter: in CI, every test but the quarantined ones; elsewhere, every test. */
export function quarantineFilter(env: Record<string, string | undefined>, entries = quarantineEntries()): { grepInvert?: RegExp[] } {
  if (!env.CI || env.CI === 'false' || env.CI === '0') return {};
  const patterns = quarantinedTests(entries).map((t) => testPattern(t.spec, t.title, t.describe));
  return patterns.length ? { grepInvert: patterns } : {};
}
