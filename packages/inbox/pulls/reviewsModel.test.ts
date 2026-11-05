import { expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull, type InboxReviewRow, type InboxReviewsAnswer, type InboxReviewThread } from '@plannotator/core/inbox-types';
import { readReviewFolds, reviewContextLine, reviewRowLine, reviewRowsIn, reviewViewOf, saveReviewFolds } from './reviewsModel';

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? 'northwind/web-app';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `PR ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    updated_at: '2026-11-03T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

const review = (fields: Partial<InboxReviewThread> = {}): InboxReviewThread =>
  ({
    thread_id: 't',
    project_id: 'prj_charges',
    title: 'Retry failed charges',
    round: 1,
    first_review_id: 'm_r',
    latest_review_id: 'm_r',
    reviewed_at: '2026-11-03T09:00:00.000Z',
    source: { kind: 'local', branch: 'retry-jitter', base: 'origin/main' },
    agent: { name: 'Claude Code', host: 'claude-code' },
    answered: false,
    verdict: null,
    ...fields,
  }) as unknown as InboxReviewThread;

const row = (fields: Partial<InboxReviewRow> = {}): InboxReviewRow =>
  ({
    id: 't',
    thread_id: 't',
    reviewed: true,
    move: 'on_you',
    reason: 'review_ready',
    review: review(),
    link: null,
    stacks: [],
    pull_keys: [],
    landed: [],
    updated_at: '2026-11-03T09:00:00.000Z',
    ...fields,
  }) as unknown as InboxReviewRow;

test('a local review: its branch and whose move; against the short name of its base', () => {
  const line = reviewRowLine(row());
  expect(line.kind).toBe('local');
  expect(line.lead).toBe('retry-jitter');
  expect(line.status).toBe('Review ready');
  expect(line.agent?.name).toBe('Claude Code');
  expect(reviewContextLine(row(), 'charges')).toBe('charges · Local changes on retry-jitter, against main');
});

test('a stack says how many layers are open and merged; one PR says its number', () => {
  const stack = inboxPullStacks([pull(1, { state: 'merged', head: 'a', merged_at: '2026-11-02T00:00:00.000Z' }), pull(2, { base: 'a', head: 'b' }), pull(3, { base: 'b', head: 'c' })])[0]!;
  expect(reviewRowLine(row({ stacks: [stack] }))).toMatchObject({ kind: 'stack', lead: '2 open, 1 merged' });
  const one = inboxPullStacks([pull(869)])[0]!;
  expect(reviewRowLine(row({ stacks: [one] }))).toMatchObject({ kind: 'pr', lead: '#869' });
});

test('a landed PR says so even once it left the list', () => {
  const landed = [{ key: 'k', thread_id: 't', state: 'merged', at: null, url: 'https://github.com/o/r/pull/7', number: 7, title: 'T', platform: 'github', head: 'b', through_review: 'older' }];
  expect(reviewRowLine(row({ landed } as never))).toMatchObject({ kind: 'pr', lead: '#7 merged' });
});

test('whose move decides the words and how loud they are', () => {
  const words = (fields: Partial<InboxReviewRow>) => {
    const { status, tone } = reviewRowLine(row(fields));
    return [status, tone ?? null];
  };
  const changes = review({ answered: true, verdict: { verdict: 'changes_requested', comments: 3 } } as never);
  expect(words({ move: 'agents', reason: 'feedback_sent', review: changes } as never)).toEqual(['Changes requested · 3 comments', 'warn']);
  const approved = review({ answered: true, verdict: { verdict: 'approved' } } as never);
  expect(words({ move: 'ready', reason: 'approved', review: approved } as never)[1]).toBe('ok');
  expect(words({ move: 'agents', reason: 'curating', review: null } as never)[0]).toBe('Curating…');
});

const answer = (rows: InboxReviewRow[]): InboxReviewsAnswer => ({ rows, projects: { 'github.com/northwind/web-app': ['prj_web'] } }) as unknown as InboxReviewsAnswer;

test('a project keeps its own rows, local ones by their thread; Mine keeps local reviews; Others does not', () => {
  const local = row();
  const theirs = row({ id: 'p', thread_id: null, reviewed: false, review: null, stacks: inboxPullStacks([pull(4, { mine: false, author: 'tomas' })]) } as never);
  expect(reviewRowsIn(answer([local, theirs]), 'prj_charges', 'all').map((r) => r.id)).toEqual(['t']);
  expect(reviewRowsIn(answer([local, theirs]), 'prj_web', 'all').map((r) => r.id)).toEqual(['p']);
  expect(reviewRowsIn(answer([local, theirs]), null, 'mine').map((r) => r.id)).toEqual(['t']);
  expect(reviewRowsIn(answer([local, theirs]), null, 'others').map((r) => r.id)).toEqual(['p']);
});

const options = { projectName: 'charges', onWholeThread: () => {}, onOpenStack: () => {} };
const messages = [{ id: 'm_1' }, { id: 'm_2' }, { id: 'm_r' }];

test('from an ordinary thread: what came before the first review folds, and names the thread', () => {
  const view = reviewViewOf(row(), { messages, subject: 'Retries', thread_name: 'Retry worker cleanup' }, options);
  expect(view.firstReviewId).toBe('m_r');
  expect(view.fromThread).toBe('Retry worker cleanup');
  expect(reviewViewOf(row(), { messages, subject: 'Retries' }, options).fromThread).toBe('Retries');
});

test('a thread started for the review opens whole: its first message is the request', () => {
  const owner = row({ link: { via: 'owner' } } as never);
  expect(reviewViewOf(owner, { messages, subject: 'Review #869' }, options)).toMatchObject({ firstReviewId: null, fromThread: null });
});

test('a first message that is the review folds nothing; so does a review the thread no longer has', () => {
  expect(reviewViewOf(row(), { messages: [{ id: 'm_r' }], subject: 'x' }, options).firstReviewId).toBeNull();
  expect(reviewViewOf(row(), { messages: [{ id: 'm_1' }], subject: 'x' }, options).firstReviewId).toBeNull();
});

test('the groups start folded, are remembered, and a bad stored value is the default', () => {
  const store = new Map<string, string>();
  const saved = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
  try {
    expect(readReviewFolds()).toEqual({ waiting: false, not_reviewed: false });
    saveReviewFolds({ waiting: true, not_reviewed: false });
    expect(readReviewFolds()).toEqual({ waiting: true, not_reviewed: false });
    store.set([...store.keys()][0]!, '{not json');
    expect(readReviewFolds()).toEqual({ waiting: false, not_reviewed: false });
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: saved });
  }
});
