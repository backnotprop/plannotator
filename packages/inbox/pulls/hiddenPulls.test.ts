/**
 * Hide on the window's side (hiddenPulls.ts), the pure part. What regresses: a PR hidden here still in the list, the
 * board's or Reviews' counts until the next read; one stack layer's hide taking the whole stack's row; a PR shown
 * again kept in Hidden; a change made here let go before the lists caught up, or held for the rest of the session;
 * the Inbox list's Hide offered on a thread with nothing to hide; a GitLab merge request named with GitHub's mark.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { inboxPullStacks, inboxReviewRows, type InboxListRow, type InboxPull, type InboxPullsAnswer, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { forgetHiddenChanges, hiddenInProject, hidLead, hideRepo, repoChangeKey, HIDDEN_GIVE_UP_MS, HIDDEN_SETTLE_MS, hiddenChangesNow, hiddenLabel, hiddenRepo, hiddenWith, hideKeysWords, hidePulls, hidToast, onHiddenWritten, showPulls, pullsShown, reviewsShown, settleHidden, shownToast, type HiddenChanges } from './hiddenPulls';
import { rowMenuActions } from '../rowMenu';
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

describe('a change made here settles', () => {
  const hiddenNow = [{ key: pull(7).key, title: 'PR 7', url: pull(7).url, at: '2026-11-17T10:00:00.000Z' }];
  const keys = () => [...hiddenChangesNow().keys()];
  // The write never answers: what is held here is all the test reads.
  let savedFetch: typeof fetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });
  test('held whatever an answer says at first; then once an answer agrees; and never past the give-up time', async () => {
    const start = Date.now();
    void hidePulls([pull(7)], new Date(start)).catch(() => {});
    // The write is on its way: an answer that does not list it yet keeps it hidden here.
    settleHidden([], start + 1_000);
    expect(keys()).toEqual([pull(7).key]);
    settleHidden([], start + HIDDEN_SETTLE_MS + 1);
    expect(keys()).toEqual([pull(7).key]);
    settleHidden(hiddenNow, start + HIDDEN_SETTLE_MS + 2);
    expect(keys()).toEqual([]);
  });
  test('the server forgot it (merged meanwhile): after the give-up time its answer stands', () => {
    const start = Date.now();
    void hidePulls([pull(8)], new Date(start)).catch(() => {});
    settleHidden([], start + HIDDEN_GIVE_UP_MS - 1);
    expect(keys()).toEqual([pull(8).key]);
    settleHidden([], start + HIDDEN_GIVE_UP_MS);
    expect(keys()).toEqual([]);
  });
});

test('a rejected second bulk hide keeps the first batch hidden and reloads the list', async () => {
  const picks = Array.from({ length: 201 }, (_, i) => pull(i + 1));
  const savedFetch = globalThis.fetch;
  let writes = 0;
  let reloads = 0;
  const unsubscribe = onHiddenWritten(() => { reloads++; });
  globalThis.fetch = (async () => {
    const body = ++writes === 1 ? { hidden: [] } : { error: 'Second batch refused' };
    return Response.json(body, { status: writes === 1 ? 200 : 400 });
  }) as unknown as typeof fetch;
  try {
    await expect(hidePulls(picks)).rejects.toThrow('Second batch refused');
    const model = pullsShown({ ...MODEL, pulls: picks }, hiddenChangesNow())!;
    expect(model.pulls.map((p) => p.key)).toEqual([picks[200]!.key]);
    expect(reloads).toBe(1);

    writes = 0;
    await expect(showPulls(picks.map((p) => p.key))).rejects.toThrow('Second batch refused');
    expect(hiddenChangesNow().get(picks[0]!.key)?.hide).toBe(false);
    expect(reloads).toBe(2);
  } finally {
    unsubscribe();
    globalThis.fetch = savedFetch;
  }
});

describe('the Inbox list\'s Hide', () => {
  const listRow = (over: Partial<InboxListRow>): InboxListRow => ({ thread_id: 'thr_1', subject: 'Fix', section: 'waiting', resolved_at: null, read_at: null, ...over }) as InboxListRow;
  test('a thread row offers it only with open PRs not hidden, and not once archived', () => {
    expect(rowMenuActions(listRow({ hide_pulls: ['github.com/o/r#1'] }), true)).toContain('hide-pulls');
    expect(rowMenuActions(listRow({}), true)).not.toContain('hide-pulls');
    expect(rowMenuActions(listRow({ hide_pulls: [] }), true)).not.toContain('hide-pulls');
    expect(rowMenuActions(listRow({ hide_pulls: ['github.com/o/r#1'], resolved_at: '2026-11-01T00:00:00.000Z' }), true, null, 'archived')).not.toContain('hide-pulls');
  });
  test('it names how many, and a GitLab merge request as one', () => {
    expect(hideKeysWords(['github.com/o/r#1', 'github.com/o/r#2', 'github.com/o/r#3'])).toContain('3');
    expect(hideKeysWords(['gitlab.com/g/p#4:pull'])).toContain('merge request');
    expect(hideKeysWords(['github.com/o/r#1'])).not.toContain('merge request');
  });
});

describe('labels', () => {
  test('one PR by its number, several by their count; a GitLab merge request by its own mark', () => {
    expect(hidToast([pull(7)])).toContain('#7');
    expect(hidToast([pull(7), pull(8)])).toContain('2');
    expect(shownToast(['#7'])).toContain('#7');
    expect(shownToast(['#7', '#8', '#9'])).toContain('3');
    expect(hiddenLabel({ key: 'gitlab.com/northwind/data/ledger#61:pull' })).toBe('!61');
    expect(hiddenLabel({ key: 'github.com/northwind/api#7' })).toBe('#7');
    expect(hiddenRepo({ key: 'github.com/northwind/api#7' })).toBe('northwind/api');
    expect(hiddenRepo({ key: 'gitlab.com/northwind/data/ledger#61:pull' })).toBe('gitlab.com/northwind/data/ledger');
  });
});

describe('a repository hidden here leaves at once', () => {
  const REPO = 'github.com/northwind/api';
  const web = pull(20, { key: 'github.com/northwind/web#20', repo: 'northwind/web', host: 'github.com' });
  const repoHid: HiddenChanges = new Map([[repoChangeKey(REPO), { hide: true, repo: { key: REPO, label: 'api', at: '2026-11-17T10:00:00.000Z' }, since: 1_000 }]]);

  test("every PR in it leaves the board, its counts and Reviews; Hidden lists the repository, not each PR", () => {
    const model = pullsShown({ ...MODEL, pulls: [...PULLS, web] }, repoHid)!;
    expect(model.pulls.map((p) => p.key)).toEqual([web.key]);
    expect(sheetModel(model, Date.now(), {}).head).toMatchObject({ open: 1, repos: 1 });
    expect(model.hidden).toEqual([]);
    expect(model.hidden_repos!.map((r) => r.key)).toEqual([REPO]);
    expect(reviewsShown(REVIEWS, repoHid)!.rows).toEqual([]);
  });

  test('a refused write puts it back and says why', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'No.' }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    try {
      await expect(hideRepo({ key: REPO, label: 'api' })).rejects.toThrow();
      expect(pullsShown(MODEL, hiddenChangesNow())!.pulls).toHaveLength(PULLS.length);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

test("a Hide's toast says its thread for one PR, their thread for several, and counts several threads", () => {
  expect(hidLead('Hid #7', 0, 1)).toBe('Hid #7');
  const one = hidLead('Hid #7', 1, 1);
  const several = hidLead('Hid 2 pull requests', 1, 2);
  expect(one).toMatch(/\bits thread$/);
  expect(several).toMatch(/\btheir thread$/);
  expect(hidLead('Hid 2 pull requests', 2, 2)).toMatch(/\b2 threads$/);
});

test("Reviews' Hidden fold under a project filter lists that project's hidden PRs only", () => {
  const records = [{ key: 'github.com/northwind/api#7' }, { key: 'github.com/northwind/web#20' }];
  const projects = { 'github.com/northwind/api': ['prj_api'], 'github.com/northwind/web': ['prj_web'] };
  expect(hiddenInProject(records, 'prj_web', projects).map((h) => h.key)).toEqual(['github.com/northwind/web#20']);
  expect(hiddenInProject(records, null, projects)).toHaveLength(2);
  expect(hiddenInProject([{ key: 'github.com/northwind/api' }], 'prj_web', projects)).toEqual([]);
  // A fork-based project (its clone is the person's fork): a PR to upstream is in it by its head repository.
  const fork = { key: 'github.com/upstream/web#31', head_repo: 'northwind/web' };
  expect(hiddenInProject([fork, { key: 'github.com/upstream/web#32' }], 'prj_web', projects)).toEqual([fork]);
});
