import { describe, expect, test } from 'bun:test';
import type { PRContext } from '@plannotator/shared/pr-types';
import { getPRDiscussionCount } from './prDiscussion';

function makeContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    body: '',
    state: 'OPEN',
    isDraft: false,
    labels: [],
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    comments: [],
    reviews: [],
    reviewThreads: [],
    checks: [],
    linkedIssues: [],
    ...overrides,
  };
}

describe('getPRDiscussionCount', () => {
  test('returns zero for an empty discussion so the comments region stays hidden', () => {
    expect(getPRDiscussionCount(makeContext())).toBe(0);
  });

  test('matches the comments timeline inclusion rules', () => {
    const context = makeContext({
      comments: [{ id: 'comment', author: 'a', body: 'hello', createdAt: '', url: '' }],
      reviews: [
        { id: 'silent', author: 'b', state: 'COMMENTED', body: '', submittedAt: '' },
        { id: 'approved', author: 'c', state: 'APPROVED', body: '', submittedAt: '' },
        { id: 'body', author: 'd', state: 'COMMENTED', body: 'note', submittedAt: '' },
      ],
      reviewThreads: [
        { id: 'empty', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, startLine: null, diffSide: 'RIGHT', comments: [] },
        {
          id: 'thread',
          isResolved: false,
          isOutdated: false,
          path: 'b.ts',
          line: 2,
          startLine: null,
          diffSide: 'RIGHT',
          comments: [{ id: 'thread-comment', author: 'e', body: 'thread', createdAt: '', url: '' }],
        },
      ],
    });

    expect(getPRDiscussionCount(context)).toBe(4);
  });
});
