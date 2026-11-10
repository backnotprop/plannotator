/**
 * The Sheet's rules (sheetModel.ts): whose turn it is, the order inside a repository, the fold over 8, the filter, the
 * header's counts and the Merged view. Each test guards one rule the page's look depends on.
 */
import { describe, expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull } from '@plannotator/core/inbox-types';
import { FOLD_OVER, foldsToStrip, matchesQuery, mergeOffered, mergedModel, needsYou, orderUnits, sheetModel, statusParts, statusWords, topFirst } from './sheetModel';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

let n = 100;
const pr = (over: Partial<InboxPull> = {}): InboxPull => {
  const number = over.number ?? n++;
  const repo = over.repo ?? 'northwind/ledger';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Change ${number}`,
    author: 'kim',
    mine: false,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    head_sha: 'a'.repeat(40),
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    conflicts: false,
    updated_at: day(1),
    merged_at: null,
    ...over,
  };
};

describe('needsYou (your turn)', () => {
  test('a review asked of you, or changes asked on your own PR', () => {
    expect(needsYou(pr({ requested: true }))).toBe('review');
    expect(needsYou(pr({ mine: true, review: 'changes_requested' }))).toBe('changes');
  });
  test('not your turn: your own PR waiting on others, a teammate PR not asked of you, a merged one', () => {
    expect(needsYou(pr({ mine: true }))).toBeNull();
    expect(needsYou(pr({ mine: true, requested: true }))).toBeNull();
    expect(needsYou(pr({ review: 'changes_requested' }))).toBeNull();
    expect(needsYou(pr({ requested: true, state: 'merged' }))).toBeNull();
  });
  test('a draft that asks for your review is your turn, and says it is a draft', () => {
    const draft = pr({ requested: true, state: 'draft' });
    expect(needsYou(draft)).toBe('review');
    expect(statusWords(draft, NOW)).toBe('Draft · waits on your review');
  });
});

test('"Waits on" names its reviewer as a person, so the pop-up and the stack page draw their face', () => {
  const waits = pr({ reviewers: ['nina-k', 'lena-v'], checks: 'success' });
  expect(statusParts(waits, NOW)).toEqual(['Waits on ', { person: 'nina-k' }, ' and 1 more']);
  expect(statusWords(waits, NOW)).toBe('Waits on nina-k and 1 more');
  expect(statusParts(pr({ reviewers: ['nina-k'] }), NOW)).toEqual(['Waits on ', { person: 'nina-k' }]);
  // Words with no one in them stay one plain part.
  expect(statusParts(pr({ requested: true }), NOW)).toEqual(['Waits on your review']);
});

describe('order inside a repository', () => {
  test('needs you (waiting longest first), then blocking a stack, then changes requested, then ready to land, then the rest', () => {
    const rest = pr({ number: 1, updated_at: day(0) });
    const ready = pr({ number: 2, review: 'approved' });
    const changes = pr({ number: 3, review: 'changes_requested' });
    const youNew = pr({ number: 4, requested: true, updated_at: day(1) });
    const youOld = pr({ number: 5, requested: true, updated_at: day(9) });
    // A two-layer stack: its bottom holds the top up.
    const bottom = pr({ number: 6, head: 'feat/base' });
    const top = pr({ number: 7, base: 'feat/base' });
    const stacks = inboxPullStacks([rest, ready, changes, youNew, youOld, bottom, top]);
    const order = orderUnits(stacks).map((s) => s.layers.map((l) => l.number).join('+'));
    expect(order).toEqual(['5', '4', '6+7', '3', '2', '1']);
  });
  test('the risk rating breaks a tie inside a tier, High first', () => {
    const a = pr({ number: 10, requested: true, updated_at: day(3) });
    const b = pr({ number: 11, requested: true, updated_at: day(3) });
    const c = pr({ number: 12, requested: true, updated_at: day(3) });
    const order = orderUnits(inboxPullStacks([a, b, c]), { [c.key]: 'high', [b.key]: 'medium' }).map((s) => s.layers[0]!.number);
    expect(order).toEqual([12, 11, 10]);
  });
  test('a stack takes its best layer’s place: a layer on you lifts the whole stack', () => {
    const lone = pr({ number: 20, review: 'approved' });
    const base = pr({ number: 21, head: 'x1' });
    const mid = pr({ number: 22, head: 'x2', base: 'x1', requested: true });
    const stacks = orderUnits(inboxPullStacks([lone, base, mid]));
    expect(stacks[0]!.layers.map((l) => l.number)).toEqual([21, 22]);
  });
});

describe('fold over 8', () => {
  const chain = (count: number) => {
    const layers = Array.from({ length: count }, (_, i) => pr({ number: 500 + i, head: `s${i}`, base: i === 0 ? 'main' : `s${i - 1}` }));
    return inboxPullStacks(layers)[0]!;
  };
  test('8 PRs keep their joined tiles; 9 fold to one strip', () => {
    expect(FOLD_OVER).toBe(8);
    expect(chain(8).layers).toHaveLength(8);
    expect(foldsToStrip(chain(8))).toBe(false);
    expect(foldsToStrip(chain(9))).toBe(true);
  });
  test('the stack view reads top first, the base at the bottom', () => {
    expect(topFirst(chain(3)).map((l) => l.number)).toEqual([502, 501, 500]);
  });
});

describe('filter', () => {
  const pull = pr({ number: 412, title: 'Retry the charge client', author: 'mara-lee', repo: 'northwind/billing-svc' });
  test('title, author, repository and number, every word', () => {
    expect(matchesQuery(pull, 'retry')).toBe(true);
    expect(matchesQuery(pull, 'MARA')).toBe(true);
    expect(matchesQuery(pull, 'billing')).toBe(true);
    expect(matchesQuery(pull, '#412')).toBe(true);
    expect(matchesQuery(pull, '412')).toBe(true);
    expect(matchesQuery(pull, '41')).toBe(false);
    expect(matchesQuery(pull, 'retry ledger')).toBe(false);
    expect(matchesQuery(pull, '  ')).toBe(true);
  });
});

describe('Merge is offered only when the forge said it can merge', () => {
  test('open, no conflict, nothing still required, checks not failing or running', () => {
    expect(mergeOffered(pr({ review: 'approved' }))).toBe(true);
    expect(mergeOffered(pr({ conflicts: undefined }))).toBe(false);
    expect(mergeOffered(pr({ conflicts: true }))).toBe(false);
    expect(mergeOffered(pr({ review: 'review_required' }))).toBe(false);
    expect(mergeOffered(pr({ review: 'changes_requested' }))).toBe(false);
    expect(mergeOffered(pr({ checks: 'failure' }))).toBe(false);
    expect(mergeOffered(pr({ checks: 'pending' }))).toBe(false);
    expect(mergeOffered(pr({ state: 'draft' }))).toBe(false);
    expect(mergeOffered(pr({ head_sha: null }))).toBe(false);
  });
});

describe('sheetModel', () => {
  test('the header counts each PR once; repositories with the most on you come first; outside ones are marked', () => {
    const a = pr({ repo: 'northwind/ledger', requested: true });
    const b = pr({ repo: 'northwind/ledger', checks: 'failure' });
    const c = pr({ repo: 'elsewhere/tool', requested: true });
    const d = pr({ repo: 'elsewhere/tool', requested: true });
    const landed = pr({ repo: 'northwind/ledger', state: 'merged', merged_at: day(2) });
    const old = pr({ repo: 'northwind/ledger', state: 'merged', merged_at: day(10) });
    const model = sheetModel({ pulls: [a, b, c, d, a, landed, old], projects: { 'github.com/northwind/ledger': ['prj_1'] } }, NOW);
    expect(model.head).toEqual({ open: 4, repos: 2, needYou: 3, failing: 1, landedWeek: 1 });
    expect(model.sections.map((s) => [s.label, s.outside, s.needYou])).toEqual([
      ['tool', true, 2],
      ['ledger', false, 1],
    ]);
  });

  test('Merged: the last 14 days, latest first, and the repositories with nothing merged', () => {
    const quiet = pr({ repo: 'northwind/docs' });
    const one = pr({ repo: 'northwind/ledger', state: 'merged', merged_at: day(1) });
    const two = pr({ repo: 'northwind/ledger', state: 'merged', merged_at: day(13) });
    const gone = pr({ repo: 'northwind/ledger', state: 'merged', merged_at: day(15) });
    const model = mergedModel({ pulls: [two, quiet, gone, one] }, NOW);
    expect(model.sections.map((s) => [s.label, s.pulls.map((p) => p.number)])).toEqual([['ledger', [one.number, two.number]]]);
    expect(model.quiet).toEqual(['docs']);
  });
});
