/**
 * "Open in Reviews" on a ref card in the Inbox (refCardReviews.ts). What regresses: the link offered for a PR Reviews
 * cannot open (not in its list, merged, an issue, a GitLab issue with the same number), offered while Code review is
 * off, or missing for a PR it lists; or following it opening another stack than the PR's.
 */
import { describe, expect, test } from 'bun:test';
import type { ForgeRef, ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { OPEN_IN_REVIEWS, refCardReviewsAction, reviewsStackOf } from './refCardReviews';

function listed(key: string, number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const gitlab = key.endsWith(':pull');
  return {
    key,
    platform: gitlab ? 'gitlab' : 'github',
    host: gitlab ? 'gitlab.com' : 'github.com',
    repo: 'acme/widgets',
    number,
    url: '',
    title: `PR ${number}`,
    author: 'ada',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: 'acme/widgets',
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: null,
    updated_at: '2026-11-08T10:00:00.000Z',
    merged_at: null,
    ...fields,
  } as InboxPull;
}

const MODEL: Pick<InboxPullsAnswer, 'pulls'> = {
  pulls: [
    listed('github.com/acme/widgets#12', 12),
    // A stack: #13 on #12's branch.
    listed('github.com/acme/widgets#13', 13, { base: 'b12' }),
    listed('github.com/acme/widgets#9', 9, { state: 'merged', merged_at: '2026-11-07T10:00:00.000Z' }),
    listed('gitlab.com/acme/widgets#7:pull', 7),
  ],
};

const gh = (number: number, kind: ForgeRef['kind'] = 'issue'): ForgeRef => ({ platform: 'github', host: 'github.com', owner: 'acme', repo: 'widgets', number, kind });
const gl = (number: number, kind: ForgeRef['kind']): ForgeRef => ({ platform: 'gitlab', host: 'gitlab.com', owner: 'acme', repo: 'widgets', number, kind });
const issueAnswer = { ok: true, fetchedAt: 0, data: { kind: 'issue' } } as unknown as ForgeRefCardResult;

describe('Open in Reviews on a ref card', () => {
  test('a PR the list holds open opens its stack; a bare #12 (an issues link) is the same PR on GitHub', () => {
    const stack12 = reviewsStackOf(MODEL, gh(12, 'pull'));
    expect(stack12).not.toBeNull();
    expect(reviewsStackOf(MODEL, gh(12))).toBe(stack12);
    // The upper layer opens the same stack page.
    expect(reviewsStackOf(MODEL, gh(13, 'pull'))).toBe(stack12);
    expect(reviewsStackOf(MODEL, gl(7, 'pull'))).not.toBeNull();
  });

  test('nothing for a PR the list does not hold open, a GitLab issue, another repository, or no list (Code review off)', () => {
    expect(reviewsStackOf(MODEL, gh(9, 'pull'))).toBeNull();
    expect(reviewsStackOf(MODEL, gh(404, 'pull'))).toBeNull();
    expect(reviewsStackOf(MODEL, gl(7, 'issue'))).toBeNull();
    expect(reviewsStackOf(MODEL, { ...gh(12, 'pull'), repo: 'gadgets' })).toBeNull();
    expect(reviewsStackOf(null, gh(12, 'pull'))).toBeNull();
  });

  test('the link: its words, its stack, none for an issue the forge answered, none with Code review off', () => {
    const opened: string[] = [];
    let model: Pick<InboxPullsAnswer, 'pulls'> | null = MODEL;
    const action = refCardReviewsAction(() => model, (stack) => opened.push(stack));
    const link = action(gh(12), undefined);
    expect(link?.label).toBe(OPEN_IN_REVIEWS);
    link?.open();
    expect(opened).toEqual([reviewsStackOf(MODEL, gh(12))!]);
    expect(action(gh(12), issueAnswer)).toBeNull();
    model = null;
    expect(action(gh(12), undefined)).toBeNull();
  });
});
