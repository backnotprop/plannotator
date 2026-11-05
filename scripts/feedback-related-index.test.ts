/**
 * The release-time refresh of the Feedback form's list, with a fake `gh`. What
 * regresses: a draft release's private notes shipping in the window, something
 * other than titles going into the file, an open PR drawn as a suggestion, and
 * a failed or empty read wiping the file in a release commit.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelatedData, draftNotes, readRelatedInput, releaseTitles, serializeRelatedData, writeRelatedIndex, type GhRunner } from './feedback-related-index';

const notes = (lines: string) => `Follow us\n\n| [v0.1.0](x) | old |\n\n## What's New in v9\n\nIntro.\n\n${lines}\n\n## Install / Update\n\nrun this\n`;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fakeRoot(version = '0.29.0'): string {
  const root = mkdtempSync(join(tmpdir(), 'feedback-related-'));
  roots.push(root);
  mkdirSync(join(root, 'packages/inbox'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'packages/inbox/feedbackRelated.data.json'), 'KEPT');
  return root;
}

const manyReleases = Array.from({ length: 60 }, (_, n) => JSON.stringify({ tag: `v0.28.${n}`, draft: false, prerelease: false, body: notes(`### Line ${n} here`) })).join('\n');
const fakeGh = (answers: { releases?: string; issues?: unknown[]; pulls?: unknown[] } = {}): GhRunner => (args) => {
  if (args[0] === 'api') return answers.releases ?? manyReleases;
  if (args[0] === 'issue') return JSON.stringify(answers.issues ?? [{ number: 7, title: 'An open issue' }]);
  if (args[0] === 'pr') return JSON.stringify(answers.pulls ?? []);
  throw new Error(`unexpected gh ${args[0]}`);
};

describe('release notes', () => {
  test('headings below What\'s New; not the people, the install block or the raw PR list', () => {
    const body = notes('### Plannotator Inbox\n\n#### Snooze a thread\n\nText that stays out.\n\n### Contributors\n\n@someone did it\n\n### Thanks\n\n@another\n\n### Smaller changes\n\n- **Rows in the list** are tidier now. And more words.\n- Fix a thing [#12](https://x)\n- Authored by @someone in #12\n- Write to ada@example.com for early access to this.');
    expect(releaseTitles(body)).toEqual(['Snooze a thread', 'Rows in the list are tidier now.', 'Fix a thing #12']);
    expect(releaseTitles('no such section')).toEqual([]);
  });

  test("notes after What's Changed never count", () => {
    expect(releaseTitles("## What's New in v1\n\n### A real feature\n\n## What's Changed\n\n### Not this one\n")).toEqual(['A real feature']);
  });

  test('a draft or prerelease is never read: the logged in owner can see notes nobody else can', () => {
    const data = buildRelatedData({
      releases: [
        { tag: 'v0.30.0', draft: true, body: notes('### Secret unannounced thing') },
        { tag: 'v0.30.0-rc.1', prerelease: true, body: notes('### Prerelease thing') },
        { tag: 'v0.29.0', draft: false, prerelease: false, body: notes('### Public thing') },
        { tag: 'v0.19.9', body: notes('### Too old') },
      ],
      issues: [],
      pulls: [],
    });
    expect(data.releases).toEqual([{ title: 'Public thing', version: 'v0.29.0' }]);
  });

  test('a repeated heading keeps the newest release that has it', () => {
    const data = buildRelatedData({
      releases: [
        { tag: 'v0.28.9', body: notes('### Same heading') },
        { tag: 'v0.28.10', body: notes('### Same heading') },
      ],
      issues: [],
      pulls: [],
    });
    expect(data.releases).toEqual([{ title: 'Same heading', version: 'v0.28.10' }]);
  });
});

describe('issues and PRs', () => {
  test('an open PR only lends its words to the open issue it cites, and is never an entry', () => {
    const data = buildRelatedData({
      releases: [],
      issues: [{ number: 2593, title: 'Inbox: the tab uses 1.6 GB' }],
      pulls: [
        { number: 2613, title: 'Inbox: memory soak over a large store (#2593)' },
        { number: 2340, title: "Remove Gemini CLI from Plannotator's surfaces" },
        { number: 2616, title: 'fix(inbox): lazy-chunk follow-ups to #1 (not open)' },
      ],
    });
    expect(data.issues).toEqual([{ title: 'Inbox: the tab uses 1.6 GB', number: 2593, prWords: 'Inbox: memory soak over a large store (#2593)' }]);
    expect(JSON.stringify(data)).not.toContain('Gemini');
  });

  test('a title with an email address stays out, and so do a PR\'s words', () => {
    const data = buildRelatedData({ releases: [], issues: [{ number: 9, title: 'Real request' }, { number: 8, title: 'Ask ada@example.com about it' }], pulls: [{ number: 10, title: 'Ask ada@example.com (#9)' }] });
    expect(data.issues).toEqual([{ title: 'Real request', number: 9 }]);
  });

  test('bots and trackers stay out', () => {
    const data = buildRelatedData({ releases: [], issues: [{ number: 245, title: 'Dependency Dashboard' }, { number: 9, title: 'Real request' }], pulls: [{ number: 10, title: 'chore(deps): bump things (#9)' }] });
    expect(data.issues).toEqual([{ title: 'Real request', number: 9 }]);
  });

  test('only number and title are asked of GitHub', () => {
    const calls: string[][] = [];
    readRelatedInput((args) => {
      calls.push(args);
      return fakeGh()(args);
    }, null);
    for (const call of calls.filter((args) => args[0] !== 'api')) expect(call[call.indexOf('--json') + 1]).toBe('number,title');
    for (const call of calls) expect(call.join(' ')).toMatch(/plannotator/);
    // Read-only: no call that could write.
    for (const call of calls) expect(call.join(' ')).not.toMatch(/\b(create|edit|comment|close|delete|-X|--method|-f|-F)\b/);
  });
});

describe('the new release', () => {
  test("its draft notes count, since GitHub has them only after the tag", () => {
    const root = fakeRoot('0.29.0');
    writeFileSync(join(root, 'RELEASE_NOTES_v0.29.0.md'), notes('### The newest feature'));
    const data = writeRelatedIndex(root, fakeGh());
    expect(data.releases[0]).toEqual({ title: 'The newest feature', version: 'v0.29.0' });
  });

  test('no draft file, no draft line; the published one wins over a stale file', () => {
    expect(draftNotes(fakeRoot())).toBeNull();
    const root = fakeRoot('0.28.5');
    writeFileSync(join(root, 'RELEASE_NOTES_v0.28.5.md'), notes('### Stale draft'));
    const input = readRelatedInput(fakeGh(), draftNotes(root));
    expect(JSON.stringify(input.releases)).not.toContain('Stale draft');
  });
});

describe('a bad read writes nothing', () => {
  const kept = (root: string) => readFileSync(join(root, 'packages/inbox/feedbackRelated.data.json'), 'utf8');

  test('gh fails', () => {
    const root = fakeRoot();
    expect(() =>
      writeRelatedIndex(root, () => {
        throw new Error('gh: not logged in');
      }),
    ).toThrow('not logged in');
    expect(kept(root)).toBe('KEPT');
  });

  test('gh answers with almost nothing', () => {
    const root = fakeRoot();
    expect(() => writeRelatedIndex(root, fakeGh({ releases: '' }))).toThrow('Nothing written');
    expect(() => writeRelatedIndex(root, fakeGh({ issues: [] }))).toThrow('Nothing written');
    expect(kept(root)).toBe('KEPT');
  });

  test('a good read writes a file that reads back the same', () => {
    const root = fakeRoot();
    const data = writeRelatedIndex(root, fakeGh());
    expect(JSON.parse(kept(root))).toEqual(data);
    expect(kept(root)).toBe(serializeRelatedData(data));
  });
});
