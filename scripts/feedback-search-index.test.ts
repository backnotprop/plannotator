import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Gh, writeSearchIndex } from './feedback-search-index';

const notes = (heading: string) => `## What's New in v9\n\n### ${heading}\n\nIntro.\n\n## Install\n\n### Windows steps\n`;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fakeRoot(version = '9.0.0'): string {
  const root = mkdtempSync(join(tmpdir(), 'feedback-search-'));
  roots.push(root);
  mkdirSync(join(root, 'packages/inbox'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'packages/inbox/feedbackSearch.data.json'), 'KEPT');
  return root;
}

const gh: Gh = (args) => {
  if (args[0] === 'api') {
    return [
      { tag: 'v8.0.0', body: notes('Harbor charts') },
      { tag: 'v8.1.0', draft: true, body: notes('Unannounced lantern') },
      { tag: 'v8.2.0', prerelease: true, body: notes('Trial lantern') },
    ].map((release) => JSON.stringify(release)).join('\n');
  }
  if (args[0] === 'issue') return JSON.stringify([{ number: 7, title: 'Lamp flickers', labels: [] }, { number: 8, title: 'Private leak', labels: [{ name: 'security' }] }, { number: 9, title: 'Write to me at someone@example.com', labels: [] }]);
  if (args.includes('open')) return JSON.stringify([{ number: 21, title: 'fix(lamp): dim at dusk' }]);
  return JSON.stringify([{ number: 20, title: 'feat: add a pelican' }, { number: 19, title: 'chore(deps): bump things' }, { number: 18, title: 'feat: mark unread' }]);
};

test('open issues, open and merged PRs and published notes are all that goes in', () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'RELEASE_NOTES_v9.0.0.md'), notes('New buoy'));
  const { links } = writeSearchIndex(root, gh);
  expect(links).toEqual([
    { title: 'Lamp flickers', path: 'issues/7' },
    { title: 'Dim at dusk', path: 'pull/21' },
    { title: 'Add a pelican', path: 'pull/20' },
    { title: 'New buoy', path: 'releases/tag/v9.0.0' },
    { title: 'Harbor charts', path: 'releases/tag/v8.0.0' },
  ]);
  expect(JSON.parse(readFileSync(join(root, 'packages/inbox/feedbackSearch.data.json'), 'utf8')).links).toEqual(links);
});

test('only reads GitHub', () => {
  const calls: string[][] = [];
  writeSearchIndex(fakeRoot(), (args) => (calls.push(args), gh(args)));
  for (const call of calls) expect(call[0] === 'api' ? !call.includes('-X') : call[1] === 'list').toBe(true);
});

test('a failed or empty read keeps the file', () => {
  const root = fakeRoot();
  const file = join(root, 'packages/inbox/feedbackSearch.data.json');
  expect(() => writeSearchIndex(root, () => { throw new Error('no network'); })).toThrow();
  expect(() => writeSearchIndex(root, (args) => (args[0] === 'api' ? '' : '[]'))).toThrow();
  expect(readFileSync(file, 'utf8')).toBe('KEPT');
});
