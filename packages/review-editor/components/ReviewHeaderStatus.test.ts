import { describe, expect, test } from 'bun:test';
import { pickReviewStatus, type ReviewStatusInput } from './ReviewHeaderStatus';

const none: ReviewStatusInput = { platformActionError: null, workspaceDiffError: null, partialDiff: false, staleDiff: false, baseBehind: false };

describe('the header has one status slot', () => {
  test('shows nothing when all is well', () => {
    expect(pickReviewStatus(none)).toBeNull();
  });

  test('shows the most important notice when several apply', () => {
    const all = { platformActionError: 'post failed', workspaceDiffError: 'x', partialDiff: true, staleDiff: true, baseBehind: true };
    expect(pickReviewStatus(all)).toBe('platform-error');
    expect(pickReviewStatus({ ...all, platformActionError: null })).toBe('workspace-error');
    expect(pickReviewStatus({ ...all, platformActionError: null, workspaceDiffError: null })).toBe('partial-diff');
    expect(pickReviewStatus({ ...none, staleDiff: true, baseBehind: true })).toBe('stale-diff');
    expect(pickReviewStatus({ ...none, baseBehind: true })).toBe('base-behind');
  });
});
