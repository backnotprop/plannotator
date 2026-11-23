import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatStars, ossMenu, readOssStars, snapshotRefusal } from './src/lib/oss-stars';

const here = import.meta.dir;

describe('the star counts in the Spaces header', () => {
  test('short form: one decimal with k or M, rounded, rolling over to M', () => {
    expect(formatStars(0)).toBe('0');
    expect(formatStars(999)).toBe('999');
    expect(formatStars(1000)).toBe('1.0k');
    expect(formatStars(14366)).toBe('14.4k');
    expect(formatStars(20436)).toBe('20.4k');
    expect(formatStars(20450)).toBe('20.5k');
    expect(formatStars(128449)).toBe('128.4k');
    expect(formatStars(999949)).toBe('999.9k');
    expect(formatStars(999950)).toBe('1.0M');
    expect(formatStars(1234567)).toBe('1.2M');
  });

  test('the trigger and every row say the exact number and the snapshot day', () => {
    const menu = ossMenu({
      total: 20436,
      repoCount: 27,
      fetchedAt: '2026-11-02',
      repos: { 'backnotprop/plannotator': 14366, 'plannotator/talkto': 65 },
    });
    expect(menu.count).toBe('20.4k');
    expect(menu.label).toBe('Open source, 20,436 stars across 27 repositories');
    expect(menu.summary).toBe('20,436 stars across 27 repositories, as of 2 Nov 2026');
    expect(menu.all).toBe('All 27 repositories on GitHub');
    expect(menu.lead).toMatchObject({ name: 'plannotator', count: '14,366', said: '14,366 GitHub stars as of 2 Nov 2026' });
    const talkto = menu.rows.find((row) => row.name === 'talkto');
    expect(talkto).toMatchObject({ href: 'https://github.com/plannotator/talkto', count: '65' });
    // A repository the snapshot does not list keeps its row, without a count.
    expect(menu.rows.find((row) => row.name === 'effective-html')).toMatchObject({ count: null, said: null });
  });

  test('a missing, garbled or incomplete snapshot gives the words without counts', () => {
    const bad = [
      undefined,
      '',
      '{"total": 20436,',
      'null',
      '[]',
      '{"total": "20436", "repoCount": 27, "fetchedAt": "2026-11-22"}',
      '{"total": -1, "repoCount": 27, "fetchedAt": "2026-11-22"}',
      '{"total": 20436.5, "repoCount": 27, "fetchedAt": "2026-11-22"}',
      '{"total": 20436, "repoCount": 0, "fetchedAt": "2026-11-22"}',
      '{"total": 20436, "repoCount": 27, "fetchedAt": "22 Nov 2026"}',
      '{"total": 20436, "repoCount": 27, "fetchedAt": "2026-02-30"}',
      '{"total": 20436, "repoCount": 27}',
    ];
    for (const raw of bad) {
      expect(readOssStars(raw)).toBeNull();
      const menu = ossMenu(readOssStars(raw));
      expect(menu.count).toBeNull();
      expect(menu.summary).toBeNull();
      expect(menu.label).toBe('Open source');
      for (const repo of [menu.lead, ...menu.rows]) expect(repo.count).toBeNull();
      expect(menu.all).not.toMatch(/\d/);
    }
  });

  test('an unreadable repository entry drops only its own count', () => {
    const stars = readOssStars(
      '{"total": 20436, "repoCount": 27, "fetchedAt": "2026-11-22", "repos": [{"repo": "Plannotator/TalkTo", "stars": 65}, {"repo": "plannotator/tot", "stars": -3}, null]}',
    );
    expect(stars?.repos).toEqual({ 'plannotator/talkto': 65 });
  });

  test('a refresh refuses an empty organisation or a sharp drop, unless forced', () => {
    const committed = { total: 20000, repoCount: 27, fetchedAt: '2026-11-22', repos: {} };
    expect(snapshotRefusal({ total: 20436, orgRepos: { plannotator: 26 } }, committed)).toBeNull();
    expect(snapshotRefusal({ total: 16000, orgRepos: { plannotator: 26 } }, committed)).toBeNull();
    expect(snapshotRefusal({ total: 15999, orgRepos: { plannotator: 26 } }, committed)).toContain('--force');
    expect(snapshotRefusal({ total: 15999, orgRepos: { plannotator: 26 } }, committed, true)).toBeNull();
    expect(snapshotRefusal({ total: 100, orgRepos: { plannotator: 26 } }, null)).toBeNull();
    expect(snapshotRefusal({ total: 14366, orgRepos: { plannotator: 0 } }, committed)).toContain('plannotator');
    expect(snapshotRefusal({ total: 14366, orgRepos: { plannotator: 0 } }, null, true)).not.toBeNull();
  });

  test('the committed snapshot is one the page can read, with a count for every repository the header shows', () => {
    const raw = readFileSync(join(here, 'src/data/oss-stars.json'), 'utf8');
    const stars = readOssStars(raw);
    expect(stars).not.toBeNull();
    const menu = ossMenu(stars);
    for (const repo of [menu.lead, ...menu.rows]) expect(repo.count, repo.name).not.toBeNull();
    // One source: the total is the sum of the counts it lists.
    expect(Object.values(stars!.repos).reduce((sum, n) => sum + n, 0)).toBe(stars!.total);
    expect(Object.keys(stars!.repos)).toHaveLength(stars!.repoCount);
  });

  test("the page never asks GitHub from the visitor's browser", () => {
    const files = [
      'src/pages/workspaces/index.astro',
      'src/pages/workspaces/pricing.astro',
      'src/components/spaces/SpacesTopStrip.astro',
      'src/components/spaces/SpacesOssList.astro',
      'src/scripts/spaces/header.js',
      'src/scripts/spaces/page.js',
      'src/scripts/spaces/pricing.js',
      'src/scripts/spaces/theme-switch.js',
      'src/scripts/spaces/signup-dialog.js',
    ];
    for (const file of files) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(text).not.toContain('api.github.com');
      expect(text).not.toContain('GitHubStars');
    }
  });
});
