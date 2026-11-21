/**
 * Guard for the browser-test quarantine (tests/e2e/quarantine.json, read by
 * tests/e2e/quarantine.ts for playwright.config.ts).
 *
 * What it catches: an entry with no reason or no failing runs behind it (the
 * list growing silently), an entry whose test was renamed or removed (it would
 * leave out nothing, or the wrong test, while looking quarantined), and a
 * filter that stops leaving the tests out in CI, leaves out a neighbour, or
 * leaves something out locally.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { quarantineEntries, quarantineFilter, quarantinedTests, type QuarantineEntry } from '../tests/e2e/quarantine';

const e2eDir = resolve(import.meta.dir, '../tests/e2e');
const entries = quarantineEntries();

/** The titles given to `test(...)` in a spec, with their string escapes undone. */
function testTitles(spec: string): string[] {
  const source = readFileSync(join(e2eDir, spec), 'utf8');
  const titles: string[] = [];
  for (const m of source.matchAll(/\btest(?:\.only)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) titles.push(m[2].replace(/\\(.)/g, '$1'));
  return titles;
}

/** Playwright's grep title for a test: project, file, describe titles, title. */
const grepTitle = (spec: string, title: string, describe = '') => ['', 'chromium', spec, describe, title].filter((part, i) => i === 0 || part).join(' ');

describe('the e2e quarantine', () => {
  test('each entry names a test that exists, says why, and has at least two failing runs', () => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const label = `${entry.spec} › ${entry.title}`;
      expect(existsSync(join(e2eDir, entry.spec)), label).toBe(true);
      const titles = testTitles(entry.spec);
      expect(titles.filter((t) => t === entry.title), label).toHaveLength(1);
      if (entry.describe) expect(readFileSync(join(e2eDir, entry.spec), 'utf8'), `${label}: describe`).toContain(entry.describe);
      expect(entry.why.trim().length, label).toBeGreaterThanOrEqual(30);
      expect(entry.firstSeen, label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.firstSeen)), label).toBe(false);
      const runs = new Set(entry.evidence);
      expect(runs.size, label).toBeGreaterThanOrEqual(2);
      for (const id of runs) expect(Number.isInteger(id) && id > 1_000_000_000, `${label}: run ${id}`).toBe(true);
      for (const dep of entry.dependents ?? []) {
        expect(titles.filter((t) => t === dep.title), `${label} → ${dep.title}`).toHaveLength(1);
        expect(dep.why.trim().length, `${label} → ${dep.title}`).toBeGreaterThanOrEqual(30);
      }
      for (const t of quarantinedTests([entry])) {
        expect(seen.has(`${t.spec}\0${t.title}`), `listed twice: ${t.spec} › ${t.title}`).toBe(false);
        seen.add(`${t.spec}\0${t.title}`);
      }
    }
  });

  const sample: QuarantineEntry = {
    spec: 'inbox-x.spec.ts',
    title: "a (flaky) test: it's [1/2]",
    why: 'a sample entry for the filter checks below',
    firstSeen: '2026-11-06',
    evidence: [1, 2],
    dependents: [{ title: 'the test after it', why: 'reads the state the sample leaves' }],
  };

  test('in CI the filter leaves out each quarantined test and its dependents, under any describe, and nothing else', () => {
    const { grepInvert } = quarantineFilter({ CI: 'true' }, [sample]);
    const out = (title: string) => grepInvert!.some((re) => re.test(title));
    expect(out(grepTitle('inbox-x.spec.ts', sample.title))).toBe(true);
    expect(out(grepTitle('inbox-x.spec.ts', sample.title, 'iPhone 15 (WebKit)'))).toBe(true);
    expect(out(grepTitle('inbox-x.spec.ts', 'the test after it'))).toBe(true);
    expect(out(grepTitle('inbox-x.spec.ts', `${sample.title} and more`))).toBe(false);
    expect(out(grepTitle('inbox-y.spec.ts', sample.title))).toBe(false);
    expect(out(grepTitle('other-inbox-x.spec.ts', sample.title))).toBe(false);
  });

  test('an entry with a describe title leaves out the test under it only', () => {
    const { grepInvert } = quarantineFilter({ CI: 'true' }, [{ ...sample, describe: 'iPhone 15 (WebKit)' }]);
    const out = (title: string) => grepInvert!.some((re) => re.test(title));
    expect(out(grepTitle('inbox-x.spec.ts', sample.title, 'iPhone 15 (WebKit)'))).toBe(true);
    expect(out(grepTitle('inbox-x.spec.ts', 'the test after it', 'iPhone 15 (WebKit)'))).toBe(true);
    expect(out(grepTitle('inbox-x.spec.ts', sample.title, 'Pixel 7 (Chromium)'))).toBe(false);
    expect(out(grepTitle('inbox-x.spec.ts', sample.title))).toBe(false);
  });

  test('outside CI nothing is left out', () => {
    expect(quarantineFilter({}, [sample])).toEqual({});
    expect(quarantineFilter({ CI: 'false' }, [sample])).toEqual({});
  });

  test('every real entry matches its own test in CI', () => {
    const { grepInvert = [] } = quarantineFilter({ CI: 'true' }, entries);
    for (const t of quarantinedTests(entries)) expect(grepInvert.some((re) => re.test(grepTitle(t.spec, t.title, t.describe))), `${t.spec} › ${t.title}`).toBe(true);
  });

  test('the Playwright config applies the filter', async () => {
    const before = process.env.CI;
    process.env.CI = 'true';
    try {
      const config = (await import('../tests/e2e/playwright.config.ts')).default as { grepInvert?: RegExp[] };
      expect(config.grepInvert?.length ?? 0).toBe(quarantinedTests(entries).length);
    } finally {
      if (before === undefined) delete process.env.CI;
      else process.env.CI = before;
    }
  });
});
