/**
 * Start a thread from a PR's page (startThread.ts, threadTo.ts, threadDetails.ts; mock "V1"). What regresses:
 *  - the door offered on a closed or merged PR, on one a thread is already about, or on one in no project;
 *  - the first message asking for a guided review (`/review-curate`, step 1), or putting the PR's details before the
 *    person's words; a teammate's PR losing "Don't push", the person's own losing that changes are pushed;
 *  - the thread's display losing the person's words, or folding a message that is not one of these (New review's
 *    hand-off, words that quote the opening);
 *  - To offering another project's agents, a second recipient's start rows, or starting on anything but New review's
 *    choice (a live agent of the PR's project, else a new session there);
 *  - the PR's row or page opening the launchpad once its thread was started from it, or saying "Curating…" or "New
 *    review · Guided review" for a thread that asked for no review; the row leaving the group its PR was in (it is not
 *    curating), or not moving to With your agents once that thread asks for a guided review;
 *  - the guided review request's words drifting from the hand-off's own step.
 */
import { expect, test } from 'bun:test';
import { inboxPullStacks, inboxPullUrlsIn, inboxReviewRows, type InboxPull, type InboxPullLink } from '@plannotator/core/inbox-types';
import { pullHandoffMessage } from './model';
import { reviewRowLaunchpad, reviewRowLine, reviewViewOf } from './reviewsModel';
import { canStartPullThread, isPullThread, pullThreadMessage, splitPullThreadDetails } from './startThread';
import { PULL_DETAILS_START } from './threadDetails';
import { pullThreadDefault, pullThreadOptions } from './threadTo';
import { pullThreadGuideWords } from './usePullThreadGuide';

