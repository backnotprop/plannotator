import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatStars, ossStarsLink, readOssStars, snapshotRefusal } from './src/lib/oss-stars';

const here = import.meta.dir;

describe('the star count beside "Open source" on the Spaces page', () => {
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

  test('the link says the exact number and the snapshot day', () => {
    const link = ossStarsLink({ total: 20436, repoCount: 27, fetchedAt: '2026-11-02' });
    expect(link.count).toBe('20.4k');
    expect(link.label).toContain('20,436 stars');
    expect(link.label).toContain('2 Nov 2026');
    expect(link.label).toContain('new tab');
    expect(link.title).toContain('20,436');
  });

  test('a missing, garbled or incomplete snapshot gives the link without a count', () => {
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
      const link = ossStarsLink(readOssStars(raw));
      expect(link.count).toBeNull();
      expect(link.title).toBeNull();
      expect(link.label).toContain('new tab');
      expect(link.label).not.toMatch(/\d/);
    }
  });

  test('a refresh refuses an empty organisation or a sharp drop, unless forced', () => {
    const committed = { total: 20000, repoCount: 27, fetchedAt: '2026-11-22' };
    expect(snapshotRefusal({ total: 20436, orgRepos: { plannotator: 26 } }, committed)).toBeNull();
    expect(snapshotRefusal({ total: 16000, orgRepos: { plannotator: 26 } }, committed)).toBeNull();
    expect(snapshotRefusal({ total: 15999, orgRepos: { plannotator: 26 } }, committed)).toContain('--force');
    expect(snapshotRefusal({ total: 15999, orgRepos: { plannotator: 26 } }, committed, true)).toBeNull();
    expect(snapshotRefusal({ total: 100, orgRepos: { plannotator: 26 } }, null)).toBeNull();
    expect(snapshotRefusal({ total: 14366, orgRepos: { plannotator: 0 } }, committed)).toContain('plannotator');
    expect(snapshotRefusal({ total: 14366, orgRepos: { plannotator: 0 } }, null, true)).not.toBeNull();
  });

  test('the committed snapshot is one the page can read', () => {
    const raw = readFileSync(join(here, 'src/data/oss-stars.json'), 'utf8');
    expect(readOssStars(raw)).not.toBeNull();
  });

  test("the page never asks GitHub from the visitor's browser", () => {
    const files = ['src/pages/workspaces/index.astro', 'src/scripts/spaces/page.js', 'src/scripts/spaces/signup-dialog.js'];
    for (const file of files) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(text).not.toContain('api.github.com');
      expect(text).not.toContain('GitHubStars');
    }
  });
});
