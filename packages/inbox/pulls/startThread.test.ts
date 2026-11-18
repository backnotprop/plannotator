/**
 * A PR launchpad's Start a thread (`startThread.ts`). What regresses:
 *  - the button offered on a closed or merged PR, on one a thread is already about, or on one in no project;
 *  - the hand-off asking for a guided review (step 1, `/review-curate`), or promising "the updated review" no one asked for;
 *  - a teammate's PR losing "Don't push", or the person's own losing that changes are pushed where the agent can;
 *  - the thread kept with an ask (`pullLaunchAsk`), so the launchpad would say a guided review is on its way.
 */
import { expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull, type InboxPullLink } from '@plannotator/core/inbox-types';
import { reviewBoxPull } from '../compose/reviewBox';
import { pullAsksNothing, pullLaunchAsk } from './model';
import { canStartPullThread, pullThreadRequest } from './startThread';

const REPO = 'northwind/web-app';
const pr = (fields: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/${REPO}#880`,
  platform: 'github',
  host: 'github.com',
  repo: REPO,
  number: 880,
  url: `https://github.com/${REPO}/pull/880`,
  title: 'Fix RTL',
  author: 'tomas',
  mine: false,
  requested: true,
  state: 'open',
  base: 'main',
  head: 'fix/rtl',
  head_repo: REPO,
  additions: 3,
  deletions: 1,
  files: 2,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  updated_at: '2026-11-03T09:00:00.000Z',
  merged_at: null,
  ...fields,
});
const link = { via: 'owner', thread_id: 'thr_1', thread_subject: 'Review #880', project_id: 'prj', agent: null, last: null, guide: null } as InboxPullLink;
const requestFor = (pull: InboxPull) => pullThreadRequest(reviewBoxPull(inboxPullStacks([pull])[0]!, { reviewed: false, thread_id: null, link: null, review: null }, {}, ['prj']));

test('offered only for an open or draft PR with no thread about it, in a project', () => {
  expect(canStartPullThread(pr(), null, ['prj'])).toBe(true);
  expect(canStartPullThread(pr({ state: 'draft' }), null, ['prj'])).toBe(true);
  expect(canStartPullThread(pr({ state: 'merged' }), null, ['prj'])).toBe(false);
  expect(canStartPullThread(pr({ state: 'closed' }), null, ['prj'])).toBe(false);
  expect(canStartPullThread(pr(), link, ['prj'])).toBe(false);
  expect(canStartPullThread(pr(), null, [])).toBe(false);
});

test("the hand-off names the PR and asks for no guided review; a teammate's PR is never pushed to, your own is", () => {
  const theirs = requestFor(pr()).body!;
  expect(theirs.includes('- Link: https://github.com/northwind/web-app/pull/880')).toBe(true);
  expect(/review-curate|guided review|updated review|^1\. /m.test(theirs)).toBe(false);
  expect(theirs.includes("What to do\nWe discuss it in this thread. Bring up what you notice or want to ask without waiting for me. Don't push to the branch, comment on the pull request, approve it or merge it.")).toBe(true);
  const mine = requestFor(pr({ mine: true, author: 'dana' })).body!;
  expect(mine.includes("If I ask for changes, make them and push them to the branch if you can. Don't comment on the pull request, approve it or merge it.")).toBe(true);
  expect(/review-curate|guided review|updated review/.test(mine)).toBe(false);
});

test('the Send keeps the thread as the PR\'s with no ask, whatever the words', () => {
  const request = requestFor(pr());
  expect(pullAsksNothing(request.pulls)).toBe(true);
  expect(pullLaunchAsk(`${request.body}Please send me a guided review.`, request.pulls!.ask_line)).toBe(null);
  // Launch's old hand-off keeps its rule: the guided step 1 as a line of its own is a guided review.
  expect(pullLaunchAsk('Hi\n1. Review it.\n', '1. Review it.')).toBe('guide');
  expect(pullLaunchAsk('Hi', '1. Review it.')).toBe('custom');
});
