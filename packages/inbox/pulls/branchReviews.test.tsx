/**
 * Branch reviews in the window. What regresses:
 *  - anything of it drawn while Branch reviews is off (a row mark);
 *  - a reported branch's row not saying where the branch is (this computer, another, a cloud agent's), or showing a risk
 *    mark with no judgment;
 *  - the thread's "Ask for a guided review" going anywhere but a reply in the same thread, or offered for code that
 *    can't be opened;
 *  - a cloud agent's remote drawn as a link, or with anything but its host and repository;
 *  - Rank offered for a branch that can't be ranked, or going anywhere but the rank route with its thread.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxBranchReportRow, InboxPullRiskAnswer, InboxPullsAnswer, InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { inboxFarBranchReviewRow } from '@plannotator/core/inbox-types';
import type { ReviewView } from './reviewsModel';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { ReviewViewNote } = (hasDom ? await import('./ReviewViewNote') : {}) as typeof import('./ReviewViewNote');
const { branchNoteOf } = (hasDom ? await import('./branchReviews') : {}) as typeof import('./branchReviews');

const LIST = { fetched_at: '2026-11-16T10:00:00.000Z', hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }], pulls: [], links: {}, projects: {}, cards: {} } as unknown as InboxPullsAnswer;
const RISK: InboxPullRiskAnswer = { rules: 'Anything in billing.', provider: 'pi-sdk', model: null, agents: [{ id: 'pi-sdk', label: 'Pi' }], pending: 0, last_failure: null, failed: {}, judgments: {} };

function report(fields: Partial<InboxBranchReportRow> = {}): InboxBranchReportRow {
  return { thread_id: 'msg_01JD0000000000000000000001', project_id: 'prj_billing', branch: 'retry-jitter', base: 'main', head: '3a9f2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f', place: 'here', remote_url: null, summary: null, at: '2026-11-16T10:00:00.000Z', reports: 1, agent: null, reachable: true, risk: null, risk_failed: null, ...fields };
}

const ROWS = [
  inboxFarBranchReviewRow(report()),
  inboxFarBranchReviewRow(report({ thread_id: 'msg_01JD0000000000000000000002', branch: 'cache-keys', place: 'cloud', reachable: false, risk: { level: 'high', why: 'It changes charges.' } })),
  inboxFarBranchReviewRow(report({ thread_id: 'msg_01JD0000000000000000000003', branch: 'web-fonts', machine: { id: 'ibx_01JD000000000000000000000B', name: 'Mac mini' } })),
];

let root: Root | null = null;
const restores: (() => void)[] = [];
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const restore of restores.splice(0)) restore();
});
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const mount = async (node: React.ReactNode) => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle();
};
/** Every fetch the window makes, answered from `routes` (else 404). */
const fetches = (routes: Record<string, unknown>) => {
  const seen: string[] = [];
  const made = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const hit = Object.entries(routes).find(([path]) => url.includes(path));
    return hit ? Response.json(hit[1]) : Response.json({ error: 'no' }, { status: 404 });
  }) as typeof fetch);
  restores.push(() => made.mockRestore());
  return seen;
};
const page = (answer: InboxReviewsAnswer, threadId?: string) => (
  <SidebarProvider>
    <PullsPage
      state={{ model: LIST, reviews: answer, error: null, loading: false, refresh: () => {}, reload: () => {}, reloadRows: () => {} }}
      stackId={null}
      threadId={threadId}
      project="prj_billing"
      projects={[{ id: 'prj_billing', name: 'billing', root: '/tmp/billing' } as never]}
      projectNames={new Map([['prj_billing', 'billing']])}
      phone={false}
      onOpenStack={() => {}}
      filter="all"
      onScope={() => {}}
      onReview={() => {}}
      onOpenThread={() => {}}
      onNew={() => {}}
      onNewReview={() => {}}
    />
  </SidebarProvider>
);
const rowLine = (thread: string | null) => document.querySelector(`[data-reviews-row="${thread}"] .ib-pr-l3`)?.textContent ?? null;

test.skipIf(!hasDom)('off: no branch rows from the server, and no branch read', async () => {
  const restore = spyOn(inboxApi, 'pullRisk').mockImplementation(async () => RISK);
  restores.push(() => restore.mockRestore());
  const seen = fetches({});
  await mount(page({ fetched_at: null, hosts: [], rows: [], projects: {} }));
  expect(seen.some((url) => url.includes('/reviews/branches'))).toBe(false);
});

