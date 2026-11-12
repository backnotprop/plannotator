/**
 * What a stack badge's card lists and which lines its file shows (approval "stack-show-me", addendum 2026-11-06).
 * What regresses if these fail:
 * - the code popup labelled "from #12" shows another PR's hunks of the same file, or nothing when the agent's lines
 *   miss every hunk;
 * - a file row's counts disagree with what the agent wrote, or with the lines the popup shows;
 * - "Also changed here by" names the PR the card is already about, or one that did not change the part.
 */
import { expect, test } from 'bun:test';
import type { ShapeStack } from '@plannotator/core/shape';
import { stackCard, stackFileCounts, stackFileName, stackFilePatch } from './stackModel';

const PATCH = [
  'diff --git a/src/kettle.ts b/src/kettle.ts',
  '--- a/src/kettle.ts',
  '+++ b/src/kettle.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '+const heat = 100;',
  ' const b = 2;',
  ' const c = 3;',
  '@@ -40,2 +41,3 @@',
  ' function whistle() {',
  '+  beep();',
  '-  return;',
  '+  return true;',
  'diff --git a/src/other.ts b/src/other.ts',
  '--- a/src/other.ts',
  '+++ b/src/other.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n');

test("a file's lines are the hunks the PR's lines touch, else the whole file", () => {
  const first = stackFilePatch(PATCH, 'src/kettle.ts', [[2, 2]])!;
  expect(first).toContain('+const heat = 100;');
  expect(first).not.toContain('beep');
  const second = stackFilePatch(PATCH, 'src/kettle.ts', [[42, 43]])!;
  expect(second).toContain('beep');
  expect(second).not.toContain('heat');
  expect(second.startsWith('diff --git a/src/kettle.ts')).toBe(true);
  const missed = stackFilePatch(PATCH, 'src/kettle.ts', [[400, 410]])!;
  expect(missed).toContain('heat');
  expect(missed).toContain('beep');
  expect(stackFilePatch(PATCH, 'src/kettle.ts')).toContain('beep');
  expect(stackFilePatch(PATCH, 'src/gone.ts')).toBeNull();
});

test("a file row counts what the agent wrote, else the lines it shows", () => {
  expect(stackFileCounts({ path: 'a', additions: 172 }, null)).toEqual({ additions: 172, deletions: 0 });
  expect(stackFileCounts({ path: 'src/kettle.ts' }, stackFilePatch(PATCH, 'src/kettle.ts', [[42, 43]]))).toEqual({ additions: 2, deletions: 1 });
  expect(stackFileCounts({ path: 'a' }, null)).toBeNull();
});

test('the card is about one PR in one part, and its "Also changed here by" names only the others that changed it', () => {
  const stack: ShapeStack = {
    pulls: [
      { n: 11, title: 'The water' },
      { n: 12, title: 'The boil' },
      { n: 13, title: 'The whistle' },
    ],
    changes: [
      { part: 'how-b', pr: 13, said: 'Adds the whistle.', files: [{ path: 'src/w.ts' }] },
      { part: 'how-b', pr: 11, said: 'Heats it.', files: [{ path: 'src/h.ts' }] },
      { part: 'how-a', pr: 12, said: 'Boils.', files: [{ path: 'src/b.ts' }] },
    ],
  };
  const card = stackCard(stack, 'how-b', 13)!;
  expect(card.change.said).toBe('Adds the whistle.');
  expect(card.others.map((p) => p.n)).toEqual([11]);
  expect(stackCard(stack, 'how-a', 13)).toBeNull();
  expect(stackFileName('packages/inbox/components/SnoozeIntro.tsx')).toEqual({ name: 'SnoozeIntro.tsx', dir: 'packages/inbox/components' });
});
