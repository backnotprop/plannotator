/**
 * Reviews' "On this computer" in the window (OnThisComputer.tsx, LocalDiffPane.tsx). What regresses:
 *  - the group missing for the whole list (it needs no project filter and no switch), drawn open at first, or its
 *    count wrong; a project filter keeping other projects' rows;
 *  - a row not saying its work (the branch, "Uncommitted on main"), its project or its age;
 *  - a click doing anything but opening that work's diff beside the list: a request that sends or starts anything, or
 *    a diff of other work than the row's;
 *  - the diff's Review with an agent starting anything itself instead of opening New review on that same work;
 *  - Back losing the open group;
 *  - Branch reviews' old "Branches nobody reported" drawn beside it (the same branches twice);
 *  - what that old list said lost: a branch's commits not on main (for a screen reader on the row, and in its diff's
 *    facts), branches past the first few with no way to see them (the Agents view's "N more"), and "nothing here"
 *    for a list filtered to one project (its words), or a "nothing" made up for a project that was not read;
 *  - git that could not be read not said ("The branches could not be read."), or a filtered list asking for every
 *    project's rows (another project's would crowd its own out).
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
    { project_id: 'prj_plannotator', kind: 'branch', branch: 'fix/guide-global-comment-keep-words', base: 'main', at: ago(12 * 60_000), ahead: 3 },
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
/** Waits, a bounded while, for what a lazy part (the reader) draws once its code is loaded: a busy machine loads it later. */
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
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
const group = () => document.querySelector<HTMLElement>('[data-pulls-group="local"]');
const toggle = () => document.querySelector<HTMLButtonElement>('[data-reviews-fold="local"]')!;
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
  const nameOf = (row: HTMLElement) => row.querySelector('.ib-rvr-t .ib-sr')?.textContent ?? row.querySelector('.ib-rvr-t')?.textContent;
  expect(rows().map((row) => [nameOf(row), row.querySelector('[data-local-project]')?.textContent, row.querySelector('.ib-rvr-age [aria-hidden]')?.textContent])).toEqual([
    ['Uncommitted on main', 'plannotator', '3m'],
    ['fix/guide-global-comment-keep-words', 'plannotator', '12m'],
    ['feat/spaces-share-link', 'spaces-site', '2h'],
  ]);
  expect(rows().map((row) => row.getAttribute('data-local-kind'))).toEqual(['uncommitted', 'branch', 'branch']);
  // A branch's commits not on main, in the old list's words: heard on its row (drawn where it fits, inbox.css), and
  // nothing for a row the answer gave no count (an older Inbox).
  const said = (row: HTMLElement) => [...row.querySelectorAll('.ib-sr')].map((el) => el.textContent).join('');
  expect(said(rows()[1]!)).toContain('3 commits not on main');
  expect(rows()[1]!.querySelector('[data-local-ahead]')?.textContent).toBe('3 commits not on main');
  expect(rows()[2]!.querySelector('[data-local-ahead]')).toBeNull();
  expect(said(rows()[2]!)).not.toContain('not on');
  // Nothing but the list was asked for: no diff until a click.
  expect(seen.some((r) => r.url.includes('/reviews/local/diff'))).toBe(false);
  // Its fold is kept with the list's others, and comes back open.
  expect(JSON.parse(window.localStorage.getItem('plannotator-inbox-reviews-folds')!)).toEqual({ waiting: false, not_reviewed: false, local: true });
  await act(async () => root!.unmount());
  root = null;
  await mount(page());
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(rows()).toHaveLength(3);
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
  const seen = fetches({ '/reviews/local/diff': { serverSession: 's', project_id: 'prj_plannotator', kind: 'branch', branch: 'fix/guide-global-comment-keep-words', base: 'main', patch: PATCH, ahead: 1 }, '/reviews/local': LOCAL });
  await mount(page());
  await act(async () => toggle().click());
  await act(async () => rows()[1]!.click());
  expect(readRoute().local).toEqual({ project: 'prj_plannotator', branch: 'fix/guide-global-comment-keep-words' });
  expect(window.location.hash).toBe('#reviews&local=prj_plannotator&branch=fix%2Fguide-global-comment-keep-words');
  // App passes the address's row back in.
  await render(page({ local: readRoute().local }));
  await until(() => drawn.length > 0);
  const pane = document.querySelector('[data-local-diff]');
  expect(pane?.getAttribute('data-local-diff')).toBe('branch');
  expect(document.querySelector('[data-local-title]')?.textContent).toBe('fix/guide-global-comment-keep-words');
  // Its facts: its commits not on main (the old list's words) in place of "against main".
  expect(document.querySelector('[data-local-facts]')?.textContent).toContain('1 commit not on main');
  expect(document.querySelector('[data-local-facts]')?.textContent).not.toContain('against main');
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

test.skipIf(!hasDom)('an answer without rows (an older Inbox) draws no group, and the list stays', async () => {
  fetches({ '/reviews/local': { serverSession: 's' } });
  await mount(page());
  expect(group()).toBeNull();
  // The list's own view is drawn: the group's answer took nothing down.
  expect(document.querySelector('[data-pulls-empty="nothing"]')).not.toBeNull();
});