test.skipIf(!hasDom)('on: each reported branch says where it is and waits on the person; a risk mark only with a judgment', async () => {
  const restore = spyOn(inboxApi, 'pullRisk').mockImplementation(async () => RISK);
  restores.push(() => restore.mockRestore());
  fetches({});
  const answer: InboxReviewsAnswer = { fetched_at: null, hosts: [], rows: ROWS, projects: {}, branch_reviews: true };
  await mount(page(answer));
  // Closed, a row is one line: what the second line says is not drawn.
  expect(ROWS.map((row) => rowLine(row.thread_id))).toEqual([null, null, null]);
  // Open, its second line says where the branch is, its project and why it waits.
  const opened = async (row: (typeof ROWS)[number]) => {
    await act(async () => root!.render(page(answer, row.thread_id!)));
    await settle();
    return rowLine(row.thread_id);
  };
  expect(await opened(ROWS[0]!)).toBe('retry-jitter · billing · Ready for review');
  expect(await opened(ROWS[1]!)).toBe('cache-keys from a cloud agent · billing · Ready for review');
  expect(await opened(ROWS[2]!)).toBe('web-fonts on Mac mini · billing · Ready for review');
  expect(document.querySelector(`[data-reviews-row="${ROWS[0]!.thread_id}"] [data-pull-risk]`)).toBeNull();
  expect(document.querySelector(`[data-reviews-row="${ROWS[1]!.thread_id}"] [data-pull-risk]`)?.getAttribute('data-pull-risk')).toBe('high');
});

const view = (branch: ReviewView['branch']): ReviewView => ({ context: 'billing · Local branch: retry-jitter, against main', kind: 'local', title: null, name: null, firstReviewId: null, latestReviewId: null, curating: null, asked: null, fromThread: null, onWholeThread: () => {}, onOpenPull: null, pullUrl: null, branch });

test.skipIf(!hasDom)("the thread's ask is a reply in the same thread, and is not offered for code this computer can't open", async () => {
  fetches({});
  const replies: { id: string; words: string }[] = [];
  const restore = spyOn(inboxApi, 'reply').mockImplementation((async (id: string, input: { words: string }) => {
    replies.push({ id, words: input.words });
    return { reply: null, questions: [], replayed: false };
  }) as never);
  restores.push(() => restore.mockRestore());
  await mount(<ReviewViewNote view={view({ report: report(), reach: null, canAsk: true, canRank: false, projectName: 'billing', replyTo: 'msg_01JD0000000000000000000009' })} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-review-branch-ask]')!.click());
  await settle();
  expect(replies).toHaveLength(1);
  expect(replies[0]!.id).toBe('msg_01JD0000000000000000000009');
  expect(replies[0]!.words).toContain('the whole branch in billing (retry-jitter, against main), using /review-curate');
  expect(document.querySelector('[data-review-branch-asked]')).not.toBeNull();
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  // The server keeps only the rebuilt URL; the words name host and repository, as text.
  const cloud = report({ place: 'cloud', reachable: false, remote_url: 'https://github.com/acme/app.git', remote_known: false });
  await mount(<ReviewViewNote view={view({ ...branchNoteOf(cloud), projectName: 'billing', replyTo: 'msg_01JD0000000000000000000009' })} />);
  expect(document.querySelector('[data-review-branch-reach]')?.textContent).toBe(
    "The agent says it pushed it to github.com/acme/app (not the origin of any project here). If that is your repository, fetch retry-jitter into the project's checkout here.",
  );
  expect(document.querySelector('[data-review-branch] a')).toBeNull();
  expect(document.querySelector('[data-review-branch-ask]')).toBeNull();
  expect(document.querySelector('[data-review-branch-rank]')).toBeNull();
});

test.skipIf(!hasDom)('Rank is offered only for a branch that can be ranked, and asks the rank route for its thread', async () => {
  const sent: { url: string; body: unknown }[] = [];
  const made = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ started: true });
  }) as typeof fetch);
  restores.push(() => made.mockRestore());
  // A linked machine's row is ranked there, never from here.
  const far = report({ rankable: true, machine: { id: 'ibx_01JD000000000000000000000B', name: 'Mac mini' } });
  await mount(<ReviewViewNote view={view({ ...branchNoteOf(far), projectName: 'billing', replyTo: null })} />);
  expect(document.querySelector('[data-review-branch-rank]')).toBeNull();
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  await mount(<ReviewViewNote view={view({ ...branchNoteOf(report({ rankable: true })), projectName: 'billing', replyTo: null })} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-review-branch-rank-button]')!.click());
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toContain('/reviews/branches/rank');
  expect(sent[0]!.body).toMatchObject({ thread_id: 'msg_01JD0000000000000000000001' });
  expect(document.querySelector('[data-review-branch-ranking]')).not.toBeNull();
  expect(document.querySelector('[data-review-branch-rank]')).toBeNull();
});
