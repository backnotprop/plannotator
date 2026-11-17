/**
 * Hide on the window's side (hiddenPulls.ts), the pure part. What regresses: a PR hidden here still in the list, the
 * board's or Reviews' counts until the next read; one stack layer's hide taking the whole stack's row; a PR shown
 * again kept in Hidden; a
 * GitLab merge request named with GitHub's mark.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { inboxPullStacks, inboxReviewRows, type InboxPull, type InboxPullsAnswer, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { forgetHiddenChanges, hiddenLabel, hiddenRepo, hiddenWith, hidToast, pullsShown, reviewsShown, shownToast, type HiddenChanges } from './hiddenPulls';
import { reviewsOnYou } from './reviewsModel';
import { sheetModel } from '../prs/sheetModel';

afterEach(() => forgetHiddenChanges());

const pull = (number: number, over: Partial<InboxPull> = {}): InboxPull =>
  ({ key: `github.com/northwind/api#${number}`, platform: 'github', host: 'github.com', repo: 'northwind/api', number, url: `https://github.com/northwind/api/pull/${number}`, title: `PR ${number}`, author: 'jun', mine: false, requested: true, state: 'open', base: 'main', head: `b${number}`, head_repo: 'northwind/api', additions: 1, deletions: 1, files: 1, review: null, approved_by: null, reviewers: [], checks: null, updated_at: '2026-11-14T10:00:00Z', merged_at: null, ...over }) as InboxPull;

// #7 and #8 ask for the person's review; #10 → #11 → #12 is a stack of the person's own (#11's base is #10's head).
const PULLS = [pull(7), pull(8), pull(10, { mine: true, requested: false }), pull(11, { mine: true, requested: false, base: 'b10' }), pull(12, { mine: true, requested: false, base: 'b11' })];
const MODEL: InboxPullsAnswer = { fetched_at: null, hosts: [], pulls: PULLS, links: {}, projects: {}, cards: {}, hidden: [] };
const REVIEWS: InboxReviewsAnswer = { fetched_at: null, hosts: [], rows: inboxReviewRows({ threads: [], stacks: inboxPullStacks(PULLS), links: {} }), projects: {}, hidden: [] };

const hid = (...numbers: number[]): HiddenChanges =>
  new Map(numbers.map((n) => [pull(n).key, { hide: true as const, record: { key: pull(n).key, title: `PR ${n}`, url: pull(n).url, at: '2026-11-17T10:00:00.000Z' }, since: 1_000 }]));

describe('what was hidden here leaves at once', () => {
  test('the list, the board\'s "need you" and the sidebar\'s On you no longer count it; Hidden lists it', () => {
    expect(sheetModel(MODEL, Date.now(), {}).head.needYou).toBe(2);
    expect(reviewsOnYou(REVIEWS)).toBe(2);
    const model = pullsShown(MODEL, hid(7))!;
    expect(model.pulls.map((p) => p.number)).toEqual([8, 10, 11, 12]);
    expect(model.hidden!.map((h) => h.key)).toEqual([pull(7).key]);
    expect(sheetModel(model, Date.now(), {}).head.needYou).toBe(1);
    expect(reviewsOnYou(reviewsShown(REVIEWS, hid(7))!)).toBe(1);
  });

  test("a stack's layer hides that layer only: the stack's row stays with the others", () => {
    const rows = reviewsShown(REVIEWS, hid(11))!.rows;
    const stack = rows.find((row) => row.pull_keys.includes(pull(10).key))!;
    expect(stack.pull_keys).toEqual([pull(10).key, pull(12).key]);
    expect(stack.stacks[0]!.layers.map((l) => l.number)).toEqual([10, 12]);
    expect(reviewsShown(REVIEWS, hid(10, 11, 12))!.rows.some((row) => row.pull_keys.includes(pull(10).key))).toBe(false);
  });

  test('shown again here: out of Hidden at once (it comes back on the next read)', () => {
    const shown: HiddenChanges = new Map([[pull(7).key, { hide: false, since: 1_000 }]]);
    expect(hiddenWith([{ key: pull(7).key, title: 'PR 7', url: pull(7).url, at: '2026-11-17T10:00:00.000Z' }], shown)).toEqual([]);
  });

  test('nothing hidden here: the answers as they came', () => {
    expect(pullsShown(MODEL, new Map())).toBe(MODEL);
    expect(reviewsShown(REVIEWS, new Map())).toBe(REVIEWS);
  });
});

describe('words', () => {
  test('one PR by its number, several by their count; a GitLab merge request by its own mark', () => {
    expect(hidToast([pull(7)])).toBe('Hid #7');
    expect(hidToast([pull(7), pull(8)])).toBe('Hid 2 pull requests');
    expect(shownToast(['#7'])).toBe('Showing #7 again');
    expect(shownToast(['#7', '#8', '#9'])).toBe('Showing 3 again');
    expect(hiddenLabel({ key: 'gitlab.com/northwind/data/ledger#61:pull' })).toBe('!61');
    expect(hiddenLabel({ key: 'github.com/northwind/api#7' })).toBe('#7');
    expect(hiddenRepo({ key: 'github.com/northwind/api#7' })).toBe('northwind/api');
    expect(hiddenRepo({ key: 'gitlab.com/northwind/data/ledger#61:pull' })).toBe('gitlab.com/northwind/data/ledger');
  });
});