const REPO = 'northwind/web-app';
const pr = (fields: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/${REPO}#880`,
  platform: 'github',
  host: 'github.com',
  repo: REPO,
  number: 880,
  url: `https://github.com/${REPO}/pull/880`,
  title: 'Fix RTL in the date picker',
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
const stackOf = (pull: InboxPull) => inboxPullStacks([pull])[0]!;
const link = (fields: Partial<InboxPullLink> = {}): InboxPullLink => ({ via: 'owner', thread_id: 'thr_1', thread_subject: 'Review #880', project_id: 'prj', agent: { host: 'claude-code', session: 'ses_1', name: null }, last: null, guide: null, ...fields });
const ASK = 'Tell me about what this PR is.';

test('offered only for an open or draft PR with no thread about it, in a project', () => {
  expect(canStartPullThread(pr(), null, ['prj'])).toBe(true);
  expect(canStartPullThread(pr({ state: 'draft' }), null, ['prj'])).toBe(true);
  expect(canStartPullThread(pr({ state: 'merged' }), null, ['prj'])).toBe(false);
  expect(canStartPullThread(pr({ state: 'closed' }), null, ['prj'])).toBe(false);
  expect(canStartPullThread(pr(), link(), ['prj'])).toBe(false);
  expect(canStartPullThread(pr(), null, [])).toBe(false);
});

test("the first message: the person's words first, then the PR's details, with no guided review asked; a teammate's PR is never pushed to, your own is", () => {
  const theirs = pullThreadMessage(stackOf(pr()), `  ${ASK}  `);
  expect(theirs.startsWith(`${ASK}\n\n${PULL_DETAILS_START}pull request.`)).toBe(true);
  expect(theirs.includes('- Link: https://github.com/northwind/web-app/pull/880')).toBe(true);
  expect(/review-curate|guided review|updated review|^1\. /m.test(theirs)).toBe(false);
  expect(theirs.endsWith("What to do\nWe discuss it in this thread. Bring up what you notice or want to ask without waiting for me. Don't push to the branch, comment on the pull request, approve it or merge it.")).toBe(true);
  const mine = pullThreadMessage(stackOf(pr({ mine: true, author: 'dana' })), ASK);
  expect(mine.endsWith("If I ask for changes, make them and push them to the branch if you can. Don't comment on the pull request, approve it or merge it.")).toBe(true);
  // The opening the display folds on is the hand-off's own (a change there must change the fold too).
  expect(pullHandoffMessage(stackOf(pr())).startsWith(PULL_DETAILS_START)).toBe(true);
});

test("the thread shows the person's words and folds the details; nothing else is folded", () => {
  const stack = stackOf(pr());
  const body = pullThreadMessage(stack, ASK);
  expect(splitPullThreadDetails(body)).toEqual({ words: ASK, details: pullHandoffMessage(stack, { kind: 'thread' }) });
  // New review's hand-off (nothing before it), its custom curation, and a plain message are shown whole.
  expect(splitPullThreadDetails(pullHandoffMessage(stack))).toBe(null);
  expect(splitPullThreadDetails(`${ASK}\n\n${pullHandoffMessage(stack)}`)).toBe(null);
  expect(splitPullThreadDetails(ASK)).toBe(null);
  // Words that quote the opening stay words: the last block is the one folded.
  const quoting = pullThreadMessage(stack, `Why does it say\n\n${PULL_DETAILS_START}pull request?`);
  expect(splitPullThreadDetails(quoting)!.words).toBe(`Why does it say\n\n${PULL_DETAILS_START}pull request?`);
});

const model = (sessions: Record<string, string[]>) => ({
  projects: [
    { project: { id: 'prj', name: 'web-app', root: '/w/web-app' }, sessions: (sessions.prj ?? []).map((s) => ({ session: s, host: 'claude-code', started_at: '', last_seen_at: '', busy: false, idle_since: null, last_thread: null })) },
    { project: { id: 'other', name: 'billing', root: '/w/billing' }, sessions: (sessions.other ?? []).map((s) => ({ session: s, host: 'codex', started_at: '', last_seen_at: '', busy: false, idle_since: null, last_thread: null })) },
  ],
  launch: {
    agents: [
      { agent: 'claude-code' as const, name: 'Claude Code', choices: { last: { model: 'opus', effort: 'high' } } },
      { agent: 'codex' as const, name: 'Codex' },
    ],
    projects: [
      { id: 'prj', name: 'web-app', root: '/w/web-app', exists: true },
      { id: 'other', name: 'billing', root: '/w/billing', exists: true },
    ],
  },
});

test("To: the PR's project's live agents, then a new session of each agent there; it starts on a live agent, else a new session", () => {
  const live = model({ prj: ['ses_web'], other: ['ses_billing'] });
  const options = pullThreadOptions(live as never, ['prj']);
  expect(options.map((o) => [o.row.session, o.row.label, o.project])).toEqual([
    ['ses_web', 'Claude Code', 'prj'],
    ['new:claude-code:prj', 'New Claude Code session', 'prj'],
    ['new:codex:prj', 'New Codex session', 'prj'],
  ]);
  expect(options[1]!.to).toEqual({ launch: { agent: 'claude-code', project_id: 'prj', model: 'opus', effort: 'high' } });
  expect(options[0]!.to).toEqual({ host: 'claude-code', session: 'ses_web' });
  expect(pullThreadDefault(live as never, ['prj'], options)).toBe('ses_web');
  const none = model({ other: ['ses_billing'] });
  expect(pullThreadDefault(none as never, ['prj'], pullThreadOptions(none as never, ['prj']))).toBe('new:claude-code:prj');
  expect(pullThreadOptions(null, ['prj'])).toEqual([]);
});

test("once started from its page: the PR's row opens its thread and stays in its group (On you · review requested), the thread draws the PR's line with no New review label", () => {
  const pull = pr();
  const stacks = inboxPullStacks([pull]);
  const rowsWith = (l: InboxPullLink) => inboxReviewRows({ threads: [], stacks, links: { [pull.key]: l }, pulls: [pull] });
  const [free] = inboxReviewRows({ threads: [], stacks, links: {}, pulls: [pull] });
  const [threadRow] = rowsWith(link({ ask: 'thread' }));
  expect(isPullThread(threadRow!.link)).toBe(true);
  expect(reviewRowLaunchpad(threadRow!)).toBe(null);
  // Not curating: the PR stays where its own state put it before the thread (a review asked of the person).
  expect([threadRow!.move, threadRow!.reason]).toEqual([free!.move, free!.reason]);
  expect([threadRow!.move, threadRow!.reason]).toEqual(['on_you', 'requested']);
  expect(reviewRowLine(threadRow!).status).not.toBe('Curating…');
  const diffs: string[] = [];
  const view = reviewViewOf(threadRow!, { messages: [{ id: 'm1' }], subject: null }, { projectName: 'web-app', onWholeThread: () => {}, onOpenStack: () => {}, onOpenDiff: (stack, layer) => diffs.push(`${stack} ${layer}`) });
  expect(view.curating).toBe(null);
  expect(view.asked).toBe(null);
  expect(view.pullLine?.pull.key).toBe(pull.key);
  view.pullLine!.onDiff();
  expect(diffs).toEqual([`${stacks[0]!.id} ${pull.key}`]);
  // A review thread handed over another way keeps the launchpad and its words.
  const [guided] = rowsWith(link({ ask: 'guide' }));
  expect(reviewRowLaunchpad(guided!)).toBe(stacks[0]!.id);
  expect(reviewRowLine(guided!).status).toBe('Curating…');
  expect(reviewViewOf(guided!, { messages: [], subject: null }, { projectName: null, onWholeThread: () => {}, onOpenStack: () => {}, onOpenDiff: () => {} }).pullLine).toBe(null);
});

test("a guided review asked in the PR's thread: the row moves to With your agents (curating), and the thread is still the PR's page", () => {
  const pull = pr();
  const stacks = inboxPullStacks([pull]);
  const [row] = inboxReviewRows({ threads: [], stacks, links: { [pull.key]: link({ ask: 'guide', page: true }) }, pulls: [pull] });
  expect([row!.move, row!.reason]).toEqual(['agents', 'curating']);
  expect(reviewRowLine(row!).status).toBe('Curating…');
  expect(isPullThread(row!.link)).toBe(true);
  expect(reviewRowLaunchpad(row!)).toBe(null);
  const view = reviewViewOf(row!, { messages: [{ id: 'm1' }], subject: null }, { projectName: 'web-app', onWholeThread: () => {}, onOpenStack: () => {}, onOpenDiff: () => {} });
  expect(view.curating).toBe('Curating the review…');
  expect(view.asked).toBe(null);
  expect(!!view.pullLine).toBe(true);
});

test("the server's rule finds the PR in a started thread's first message (only in its details), so a thread never tied still links it", () => {
  const stack = stackOf(pr());
  const first = pullThreadMessage(stack, `Compare with https://github.com/${REPO}/pull/12 first.`);
  const split = splitPullThreadDetails(first)!;
  expect(inboxPullUrlsIn(split.details)).toEqual([pr().url]);
});

test("the guided review request's words: the hand-off's own step, /review-curate on the PR's diff against its base", () => {
  expect(pullThreadGuideWords(stackOf(pr()))).toBe('Send me a guided review of its diff against main, using /review-curate (its instructions are at the end of this message). Include what I might ask tomas.');
  expect(pullThreadGuideWords(stackOf(pr({ mine: true, author: 'dana' })))).toBe('Send me a guided review of its diff against main, using /review-curate (its instructions are at the end of this message).');
});
