/**
 * Reviews' "On this computer" in the window (OnThisComputer.tsx, LocalDiffPane.tsx). What regresses:
 *  - the group missing for the whole list (it needs no project filter and no switch), drawn open at first, or its
 *    count wrong; a project filter keeping other projects' rows;
 *  - a row not saying its work (the branch, "Uncommitted on main"), its project or its age;
 *  - a click doing anything but opening that work's diff beside the list: a request that sends or starts anything, or
 *    a diff of other work than the row's;
 *  - the diff's Review with an agent starting anything itself instead of opening New review on that same work;
 *  - Back losing the open group;
 *  - Branch reviews' old "Branches nobody reported" drawn beside it (the same branches twice).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxLocalWorkAnswer, InboxPullRiskAnswer, InboxPullsAnswer, InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import type { ReviewBoxRequest } from '../compose/reviewBox';
import type { LocalOpen } from './localRoute';

const hasDom = typeof document !== 'undefined';
/** What the reader was last given: the diff it draws. */
const drawn: { patch: string; title: string }[] = [];
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: { snapshot: { review: { rawPatch: string }; guide: { title: string } }; comments?: unknown }) => {
      drawn.push({ patch: props.snapshot.review.rawPatch, title: props.snapshot.guide.title });
      return null;
    },
  }));
}
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');

const LIST = { fetched_at: '2026-11-22T10:00:00.000Z', hosts: [{ cli: 'gh', host: 'github.com', login: 'ada-novak' }], pulls: [], links: {}, projects: {}, cards: {} } as unknown as InboxPullsAnswer;
const RISK: InboxPullRiskAnswer = { rules: null, provider: null, model: null, agents: [], pending: 0, last_failure: null, failed: {}, judgments: {} } as unknown as InboxPullRiskAnswer;
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const LOCAL: InboxLocalWorkAnswer = {
  unread: 0,
  items: [
    { project_id: 'prj_plannotator', kind: 'uncommitted', branch: 'main', base: null, at: ago(3 * 60_000) },
    { project_id: 'prj_plannotator', kind: 'branch', branch: 'fix/guide-global-comment-keep-words', base: 'main', at: ago(12 * 60_000) },
    { project_id: 'prj_spaces', kind: 'branch', branch: 'feat/spaces-share-link', base: 'main', at: ago(2 * 3_600_000) },
  ],
};
const PATCH = 'diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-export const retries = 2;\n+export const retries = 3;\n';

let root: Root | null = null;
const restores: (() => void)[] = [];
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '#reviews');
  drawn.length = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => NOW);
  restores.push(() => clock.mockRestore());
  const risk = spyOn(inboxApi, 'pullRisk').mockImplementation(async () => RISK);
  restores.push(() => risk.mockRestore());
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const restore of restores.splice(0)) restore();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};
/** Every request the window makes, answered from `routes` (else 404), with its method. */
const fetches = (routes: Record<string, unknown>) => {
  const seen: { url: string; method: string }[] = [];
  const made = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? 'GET' });
    const hit = Object.entries(routes).find(([path]) => url.includes(path));
    return hit ? Response.json(hit[1]) : Response.json({ error: 'no' }, { status: 404 });
  }) as typeof fetch);
  restores.push(() => made.mockRestore());
  return seen;
};
const REVIEWS: InboxReviewsAnswer = { fetched_at: null, hosts: [], rows: [], projects: {} };
const page = (options: { project?: string | null; local?: LocalOpen | null; reviews?: InboxReviewsAnswer; onReviewLocal?: (review: ReviewBoxRequest) => void } = {}) => (
  <SidebarProvider>
    <PullsPage
      state={{ model: LIST, reviews: options.reviews ?? REVIEWS, error: null, loading: false, refresh: () => {}, reload: () => {}, reloadRows: () => {} }}
      stackId={null}
      local={options.local ?? null}
      project={options.project ?? null}
      projects={[{ id: 'prj_plannotator', name: 'plannotator', root: '/tmp/plannotator' } as never, { id: 'prj_spaces', name: 'spaces-site', root: '/tmp/spaces-site' } as never]}
      projectNames={new Map([
        ['prj_plannotator', 'plannotator'],
        ['prj_spaces', 'spaces-site'],
      ])}
      phone={false}
      onOpenStack={() => {}}
      filter="all"
      onScope={() => {}}
      onReview={() => {}}
      onOpenThread={() => {}}
      onNew={() => {}}
      onNewReview={() => {}}
      onReviewLocal={options.onReviewLocal ? (review) => options.onReviewLocal!(review) : undefined}
    />
  </SidebarProvider>
);
const mount = async (node: React.ReactNode) => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle();
};
const render = async (node: React.ReactNode) => {
  await act(async () => root!.render(node));
  await settle();
};
const group = () => document.querySelector<HTMLElement>('[data-reviews-local]');
const toggle = () => document.querySelector<HTMLButtonElement>('[data-reviews-local-toggle]')!;
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-local-row]')];

