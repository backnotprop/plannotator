/**
 * Bulk Merge's plan (approval "inbox-pr-board-bulk": "merge the green ones and tell me about the rest"). What
 * regresses: a PR the popover would not offer Merge for counted as green; a stack's upper layer merged before the one
 * under it (it would land in that layer's branch); the reason a pick stays naming the wrong cause; the bar's hint not
 * saying which picks stay.
 */
import { expect, test } from 'bun:test';
import type { InboxPull, InboxPullStack } from '@plannotator/core/inbox-types';
import { cantMergeWhy, mergeHint, mergePlan } from './bulkMerge';

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? 'northwind/ledger';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Change ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    head_sha: 'a'.repeat(40),
    additions: 1,
    deletions: 1,
    files: 1,
    review: 'approved',
    approved_by: 'jun',
    reviewers: [],
    checks: 'success',
    conflicts: false,
    updated_at: '2026-11-08T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

test('a PR merges only when the popover would offer Merge; each other pick names its own reason', () => {
  expect(cantMergeWhy(pull(1), null)).toBeNull();
  expect(cantMergeWhy(pull(1, { state: 'draft' }), null)).toBe('it is a draft');
  expect(cantMergeWhy(pull(1, { conflicts: true }), null)).toBe('it conflicts with its base branch');
  expect(cantMergeWhy(pull(1, { conflicts: undefined }), null)).toBe('GitHub hasn’t said yet whether it conflicts');
  expect(cantMergeWhy(pull(1, { platform: 'gitlab', conflicts: undefined }), null)).toBe('GitLab hasn’t said yet whether it conflicts');
  expect(cantMergeWhy(pull(1, { review: 'changes_requested' }), null)).toBe('a reviewer asked for changes');
  expect(cantMergeWhy(pull(1, { review: 'review_required' }), null)).toBe('it still needs a review');
  expect(cantMergeWhy(pull(1, { checks: 'failure' }), null)).toBe('its checks are failing');
  expect(cantMergeWhy(pull(1, { checks: 'pending' }), null)).toBe('its checks are still running');
  expect(cantMergeWhy(pull(1, { head_sha: null }), null)).toBe('its head commit isn’t known');
  // No review needed and no checks ran: green, as the popover says.
  expect(cantMergeWhy(pull(1, { review: null, checks: null }), null)).toBeNull();
});

test('in a stack only the layer that lands next merges; the ones above wait on it', () => {
  const merged = pull(4, { state: 'merged', merged_at: '2026-11-08T10:00:00.000Z' });
  const lead = pull(5, { base: 'b4' });
  const upper = pull(6, { base: 'b5' });
  const stack: Pick<InboxPullStack, 'layers'> = { layers: [merged, lead, upper] };
  const plan = mergePlan([upper, lead], () => stack);
  expect(plan.merge.map((p) => p.number)).toEqual([5]);
  expect(plan.skip.map((s) => [s.pull.number, s.why])).toEqual([[6, 'it lands after #5']]);
});

test('the plan keeps the order given and the hint says which picks stay', () => {
  const plan = mergePlan([pull(8, { checks: 'failure' }), pull(7), pull(9, { state: 'draft' }), pull(3)], () => null);
  expect(plan.merge.map((p) => p.number)).toEqual([7, 3]);
  expect(plan.skip.map((s) => s.pull.number)).toEqual([8, 9]);
  expect(mergeHint(plan)).toBe('2 can’t merge now; they stay selected.');
  expect(mergeHint(mergePlan([pull(7), pull(8, { checks: 'failure' })], () => null))).toBe('1 can’t merge now; it stays selected.');
  expect(mergeHint(mergePlan([pull(8, { checks: 'failure' })], () => null))).toBe('#8 can’t merge now: its checks are failing.');
  expect(mergeHint(mergePlan([pull(8, { checks: 'failure' }), pull(9, { state: 'draft' })], () => null))).toBe('None of these can merge now.');
  expect(mergeHint(mergePlan([pull(7)], () => null))).toBeNull();
});
