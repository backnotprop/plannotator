import { describe, expect, test } from 'bun:test';
import { planFolds } from '@plannotator/core/inbox-folding';
import { inboxPullStacks, type InboxPull, type InboxReviewRow, type InboxReviewsAnswer, type InboxReviewThread } from '@plannotator/core/inbox-types';
import { readReviewFolds, reviewContextLine, reviewEarlierHidden, reviewOpenPlan, reviewRowLine, reviewRowsIn, reviewRowTitle, reviewViewOf, saveReviewFolds } from './reviewsModel';

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

test('a row names people as people, not baked into the words: each one can have a face, the text stays the same', () => {
  const asked = row({ reason: 'requested', review: null, stacks: inboxPullStacks([pull(880, { mine: false, requested: true, author: 'tomas' })]) } as never);
  const line = reviewRowLine(asked);
  expect(line.status).toBe("Review requested · tomas's PR");
  expect(line.parts).toEqual(['Review requested · ', { person: 'tomas', tail: "'s" }, ' PR']);
  const waiting = reviewRowLine(row({ move: 'waiting', reason: 'forge_review', stacks: inboxPullStacks([pull(865, { reviewers: ['lena-v', 'kai'] })]) } as never));
  expect(waiting.status).toBe('Waiting on lena-v’s review');
  expect(waiting.parts).toEqual(['Waiting on ', { person: 'lena-v', tail: '’s' }, ' review']);
  const listed = (fields: Partial<InboxPull>) => reviewRowLine(row({ reviewed: false, move: 'not_reviewed', reason: 'not_reviewed', review: null, stacks: inboxPullStacks([pull(7, fields)]) } as never)).parts;
  expect(listed({ mine: false, author: 'tomas', state: 'draft' })).toEqual([{ person: 'tomas' }, ' · draft']);
  expect(listed({ mine: true })).toEqual(['yours', ' · checks passed']);
  expect(listed({ mine: false, author: null })).toEqual(['a deleted account', ' · checks passed']);
  expect(reviewRowLine(row({ reason: 'requested', review: null, stacks: inboxPullStacks([pull(881, { mine: false, requested: true, author: null })]) } as never)).parts).toEqual(['Review requested']);
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

test('before the first review: what was read and needs nothing is left out; a new message or anything open never is', () => {
  const msg = (id: string, fields = {}) => ({ id, author: { kind: 'agent' }, ...fields }) as never;
  const question = (state: string) => ({ questions: [{ key: 'q', state }] });
  const thread = [
    msg('read'),
    msg('new'),
    msg('asks', question('open')),
    msg('picked', question('picked')),
    msg('answered', question('sent')),
    msg('todo', { actions: [{ state: 'open' }] }),
    msg('todo-done', { actions: [{ state: 'done' }] }),
    msg('m_r'),
    msg('after'),
  ];
  expect(reviewEarlierHidden(thread, 'm_r', new Set(['new']))).toEqual(['read', 'answered', 'todo-done']);
  expect(reviewEarlierHidden(thread, 'gone', new Set())).toEqual([]);
  expect(reviewEarlierHidden([msg('m_r')], 'm_r', new Set())).toEqual([]);
});

describe('how a thread opens from Reviews', () => {
  const msg = (id: string, fields = {}) => ({ id, author: { kind: 'agent' }, ...fields });
  const question = (id: string) => msg(id, { questions: [{ key: 'q', kind: 'choice', state: 'open', revision: 0, sent_revision: 0 }] as never });
  const actionItem = (id: string, over: Record<string, unknown> = {}) => msg(id, { actions: [{ key: 'a-1', kind: 'action', state: 'open', revision: 0, sent_revision: 0, ...over }] as never });
  const planOf = (messages: ReturnType<typeof msg>[], first: string | null, latest: string | null, fresh = new Set<string>()) =>
    reviewOpenPlan({ messages: messages as never, firstReviewId: first, latestReviewId: latest, fresh, folds: planFolds(messages as never, fresh, messages.length) });
  const hiddenOf = (plan: { hidden: string[][] }) => plan.hidden.flat();

  test('six read messages, a question and an action item among them: both show, open, and the rest is left out with no row to click', () => {
    const thread = [msg('a'), msg('b'), question('q'), actionItem('t'), msg('c'), msg('d'), msg('r'), msg('after')];
    const plan = planOf(thread, 'r', 'r');
    expect(plan.left).toEqual(['a', 'b', 'c', 'd']);
    for (const id of ['q', 't', 'r']) {
      expect(hiddenOf(plan)).not.toContain(id);
      expect(plan.folded.has(id)).toBe(false);
    }
    expect(plan.hidden).toEqual([]);
  });

  test('a staged Done still waits on the person, so its note box and its way to undo stay', () => {
    const staged = actionItem('t', { state: 'picked', action_result: { by: 'person', status: 'done', staged: true } });
    const thread = [msg('a'), staged, msg('b'), msg('c'), msg('d'), msg('e'), msg('r')];
    const plan = planOf(thread, 'r', 'r');
    expect(plan.left).not.toContain('t');
    expect(plan.folded.has('t')).toBe(false);
    expect(hiddenOf(plan)).not.toContain('t');
  });

  test('three messages, a review, five more, all read: the review is drawn and open, however the fold runs', () => {
    const thread = [msg('a'), msg('b'), msg('c'), msg('r'), msg('1'), msg('2'), msg('3'), msg('4'), msg('5')];
    const plan = planOf(thread, 'r', 'r');
    expect(plan.left).toEqual(['a', 'b', 'c']);
    expect(hiddenOf(plan)).not.toContain('r');
    expect(plan.folded.has('r')).toBe(false);
    for (const id of hiddenOf(plan)) expect(plan.left).not.toContain(id);
  });

  test('after the first review too: a question stays out of the runs, which split around it, and the first review of several is drawn', () => {
    const thread = [msg('r1'), msg('1'), msg('2'), question('q'), msg('3'), msg('4'), msg('r2'), msg('5'), msg('6')];
    const plan = planOf(thread, 'r1', 'r2');
    expect(hiddenOf(plan)).not.toContain('q');
    expect(hiddenOf(plan)).not.toContain('r1');
    expect(hiddenOf(plan)).not.toContain('r2');
    expect(plan.folded.has('q')).toBe(false);
    expect(plan.folded.has('r2')).toBe(false);
    expect(plan.folded.has('r1')).toBe(true);
  });

  test('the first review is drawn even when the fold would have hidden it in a run', () => {
    const thread = [msg('0'), msg('00'), msg('r1'), msg('1'), msg('2'), msg('r2'), msg('5')];
    const plan = planOf(thread, 'r1', 'r2');
    expect(planFolds(thread as never, new Set(), thread.length).hidden.flat()).toContain('r1');
    expect(hiddenOf(plan)).not.toContain('r1');
  });

  test('a thread started for the review leaves nothing out', () => {
    expect(planOf([msg('ask'), msg('1'), msg('r')], null, 'r').left).toEqual([]);
  });
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

test("a review's lead is the PR the person handed it, whatever the agent's guide names; a Post goes there too", () => {
  const handed = { key: 'github.com/o/app#231', url: 'https://github.com/o/app/pull/231', number: 231, title: 'T', platform: 'github' as const, mine: false };
  const line = reviewRowLine(row({
    started: { kind: 'link', changes: null, pull: handed, branch: null, base: null, ask: 'guide', host: 'claude-code', project_id: 'p', at: '' },
    review: review({ source: { kind: 'pr', pr: { url: 'https://github.com/o/other/pull/999', number: 999, platform: 'github' } } }),
  } as Partial<InboxReviewRow>));
  expect(line.lead).toBe('#231');
});

test("a link's row and header speak only for its own PR's landing, not for a merged PR the guide named", () => {
  const handed = { key: 'github.com/o/app#231', url: 'https://github.com/o/app/pull/231', number: 231, title: 'T', platform: 'github' as const, mine: false };
  const started = { kind: 'link', changes: null, pull: handed, branch: null, base: null, ask: 'guide', host: 'claude-code', project_id: 'p', at: '' };
  const landing = (key: string, number: number) => ({ key, thread_id: 't', number, url: `https://github.com/o/app/pull/${number}`, platform: 'github', state: 'merged', title: 'T', head: 'b', at: '', through_review: null });
  const view = (fields: Partial<InboxReviewRow>) => reviewViewOf(row(fields), { messages: [], subject: null }, { projectName: null, onWholeThread: () => {}, onOpenStack: () => {} });

  const other = { started, landed: [landing('github.com/o/app#999', 999)] } as unknown as Partial<InboxReviewRow>;
  expect(reviewRowLine(row(other)).lead).toBe('#231');
  expect(view(other).pullUrl).toBeNull();

  const own = { started, landed: [landing('github.com/o/app#999', 999), landing('github.com/o/app#231', 231)] } as unknown as Partial<InboxReviewRow>;
  expect(reviewRowLine(row(own)).lead).toBe('#231 merged');
  expect(view(own).pullUrl).toBe('https://github.com/o/app/pull/231');

  const plain = { landed: [landing('github.com/o/app#999', 999)] } as unknown as Partial<InboxReviewRow>;
  expect(reviewRowLine(row(plain)).lead).toBe('#999 merged');
  expect(view(plain).pullUrl).toBe('https://github.com/o/app/pull/999');
});


test('a walkthrough says Walkthrough, not a branch, from its start (Writing…) and once its review is in', () => {
  const started = { kind: 'walkthrough', changes: null, branch: null, base: null, ask: 'custom', host: 'claude-code', project_id: 'p', at: '' };
  const curating = row({ reviewed: false, reason: 'curating', review: null, started } as unknown as Partial<InboxReviewRow>);
  expect(reviewRowLine(curating).lead).toBe('Walkthrough');
  expect(reviewContextLine(curating, 'charges')).toBe('charges · Walkthrough');
  expect(reviewViewOf(curating, { messages: [], subject: null }, { projectName: null, onWholeThread: () => {}, onOpenStack: () => {} }).asked).toBe('New review · Walkthrough');
  expect(reviewRowLine(curating).status).toBe('Writing…');
  expect(reviewViewOf(curating, { messages: [], subject: null }, { projectName: null, onWholeThread: () => {}, onOpenStack: () => {} }).curating).toBe('Writing the walkthrough…');
  const curatingReview = row({ reviewed: false, reason: 'curating', review: null, started: { ...started, kind: 'local' } } as unknown as Partial<InboxReviewRow>);
  expect(reviewRowLine(curatingReview).status).toBe('Curating…');
  expect(reviewViewOf(curatingReview, { messages: [], subject: null }, { projectName: null, onWholeThread: () => {}, onOpenStack: () => {} }).curating).toBe('Curating the review…');
  const ready = row({ started, review: review({ walkthrough: true }) } as unknown as Partial<InboxReviewRow>);
  expect(reviewRowLine(ready)).toMatchObject({ lead: 'Walkthrough', status: 'Ready' });
  expect(reviewViewOf(ready, { messages: [], subject: null }, { projectName: null, onWholeThread: () => {}, onOpenStack: () => {} }).curating).toBeNull();
  expect(reviewContextLine(ready, 'charges')).toBe('charges · Walkthrough');
  expect(reviewRowLine(row({ review: review({ walkthrough: true }) })).lead).toBe('Walkthrough');
});

test("the bar's name in Reviews is the row's title: the review's once it landed, none for a PR row or before a review", () => {
  const view = (r: InboxReviewRow) => reviewViewOf(r, { messages: [], subject: 'q', thread_name: 'Webhook delivery' }, { projectName: null, onWholeThread: () => {}, onOpenStack: () => {} });
  const started = { kind: 'local', changes: null, branch: 'retry-jitter', base: 'main', ask: 'guide', host: 'claude-code', project_id: 'p', at: '', name: 'Webhook delivery' };
  for (const r of [row({ started } as unknown as Partial<InboxReviewRow>), row({ started: { ...started, kind: 'walkthrough' }, review: review({ walkthrough: true }) } as unknown as Partial<InboxReviewRow>)]) {
    expect(view(r).name).toBe(reviewRowTitle(r, () => 'PR title'));
    expect(view(r).name).toBe('Retry failed charges');
  }
  expect(view(row({ review: null, reason: 'curating', started } as unknown as Partial<InboxReviewRow>)).name).toBeNull();
  expect(view(row({ stacks: [inboxPullStacks([pull(869)])[0]!] })).name).toBeNull();
});