test.skipIf(!hasDom)('the group is at the foot of the whole list, folded, with its count; open, each row says its work, project and age', async () => {
  const seen = fetches({ '/reviews/local': LOCAL });
  await mount(page());
  expect(seen.filter((r) => r.url.includes('/reviews/local'))).toHaveLength(1);
  expect(group()).not.toBeNull();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(toggle().textContent).toBe('On this computer 3');
  expect(rows()).toHaveLength(0);
  await act(async () => toggle().click());
  expect(rows().map((row) => [row.querySelector('.ib-local-name')?.textContent, row.querySelector('[data-local-project]')?.textContent, row.querySelector('.ib-local-age')?.textContent])).toEqual([
    ['Uncommitted on main', 'plannotator', '3m'],
    ['fix/guide-global-comment-keep-words', 'plannotator', '12m'],
    ['feat/spaces-share-link', 'spaces-site', '2h'],
  ]);
  expect(rows().map((row) => row.getAttribute('data-local-kind'))).toEqual(['uncommitted', 'branch', 'branch']);
  // Nothing but the list was asked for: no diff until a click.
  expect(seen.some((r) => r.url.includes('/reviews/local/diff'))).toBe(false);
});

test.skipIf(!hasDom)("a project filter keeps that project's rows only, and the old \"Branches nobody reported\" never shows beside it", async () => {
  const seen = fetches({ '/reviews/local': LOCAL });
  await mount(page({ project: 'prj_spaces', reviews: { ...REVIEWS, branch_reviews: true, projects: { 'github.com/charlie-dunn/spaces-site': ['prj_spaces'] } } }));
  await act(async () => toggle().click());
  expect(toggle().textContent).toBe('On this computer 1');
  expect(rows().map((row) => row.getAttribute('data-local-row'))).toEqual(['prj_spaces:feat/spaces-share-link']);
  expect(document.querySelector('[data-reviews-unreported]')).toBeNull();
  expect(seen.some((r) => r.url.includes('/reviews/branches'))).toBe(false);
  expect(document.querySelectorAll('[aria-label="On this computer"]')).toHaveLength(1);
});

test.skipIf(!hasDom)("a branch row opens its diff beside the list: that branch's whole diff, read only, nothing sent; Back keeps the group open", async () => {
  const seen = fetches({ '/reviews/local/diff': { serverSession: 's', project_id: 'prj_plannotator', kind: 'branch', branch: 'fix/guide-global-comment-keep-words', base: 'main', patch: PATCH }, '/reviews/local': LOCAL });
  await mount(page());
  await act(async () => toggle().click());
  await act(async () => rows()[1]!.click());
  expect(readRoute().local).toEqual({ project: 'prj_plannotator', branch: 'fix/guide-global-comment-keep-words' });
  expect(window.location.hash).toBe('#reviews&local=prj_plannotator&branch=fix%2Fguide-global-comment-keep-words');
  // App passes the address's row back in.
  await render(page({ local: readRoute().local }));
  const pane = document.querySelector('[data-local-diff]');
  expect(pane?.getAttribute('data-local-diff')).toBe('branch');
  expect(document.querySelector('[data-local-title]')?.textContent).toBe('fix/guide-global-comment-keep-words');
  expect(document.querySelector('[data-local-facts]')?.textContent).toContain('against main');
  expect(seen.filter((r) => r.url.includes('/reviews/local/diff'))).toEqual([{ url: '/api/inbox/reviews/local/diff?project=prj_plannotator&branch=fix%2Fguide-global-comment-keep-words', method: 'GET' }]);
  expect(drawn.at(-1)).toEqual({ patch: PATCH, title: 'fix/guide-global-comment-keep-words' });
  // The open row is the list's selection, and nothing went anywhere but reads.
  expect(rows()[1]!.getAttribute('aria-current')).toBe('true');
  expect(seen.every((r) => r.method === 'GET')).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-local-close]')!.click());
  expect(readRoute().local).toBeNull();
  await render(page({ local: readRoute().local }));
  expect(document.querySelector('[data-local-diff]')).toBeNull();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(rows()).toHaveLength(3);
});

test.skipIf(!hasDom)("the Uncommitted row opens the folder's changes; Review with an agent only opens New review on that same work", async () => {
  const seen = fetches({ '/reviews/local/diff': { serverSession: 's', project_id: 'prj_plannotator', kind: 'uncommitted', branch: 'main', base: 'HEAD', patch: PATCH }, '/reviews/local': LOCAL });
  const asked: ReviewBoxRequest[] = [];
  await mount(page({ onReviewLocal: (review) => asked.push(review) }));
  await act(async () => toggle().click());
  await act(async () => rows()[0]!.click());
  expect(readRoute().local).toEqual({ project: 'prj_plannotator', branch: null });
  await render(page({ local: readRoute().local, onReviewLocal: (review) => asked.push(review) }));
  expect(document.querySelector('[data-local-title]')?.textContent).toBe('Uncommitted on main');
  expect(seen.filter((r) => r.url.includes('/reviews/local/diff')).map((r) => r.url)).toEqual(['/api/inbox/reviews/local/diff?project=prj_plannotator']);
  const before = seen.length;
  await act(async () => document.querySelector<HTMLButtonElement>('[data-local-review]')!.click());
  expect(asked).toEqual([{ project: 'prj_plannotator' }]);
  expect(seen.length).toBe(before);
  // A branch's diff asks for New review on that branch.
  await render(page({ local: { project: 'prj_spaces', branch: 'feat/spaces-share-link' }, onReviewLocal: (review) => asked.push(review) }));
  await act(async () => document.querySelector<HTMLButtonElement>('[data-local-review]')!.click());
  expect(asked.at(-1)).toEqual({ branch: { name: 'feat/spaces-share-link', projectId: 'prj_spaces' } });
});

test.skipIf(!hasDom)('a read that fails draws no group, never "nothing" made up', async () => {
  fetches({});
  await mount(page());
  expect(group()).toBeNull();
});