test.skipIf(!hasDom)('past five rows, the Agents view\'s "N more" shows the rest, focus on the first it shows; an open row past the fold shows', async () => {
  const many: InboxLocalWorkAnswer = {
    unread: 0,
    items: Array.from({ length: 8 }, (_, i) => ({ project_id: 'prj_plannotator', kind: 'branch' as const, branch: `bob/spike-${i}`, base: 'main', at: ago((i + 1) * 60_000), ahead: 1 })),
  };
  fetches({ '/reviews/local': many });
  await mount(page());
  await act(async () => toggle().click());
  expect(toggle().textContent).toBe('On this computer 8');
  expect(rows().map((row) => row.getAttribute('data-local-row'))).toEqual(Array.from({ length: 5 }, (_, i) => `prj_plannotator:bob/spike-${i}`));
  const more = () => document.querySelector<HTMLButtonElement>('[data-local-more]');
  expect(more()?.textContent).toBe('3 more');
  expect(more()?.classList.contains('ib-agmore')).toBe(true);
  await act(async () => more()!.click());
  expect(rows()).toHaveLength(8);
  expect(more()).toBeNull();
  expect(document.activeElement?.getAttribute('data-local-row')).toBe('prj_plannotator:bob/spike-5');
  // Drawn again folded, the row open beside the list shows though it is past the fold.
  await act(async () => root!.unmount());
  root = null;
  await mount(page({ local: { project: 'prj_plannotator', branch: 'bob/spike-7' } }));
  expect(rows().map((row) => row.getAttribute('data-local-row'))).toEqual([...Array.from({ length: 5 }, (_, i) => `prj_plannotator:bob/spike-${i}`), 'prj_plannotator:bob/spike-7']);
  expect(more()?.textContent).toBe('2 more');
});

test.skipIf(!hasDom)("one project with nothing here says so in the old list's words; the whole list, or a project not read, draws no group", async () => {
  const answer: InboxLocalWorkAnswer = { unread: 0, items: [], quiet: ['prj_spaces'], not_git: ['prj_plannotator'] };
  fetches({ '/reviews/local': answer });
  const reviews = { ...REVIEWS, projects: { 'github.com/charlie-dunn/spaces-site': ['prj_spaces'], 'github.com/charlie-dunn/plannotator': ['prj_plannotator'] } };
  await mount(page({ project: 'prj_spaces', reviews }));
  expect(toggle().textContent?.trim()).toBe('On this computer');
  await act(async () => toggle().click());
  expect(document.querySelector('[data-local-none]')?.textContent).toBe('No other branch had a commit in the last 14 days.');
  await render(page({ project: 'prj_plannotator', reviews }));
  expect(document.querySelector('[data-local-none]')?.textContent).toBe("This project's folder isn't a git repository on this computer.");
  // No filter: nothing to say for every project at once, no group.
  await render(page({ reviews }));
  expect(group()).toBeNull();
  // A project the answer did not read (past the cap, or its git unread): not "nothing".
  await render(page({ project: 'prj_other', reviews }));
  expect(group()).toBeNull();
});

test.skipIf(!hasDom)('git that could not be read says "The branches could not be read." where the group is, never "nothing"; a filtered list asks for its own rows', async () => {
  const answer: InboxLocalWorkAnswer = { unread: 1, unread_projects: ['prj_spaces'], items: [LOCAL.items[0]!], quiet: ['prj_spaces'], not_git: [] };
  const routes: Record<string, unknown> = { '/reviews/local': answer };
  const seen = fetches(routes);
  const unread = () => document.querySelector('[data-local-unread]')?.textContent ?? null;
  const reviews = { ...REVIEWS, projects: { 'github.com/charlie-dunn/spaces-site': ['prj_spaces'], 'github.com/charlie-dunn/plannotator': ['prj_plannotator'] } };
  // One project whose git was not read: the old list's words for it, not its words for nothing here.
  await mount(page({ project: 'prj_spaces', reviews }));
  expect(seen.filter((r) => r.url.includes('/reviews/local')).map((r) => r.url)).toEqual(['/api/inbox/reviews/local?project=prj_spaces']);
  await act(async () => toggle().click());
  expect(unread()).toBe('The branches could not be read.');
  expect(document.querySelector('[data-local-none]')).toBeNull();
  // The whole list: its rows, and the same words after them.
  await render(page({ reviews }));
  expect(rows()).toHaveLength(1);
  expect(unread()).toBe('The branches could not be read.');
  // A project that was read: its rows, no such words.
  await render(page({ project: 'prj_plannotator', reviews }));
  expect(rows()).toHaveLength(1);
  expect(unread()).toBeNull();
  // The whole list with no row at all and a read that failed: the group is there to say so.
  await act(async () => root!.unmount());
  root = null;
  routes['/reviews/local'] = { unread: 1, unread_projects: ['prj_spaces'], items: [] } satisfies InboxLocalWorkAnswer;
  await mount(page());
  expect(group()).not.toBeNull();
  expect(unread()).toBe('The branches could not be read.');
});
