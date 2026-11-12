import { describe, expect, test } from 'bun:test';
import { repoCommentProblems } from '../scripts/no-comments/guard.ts';

describe('no code comments', () => {
  test('every source file is comment-free, or on the shrinking baseline with no new comments', () => {
    const problems = repoCommentProblems();
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  }, 120_000);
});
