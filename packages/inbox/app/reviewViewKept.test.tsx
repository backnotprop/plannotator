/**
 * A thread opened from Reviews keeps its review view while it stays open (app/reviewView.ts; the owner, 2026-11-23:
 * what is open stays open). What regresses: the thread's Reviews row leaving (its PR merged, a read that came back
 * without it) changing the open thread in place: its folded start opened, its title back to the subject, its context
 * line gone; or a row remembered for another thread, or after Code review went off.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxReviewRow, InboxReviewsAnswer, InboxThread } from '@plannotator/core/inbox-types';
import type { PullsState } from '../pulls/usePulls';
import type { ReviewView } from '../pulls/reviewsModel';
import type { Route } from './route';
import { useAppReviewView } from './reviewView';

const hasDom = typeof document !== 'undefined';

const THREAD = 'msg_01JD0000000000000000000000';
const FIRST_REVIEW = 'msg_01JD0000000000000000000002';
const row: InboxReviewRow = {
  id: THREAD,
  reviewed: true,
  move: 'on_you',
  reason: 'review_ready',
  thread_id: THREAD,
  review: {
    thread_id: THREAD,
    project_id: 'prj_1',
    subject: 'Retry the failed charges',
    first_review_id: FIRST_REVIEW,
    latest_review_id: FIRST_REVIEW,
    round: 1,
    title: 'Review: the retry schedule',
    files: 2,
    additions: 10,
    deletions: 2,
    agent: { host: 'claude-code', session: 'ses_1', name: null },
    source: null,
    verdict: null,
    answered: null,
    reviewed_at: '2026-11-03T09:00:00.000Z',
    updated_at: '2026-11-03T09:00:00.000Z',
  } as InboxReviewRow['review'],
  stacks: [],
  pull_keys: [],
  link: null,
  pull_reason: null,
  landed: [],
  updated_at: '2026-11-03T09:00:00.000Z',
};
const thread = {
  thread_id: THREAD,
  project: { id: 'prj_1', key: 'billing', name: 'billing-svc', root: '/work/billing', created_at: '2026-11-01T00:00:00.000Z' },
  subject: 'Retry the failed charges',
  thread_name: null,
  resolved_at: null,
  messages: [{ id: THREAD }, { id: 'msg_01JD0000000000000000000001' }, { id: FIRST_REVIEW }],
} as unknown as InboxThread;

const answer = (rows: InboxReviewRow[]): InboxReviewsAnswer => ({ fetched_at: null, hosts: [], rows, projects: {} }) as InboxReviewsAnswer;
const state = (rows: InboxReviewRow[]): PullsState => ({ model: null, reviews: answer(rows), error: null, loading: false, refresh: () => {}, reload: () => {}, reloadRows: () => {} });
const inReviews = (id: string | null): Route => ({ page: 'inbox', project: null, thread: id, reviews: { project: null, view: 'all' } }) as Route;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

let seen: ReviewView | null = null;
function Probe(props: { route: Route; pulls: PullsState; pullsShown?: boolean; thread?: InboxThread | null }) {
  seen = useAppReviewView({ route: props.route, pulls: props.pulls, pullsShown: props.pullsShown ?? true, thread: props.thread === undefined ? thread : props.thread, projectNames: new Map([['prj_1', 'billing-svc']]), go: () => {} });
  return null;
}
function draw(props: Parameters<typeof Probe>[0]) {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(<Probe {...props} />));
}

test.skipIf(!hasDom)('the row leaves Reviews: the open thread keeps its fold, title and context line', () => {
  draw({ route: inReviews(THREAD), pulls: state([row]) });
  const before = seen!;
  expect(before.firstReviewId).toBe(FIRST_REVIEW);
  expect(before.title).toBe('Review: the retry schedule');
  expect(before.context).toBeTruthy();
  // The next read has no row for it.
  draw({ route: inReviews(THREAD), pulls: state([]) });
  expect(seen).not.toBeNull();
  expect(seen!.firstReviewId).toBe(before.firstReviewId);
  expect(seen!.title).toBe(before.title);
  expect(seen!.context).toEqual(before.context);
});

test.skipIf(!hasDom)('forgotten for another thread, outside Reviews, and with Code review off', () => {
  draw({ route: inReviews(THREAD), pulls: state([row]) });
  expect(seen).not.toBeNull();
  // Another thread opened: its view is its own row's (none here), never this one's.
  const other = { ...thread, thread_id: 'msg_01JD0000000000000000000009' } as InboxThread;
  draw({ route: inReviews(other.thread_id), pulls: state([]), thread: other });
  expect(seen).toBeNull();
  // Back to the first thread with no row: nothing remembered from before.
  draw({ route: inReviews(THREAD), pulls: state([]) });
  expect(seen).toBeNull();
  draw({ route: inReviews(THREAD), pulls: state([row]) });
  draw({ route: inReviews(THREAD), pulls: state([row]), pullsShown: false });
  expect(seen).toBeNull();
  draw({ route: inReviews(THREAD), pulls: state([]) });
  expect(seen).toBeNull();
});
