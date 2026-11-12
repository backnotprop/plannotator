import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Gh, fixedIn, firstReleases, releaseTitles, writeSearchIndex } from './feedback-search-index';

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
      { tag: 'v8.0.0', body: `${notes('Harbor charts')}\nFixes [#5](https://github.com/backnotprop/plannotator/issues/5).` },
      { tag: 'v8.0.1', body: `${notes('Rope knots')}\nCloses #3 and the PR [#31](https://github.com/backnotprop/plannotator/pull/31).` },
      { tag: 'v8.1.0', draft: true, body: notes('Unannounced lantern') },
      { tag: 'v8.2.0', prerelease: true, body: notes('Trial lantern') },
    ].map((release) => JSON.stringify(release)).join('\n');
  }
  if (args[0] === 'issue' && args.includes('closed')) {
    return JSON.stringify([
      { number: 3, title: 'Knots slip', labels: [], stateReason: 'COMPLETED', closedByPullRequestsReferences: [{ number: 31, repository: { name: 'plannotator', owner: { login: 'backnotprop' } } }] },
      { number: 4, title: 'Never fixed', labels: [], stateReason: 'NOT_PLANNED', closedByPullRequestsReferences: [] },
      { number: 5, title: 'Charts upside down', labels: [], stateReason: 'COMPLETED', closedByPullRequestsReferences: [] },
      { number: 6, title: 'Fixed somewhere no notes say', labels: [], stateReason: 'COMPLETED', closedByPullRequestsReferences: [] },
    ]);
  }
  if (args[0] === 'issue') return JSON.stringify([{ number: 7, title: 'Lamp flickers', labels: [] }, { number: 8, title: 'Private leak', labels: [{ name: 'security' }] }, { number: 9, title: 'Write to me at someone@example.com', labels: [] }]);
  if (args.includes('open')) return JSON.stringify([{ number: 21, title: 'fix(lamp): dim at dusk' }]);
  return JSON.stringify([{ number: 20, title: 'feat: add a pelican' }, { number: 19, title: 'chore(deps): bump things' }, { number: 18, title: 'feat: mark unread' }]);
};

test('open issues, fixed issues with their release, open and merged PRs and published notes are all that goes in', () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'RELEASE_NOTES_v9.0.0.md'), notes('New buoy'));
  const { links } = writeSearchIndex(root, gh);
  expect(links).toEqual([
    { title: 'Lamp flickers', path: 'issues/7' },
    { title: 'Charts upside down', path: 'issues/5', fixed: '8.0.0' },
    { title: 'Knots slip', path: 'issues/3', fixed: '8.0.1' },
    { title: 'Dim at dusk', path: 'pull/21' },
    { title: 'Add a pelican', path: 'pull/20' },
    { title: 'New buoy', path: 'releases/tag/v9.0.0' },
    { title: 'Rope knots', path: 'releases/tag/v8.0.1' },
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

test("a release's TL;DR and Not yet on headings are not features", () => {
  const body = "## What's New in v9\n\n### TL;DR\n\n- **New:** A buoy\n\n### Harbor charts\n\nText.\n\n#### Not yet on\n\nHidden.\n\n## Install\n";
  expect(releaseTitles(body)).toEqual(['Harbor charts']);
});

test('a fixed issue takes the release that shipped its PR (the latest, when several did), else the first that links it', () => {
  const first = firstReleases([
    { tag: 'v1.10.0', body: 'PR #40 and [#12](https://github.com/backnotprop/plannotator/issues/12) again.' },
    { tag: 'v1.9.0', body: 'Closing #12 with #30. A color, &#35;, and someone/else#77 are not links.' },
    { tag: 'v2.0.0', body: '#41', draft: true },
  ]);
  expect([...first]).toEqual([
    [12, '1.9.0'],
    [30, '1.9.0'],
    [40, '1.10.0'],
  ]);
  const issue = { number: 12, title: 'Oars', stateReason: 'COMPLETED' };
  expect(fixedIn({ ...issue, closedByPullRequestsReferences: [{ number: 30 }, { number: 40 }] }, first)).toBe('1.10.0');
  expect(fixedIn(issue, first)).toBe('1.9.0');
  expect(fixedIn({ ...issue, number: 13, closedByPullRequestsReferences: [{ number: 40, repository: { name: 'plannotator', owner: { login: 'someone' } } }] }, first)).toBeNull();
  expect(fixedIn({ ...issue, number: 41 }, first)).toBeNull();
  expect(fixedIn({ ...issue, stateReason: 'NOT_PLANNED' }, first)).toBeNull();
});
