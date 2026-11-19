import { describe, expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { composeActions, type ComposeTarget } from './model';
import { pullHandoffMessage, pullHandoffThreadName } from '../pulls/model';
import { forgetUnsentReview, keepUnsentReview, localReviewMessage, localReviewName, reviewBoxPull, reviewBoxPulls, reviewDefaultTo, reviewLinkListed, reviewLinkStack, reviewLinkWords, reviewToWithChanges, unsentReview, type ReviewBoxPull } from './reviewBox';

const pull = (number: number, over: Partial<InboxPull> = {}): InboxPull =>
  ({
    key: `github.com/o/web#${number}`,
    host: 'github.com',
    repo: 'o/web',
    platform: 'github',
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/web/pull/${number}`,
    state: 'open',
    head_repo: null,
    head: `b${number}`,
    base: 'main',
    author: 'dana',
    mine: true,
    requested: false,
    assigned: false,
    review: null,
    checks: null,
    reviewers: [],
    updated_at: '2026-11-04T10:00:00.000Z',
    ...over,
  }) as InboxPull;

const row = (stack: ReturnType<typeof inboxPullStacks>[number], over: Partial<InboxReviewRow> = {}): InboxReviewRow =>
  ({ id: stack.id, reviewed: false, move: 'not_reviewed', reason: 'open', thread_id: null, review: null, stacks: [stack], pull_keys: stack.layers.map((l) => l.key), link: null, pull_reason: null, landed: [], updated_at: '', ...over }) as InboxReviewRow;

const answerOf = (rows: InboxReviewRow[], projects: Record<string, string[]> = { 'github.com/o/web': ['prj_1'] }): InboxReviewsAnswer => ({ rows, projects }) as unknown as InboxReviewsAnswer;

describe('what is kept when the box closes', () => {
  const [one] = inboxPullStacks([pull(1)]);
  const [two] = inboxPullStacks([pull(2)]);
  const a = { id: one!.id } as ReviewBoxPull;
  const b = { id: two!.id } as ReviewBoxPull;

  test('words typed for one PR open with that PR and the plain door, never another PR', () => {
    keepUnsentReview({ body: 'focus on the retries', threadName: 'My own name', kind: 'pr', pick: a, link: '' });
    try {
      expect(unsentReview(a).body).toBe('focus on the retries');
      expect(unsentReview(null)).toMatchObject({ body: 'focus on the retries', kind: 'pr', pick: a });
      expect(unsentReview(b)).toMatchObject({ body: '', threadName: null, pick: null });
    } finally {
      forgetUnsentReview();
    }
  });

  test("words typed on local changes stay away from a PR's door; a box left empty reopens as new", () => {
    keepUnsentReview({ body: 'focus on the retries', threadName: null, kind: 'local', pick: null, link: '' });
    expect(unsentReview(a).body).toBe('');
    expect(unsentReview(null).body).toBe('focus on the retries');
    keepUnsentReview({ body: '  ', threadName: null, kind: 'pr', pick: a, link: '' });
    expect(unsentReview(null)).toMatchObject({ kind: 'local', pick: null });
    forgetUnsentReview();
  });
});

describe('the picker', () => {
  const [one] = inboxPullStacks([pull(1)]);
  const [two] = inboxPullStacks([pull(2)]);
  const agent = { host: 'claude-code', session: 's', name: 'Claude Code', ended: false };
  const names = new Map([['prj_1', 'web-app']]);

  test('in review only as the page says it: a thread that merely named the PR is not, and picking starts one', () => {
    const link = { thread_id: 't', via: 'url', agent } as never;
    expect(reviewBoxPull(one!, row(one!, { reviewed: false, thread_id: 't', link }), {}, ['prj_1']).thread).toBeNull();
    expect(reviewBoxPull(one!, row(one!, { reviewed: true, thread_id: 't', link }), {}, ['prj_1']).thread?.id).toBe('t');
  });

  test('not reviewed comes first, whatever the order of the rows; one in review knows its thread, so it can open it', () => {
    const inReview = row(one!, { reviewed: true, thread_id: 't_1', link: { thread_id: 't_1', agent } as never });
    const pulls = reviewBoxPulls(answerOf([inReview, row(two!)]), names);
    expect(pulls.map((p) => [p.label, p.thread?.id ?? null])).toEqual([['#2', null], ['#1', 't_1']]);
    expect(pulls[0]!.project).toBe('web-app');
  });

  test("a thread whose agent ended is no thread to go back to: the PR can start a new one", () => {
    const ended = row(one!, { reviewed: true, thread_id: 't_1', link: { thread_id: 't_1', agent: { ...agent, ended: true } } as never });
    expect(reviewBoxPulls(answerOf([ended]), names)[0]!.thread).toBeNull();
  });

  test('a PR of a repository that is no project is left out: no agent could review it from this list', () => {
    expect(reviewBoxPulls(answerOf([row(one!)], {}), names)).toEqual([]);
  });

  test('a stack listed by two rows is offered once, and nothing listed yet is an empty list', () => {
    expect(reviewBoxPulls(answerOf([row(one!), row(one!, { reviewed: true, thread_id: 't' })]), names)).toHaveLength(1);
    expect(reviewBoxPulls(null, names)).toEqual([]);
  });
});

describe('the words and the name', () => {
  const base = { changes: 'uncommitted' as const, project: 'web-app', branch: 'jitter', base: 'main', words: '' };

  test('the skill is always named, and what feedback means is always said, with or without the words', () => {
    for (const words of ['', 'Start with the retries.']) {
      const text = localReviewMessage({ ...base, words });
      expect(text).toContain('/review-curate');
      expect(text).toContain('make them');
    }
  });

  test("the person's words stay, between the ask and what comes after it, and blank ones add nothing", () => {
    const parts = localReviewMessage({ ...base, words: '  Start with the retries. ' }).split('\n\n');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe('Start with the retries.');
    expect(localReviewMessage({ ...base, words: '   ' }).split('\n\n')).toHaveLength(2);
  });

  test('each choice asks for its own changes; an unknown branch or project is left out rather than guessed', () => {
    const asks = (['uncommitted', 'last', 'branch'] as const).map((changes) => localReviewMessage({ ...base, changes }));
    expect(new Set(asks).size).toBe(3);
    expect(asks[2]).toContain('against main');
    const unknown = localReviewMessage({ ...base, project: null, branch: null, base: null });
    expect(unknown).not.toContain('null');
    expect(unknown).not.toContain('()');
  });

  test('the name tells the choices apart, and reads without a branch', () => {
    expect(localReviewName('uncommitted', 'web-app', 'main', 'main')).toBe('Review web-app: uncommitted on main');
    expect(localReviewName('branch', 'web-app', 'jitter', 'main')).toBe('Review web-app: jitter against main');
    expect(localReviewName('last', 'web-app', null, null)).toBe('Review web-app: last commit');
    expect(localReviewName('uncommitted', null, null, null)).not.toContain('null');
  });
});

describe('who To names', () => {
  const live = (session: string, id: string) => ({ session, project: { id } });
  const launch = { agents: [{ agent: 'claude-code' }], projects: [{ id: 'prj_a' }, { id: 'prj_b' }] };

  test('the project in view comes before the session last sent to, and that before any other', () => {
    const targets = [live('s1', 'prj_a'), live('s2', 'prj_b'), live('s3', 'prj_c')];
    expect(reviewDefaultTo(targets, launch, 'prj_b', 's3')).toEqual({ session: 's2' });
    expect(reviewDefaultTo(targets, launch, null, 's3')).toEqual({ session: 's3' });
    expect(reviewDefaultTo(targets, launch, null, null)).toEqual({ session: 's1' });
  });

  test('with no live agent, a new session in the project in view; with nothing to start, nobody', () => {
    expect(reviewDefaultTo([], launch, 'prj_b', null)).toEqual({ agent: 'claude-code', projectId: 'prj_b' });
    expect(reviewDefaultTo([], launch, 'prj_gone', null)).toEqual({ agent: 'claude-code', projectId: 'prj_a' });
    expect(reviewDefaultTo([], null, 'prj_b', null)).toBeNull();
    expect(reviewDefaultTo([], { agents: [], projects: launch.projects }, null, null)).toBeNull();
  });
});

describe('the palette', () => {
  const none: ComposeTarget[] = [];
  const kinds = (q: string, reviews: boolean) => composeActions(q, none, null, reviews).map((a) => a.kind);

  test('New review… is there only while Code review is on', () => {
    expect(kinds('', true)).toEqual(['new', 'review']);
    expect(kinds('', false)).toEqual(['new']);
    expect(kinds('review', false)).toEqual([]);
  });

  test('"review" and "new review" call it alone; "new" offers both', () => {
    expect(kinds('review', true)).toEqual(['review']);
    expect(kinds('new review', true)).toEqual(['review']);
    expect(kinds('new', true)).toEqual(['new', 'review']);
  });
});

describe('a pull request link', () => {
  const read = (number: number, over: Partial<InboxPull> = {}) => ({ ok: true as const, cli: 'gh' as const, pull: pull(number, over), projects: [], thread_id: null });
  const listed = (stack: InboxPull[]) => [{ id: 's', stack: inboxPullStacks(stack)[0]!, label: '', title: '', projects: ['p'], thread: null, project: null }];

  test('an open layer goes the way of its stack; a merged one is reviewed on its own', () => {
    const merged = pull(411, { state: 'merged', head: 'b411' });
    const stack = [merged, pull(412, { base: 'b411' }), pull(413, { base: 'b412' })];
    expect(reviewLinkListed(read(412), listed(stack))?.id).toBe('s');
    expect(reviewLinkListed(read(411, { state: 'merged' }), listed(stack))).toBeNull();
  });

  test('a merged or closed PR hands off as itself, and stays what it is', () => {
    for (const state of ['open', 'merged', 'closed'] as const) {
      const stack = reviewLinkStack(pull(411, { state }));
      expect(stack.layers.map((layer) => [layer.number, layer.state])).toEqual([[411, state]]);
      expect(pullHandoffThreadName(stack, null)).toBe('Review #411: PR 411');
      expect(pullHandoffMessage(stack)).toContain('PR 411');
    }
  });

  test('its line names the tool and the host it was read from', () => {
    const line = reviewLinkWords({ ...read(8, { host: 'gitlab.example.com' }), cli: 'glab' });
    expect(line).toContain('glab');
    expect(line).toContain('gitlab.example.com');
  });
});

describe('To moves to an agent with changes to review', () => {
  const t = (session: string, project: string | null) => ({ session, project: { id: project } });
  const targets = [t('ses_a', 'prj_a'), t('ses_b', 'prj_b'), t('ses_c', 'prj_c'), t('ses_x', null)];
  test('the agent last sent to first, else list order; a project with no changes, or not read, is never picked', () => {
    expect(reviewToWithChanges(targets, new Map([['prj_b', 2], ['prj_c', 5]]), 'ses_c')).toBe('ses_c');
    expect(reviewToWithChanges(targets, new Map([['prj_b', 2], ['prj_c', 5]]), 'ses_a')).toBe('ses_b');
    expect(reviewToWithChanges(targets, new Map([['prj_a', 0], ['prj_c', 1]]), null)).toBe('ses_c');
    expect(reviewToWithChanges(targets, new Map([['prj_a', 0], ['prj_b', 0]]), 'ses_b')).toBeNull();
    expect(reviewToWithChanges([], new Map(), null)).toBeNull();
  });
});
