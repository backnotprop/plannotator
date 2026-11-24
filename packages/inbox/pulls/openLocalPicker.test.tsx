/**
 * "On this computer"'s + in the window (OpenLocalPicker.tsx, localKept.ts; approval "reviews-open-any-branch-a"). What
 * regresses:
 *  - the + missing from the heading, or the picker asking for a project when there is only one;
 *  - a project's step not listing its worktree folders apart from its branches, a folder titled by its folder name
 *    instead of the branch in it (on no branch: by its name, its commit quiet), "same as main" not dimmed or not
 *    openable, or a search that doesn't narrow (and bold) what it finds;
 *  - picking a row not opening that work (`#reviews&local=…`), or opening it without keeping it: what you open stays in
 *    the list, read again with each list read (`keep=`), and a row with nothing beyond main stays only while open;
 *  - "Another folder…" not opening New message's folder opener, or the folder it starts in not opening as a review.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxLocalRefProjectsAnswer, InboxLocalRefsAnswer, InboxLocalWork, InboxLocalWorkAnswer, InboxPullRiskAnswer, InboxPullsAnswer, InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import type { LocalOpen } from './localRoute';

const hasDom = typeof document !== 'undefined';
if (hasDom) mock.module('#guide-reader', () => ({ default: () => null }));
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { LOCAL_KEPT_KEY } = (hasDom ? await import('./localKept') : {}) as typeof import('./localKept');

const LIST = { fetched_at: '2026-11-23T10:00:00.000Z', hosts: [], pulls: [], links: {}, projects: {}, cards: {} } as unknown as InboxPullsAnswer;
const RISK = { rules: null, provider: null, model: null, agents: [], pending: 0, last_failure: null, failed: {}, judgments: {} } as unknown as InboxPullRiskAnswer;
const REVIEWS: InboxReviewsAnswer = { fetched_at: null, hosts: [], rows: [], projects: {} };
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const LISTED: InboxLocalWorkAnswer = {
  unread: 0,
  items: [
    { project_id: 'prj_harbor', kind: 'uncommitted', branch: 'main', base: null, at: ago(0) },
    { project_id: 'prj_harbor', kind: 'branch', branch: 'fix/export-dialog-focus', base: 'main', at: ago(12 * MIN), ahead: 1 },
  ],
};
const folder = (over: Partial<InboxLocalWork>): InboxLocalWork => ({ project_id: 'prj_harbor', kind: 'folder', branch: null, base: 'main', at: ago(MIN), ahead: 0, folder: '/work/harbor-trees/x', head: null, uncommitted: false, ...over });
const branch = (name: string, ahead: number, at: string): InboxLocalWork => ({ project_id: 'prj_harbor', kind: 'branch', branch: name, base: 'main', at, ahead });
const LOGIN = folder({ branch: 'fix/login-redirect-loop', folder: '/work/harbor-trees/wt-login', at: ago(3 * MIN), uncommitted: true });
const SPIKE = folder({ folder: '/work/harbor-trees/bob-spike', head: '4e1c9a2', at: ago(60 * MIN), ahead: 1 });
const ONBOARD = folder({ branch: 'feat/onboarding-v2', folder: '/work/harbor-trees/wt-onboarding', at: ago(5 * 60 * MIN) });
const RELEASE = branch('release/2.4', 0, ago(35 * DAY));
const BRANCHES = [branch('chore/logging-levels', 2, ago(2 * DAY)), branch('charlie/search-ranking', 6, ago(21 * DAY)), RELEASE, ...Array.from({ length: 197 }, (_, i) => branch(`bulk/b-${i}`, 1, ago((40 + i) * DAY)))];
const REFS: InboxLocalRefsAnswer = { project_id: 'prj_harbor', base: 'main', folders: [LOGIN, SPIKE, ONBOARD], branches: BRANCHES };

let root: Root | null = null;
const restores: (() => void)[] = [];
let seen: string[] = [];
let answers: { projects: InboxLocalRefProjectsAnswer; kept: (keys: string[]) => InboxLocalWork[] };
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '#reviews');
  seen = [];
  answers = { projects: { projects: [{ project_id: 'prj_harbor', folders: 3, branches: 200 }, { project_id: 'prj_kestrel', folders: 0, branches: 14 }], another_folder: true, home: '/home/charlie' }, kept: () => [] };
  const clock = spyOn(Date, 'now').mockImplementation(() => NOW);
  restores.push(() => clock.mockRestore());
  const risk = spyOn(inboxApi, 'pullRisk').mockImplementation(async () => RISK);
  restores.push(() => risk.mockRestore());
  const made = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const query = new URL(url, 'http://inbox.test').searchParams;
    if (url.includes('/reviews/local/refs')) return Response.json(query.get('project') === 'prj_harbor' ? REFS : query.get('project') ? { ...REFS, project_id: query.get('project'), folders: [], branches: [] } : answers.projects);
    if (url.includes('/reviews/local/diff')) return Response.json({ project_id: '', kind: 'folder', branch: 'main', base: 'main', patch: '', ahead: 0, folder: query.get('folder'), head: null, uncommitted: false });
    if (url.includes('/reviews/local')) return Response.json({ ...LISTED, kept: answers.kept(query.getAll('keep')) });
    if (url.includes('/launch/folders')) return Response.json({ path: query.get('path'), exists: true, state: 'folder', folders: query.get('path') === '~' ? ['code'] : [] });
    return Response.json({ error: 'no' }, { status: 404 });
  }) as typeof fetch);
  restores.push(() => made.mockRestore());
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const restore of restores.splice(0)) restore();
});
const settle = async () => {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};
const wait = async (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const page = (local: LocalOpen | null = null) => (
  <SidebarProvider>
    <PullsPage
      state={{ model: LIST, reviews: REVIEWS, error: null, loading: false, refresh: () => {}, reload: () => {}, reloadRows: () => {} }}
      stackId={null}
      local={local}
      project={null}
      projects={[{ id: 'prj_harbor', name: 'harbor', root: '/work/harbor' } as never, { id: 'prj_kestrel', name: 'kestrel-docs', root: '/work/kestrel-docs' } as never]}
      projectNames={new Map([
        ['prj_harbor', 'harbor'],
        ['prj_kestrel', 'kestrel-docs'],
      ])}
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
const mount = async (local: LocalOpen | null = null) => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(page(local)));
  await settle();
};
const render = async (local: LocalOpen | null) => {
  await act(async () => root!.render(page(local)));
  await settle();
};
const plus = () => document.querySelector<HTMLButtonElement>('[data-pulls-group="local"] [data-local-open]');
const picker = () => document.querySelector<HTMLElement>('[data-local-picker]');
const filter = () => document.querySelector<HTMLInputElement>('[data-local-picker-filter]')!;
const rowsKeys = () => [...document.querySelectorAll('[data-pulls-group="local"] [data-local-row]')].map((row) => row.getAttribute('data-local-row'));
const picks = () => [...document.querySelectorAll<HTMLElement>('[data-local-pick]')];
const pickWords = (row: HTMLElement) => [row.querySelector('.ib-lp-op')?.textContent, row.querySelector('.ib-lp-of')?.textContent ?? null, row.querySelector('.ib-lp-r')?.textContent];
function type(input: HTMLInputElement, words: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, words);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (target: Element, name: string) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const openFold = async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-reviews-fold="local"]')!.click());
};

test.skipIf(!hasDom)("the heading's + opens the picker: projects, then a project's folders apart from its branches, each titled and dimmed as approved", async () => {
  await mount();
  expect(plus()?.getAttribute('aria-label')).toBe('Open branch or folder');
  await act(async () => plus()!.click());
  await settle();
  expect(picker()?.getAttribute('data-local-picker')).toBe('projects');
  expect(filter().placeholder).toBe('Project');
  const projects = [...document.querySelectorAll<HTMLElement>('[data-local-pick-project]')].map((row) => [row.querySelector('.ib-lp-op')?.textContent, row.querySelector('.ib-lp-r')?.textContent]);
  expect(projects).toEqual([
    ['harbor', '3 folders · 200 branches'],
    ['kestrel-docs', '14 branches'],
  ]);
  // "Another folder…" ends it.
  expect(document.querySelector('[data-local-pick-other]')?.textContent).toBe('Another folder…');
  // Enter on the first (highlighted) project: its step.
  key(filter(), 'Enter');
  await settle();
  expect(picker()?.getAttribute('data-local-picker')).toBe('refs');
  expect(filter().placeholder).toBe('Branch or folder');
  expect(document.querySelector('[data-local-picker-back]')?.textContent).toBe('harbor');
  expect([...document.querySelectorAll('.ib-lp-picker .ib-cp-cap')].map((cap) => cap.textContent)).toEqual(['Folders 3', 'Branches 200']);
  expect(picks().slice(0, 6).map(pickWords)).toEqual([
    // A worktree on a branch: the branch, its folder quiet; on no branch: its folder, its commit quiet.
    ['fix/login-redirect-loop', 'wt-login', 'uncommitted3m'],
    ['bob-spike', '4e1c9a2', '1 commit1h'],
    ['feat/onboarding-v2', 'wt-onboarding', 'same as main5h'],
    ['chore/logging-levels', null, '2 commits2d'],
    ['charlie/search-ranking', null, '6 commits3w'],
    ['release/2.4', null, 'same as main1mo'],
  ]);
  expect(picks().map((row) => row.getAttribute('data-local-kind')).filter((kind) => kind === 'folder')).toHaveLength(3);
  // "same as main" is dimmed, never left out.
  expect(picks()[2]!.querySelector('.ib-lp-dim')?.textContent).toBe('same as main');
  expect(picks()[5]!.querySelector('.ib-lp-dim')?.textContent).toBe('same as main');
  // Every one of 200 branches is there to find; typing narrows both kinds and bolds what it found.
  type(filter(), 'log');
  expect(picks().map((row) => row.querySelector('.ib-lp-op')?.textContent)).toEqual(['fix/login-redirect-loop', 'chore/logging-levels']);
  expect(picks().map((row) => row.querySelector('.ib-lp-op b')?.textContent)).toEqual(['log', 'log']);
  expect([...document.querySelectorAll('.ib-lp-picker .ib-cp-cap')].map((cap) => cap.textContent)).toEqual(['Folders 1', 'Branches 1']);
  type(filter(), 'b-196');
  expect(picks().map((row) => row.querySelector('.ib-lp-op')?.textContent)).toEqual(['bulk/b-196']);
  // Back to the projects; Escape closes.
  await act(async () => document.querySelector<HTMLButtonElement>('[data-local-picker-back]')!.click());
  expect(picker()?.getAttribute('data-local-picker')).toBe('projects');
  key(filter(), 'Escape');
  expect(picker()).toBeNull();
});

test.skipIf(!hasDom)('with one project the project step is skipped; "Another folder…" ends its list', async () => {
  answers.projects = { projects: [{ project_id: 'prj_harbor', folders: 3, branches: 200 }], another_folder: true, home: '/home/charlie' };
  await mount();
  await act(async () => plus()!.click());
  await settle();
  expect(picker()?.getAttribute('data-local-picker')).toBe('refs');
  expect(document.querySelector('[data-local-picker-back]')).toBeNull();
  expect(seen.filter((url) => url.includes('/reviews/local/refs'))).toEqual(['/api/inbox/reviews/local/refs', '/api/inbox/reviews/local/refs?project=prj_harbor']);
  expect(document.querySelector('[data-local-pick-other]')).not.toBeNull();
  // With Launch off, the folder opener can't read folders: no "Another folder…".
  await act(async () => plus()!.click());
  answers.projects = { projects: [{ project_id: 'prj_harbor', folders: 3, branches: 200 }], another_folder: false };
  await act(async () => plus()!.click());
  await settle();
  expect(document.querySelector('[data-local-pick-other]')).toBeNull();
});

test.skipIf(!hasDom)('what you open stays in the list: kept, read again with the list, and a row with nothing beyond main only while open', async () => {
  answers.kept = (keys) => [SPIKE, RELEASE].filter((row) => keys.includes(row.kind === 'folder' ? `prj_harbor::${row.folder}` : `prj_harbor:${row.branch}`));
  await mount();
  await openFold();
  expect(rowsKeys()).toEqual(['prj_harbor:', 'prj_harbor:fix/export-dialog-focus']);
  await act(async () => plus()!.click());
  await settle();
  key(filter(), 'Enter');
  await settle();
  // The detached worktree.
  await act(async () => picks()[1]!.click());
  await settle();
  expect(picker()).toBeNull();
  expect(readRoute().local).toEqual({ project: 'prj_harbor', branch: null, folder: '/work/harbor-trees/bob-spike' });
  expect(JSON.parse(window.localStorage.getItem(LOCAL_KEPT_KEY)!).map((item: { key: string }) => item.key)).toEqual(['prj_harbor::/work/harbor-trees/bob-spike']);
  expect(seen.at(-1)).toContain('keep=prj_harbor%3A%3A%2Fwork%2Fharbor-trees%2Fbob-spike');
  await render(readRoute().local!);
  // It joined the group by its age, titled by its folder with its commit quiet, and stays once closed (it has work).
  expect(rowsKeys()).toEqual(['prj_harbor:', 'prj_harbor:fix/export-dialog-focus', 'prj_harbor::/work/harbor-trees/bob-spike']);
  const spike = document.querySelector('[data-local-row="prj_harbor::/work/harbor-trees/bob-spike"]')!;
  expect(spike.getAttribute('data-local-kind')).toBe('folder');
  expect(spike.querySelector('[data-local-project]')?.textContent).toBe('4e1c9a2');
  await render(null);
  expect(rowsKeys()).toContain('prj_harbor::/work/harbor-trees/bob-spike');
  // A branch with nothing beyond main: first while it is open, gone once closed, though still kept.
  await act(async () => plus()!.click());
  await settle();
  key(filter(), 'Enter');
  await settle();
  type(filter(), 'release');
  key(filter(), 'Enter');
  await settle();
  expect(readRoute().local).toEqual({ project: 'prj_harbor', branch: 'release/2.4' });
  await render(readRoute().local!);
  expect(rowsKeys()[0]).toBe('prj_harbor:release/2.4');
  expect(document.querySelector('[data-local-diff]')).not.toBeNull();
  await render(null);
  expect(rowsKeys()).not.toContain('prj_harbor:release/2.4');
  expect(JSON.parse(window.localStorage.getItem(LOCAL_KEPT_KEY)!).map((item: { key: string }) => item.key)).toEqual(['prj_harbor:release/2.4', 'prj_harbor::/work/harbor-trees/bob-spike']);
});

test.skipIf(!hasDom)('"Another folder…" opens the folder opener as it is; the folder it starts in opens as a review', async () => {
  await mount();
  await act(async () => plus()!.click());
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-local-pick-other]')!.click());
  await settle();
  expect(picker()?.getAttribute('data-local-picker')).toBe('folder');
  expect(document.querySelector('[data-home-folders="self"]')).not.toBeNull();
  const field = document.querySelector<HTMLInputElement>('[data-home-folders-path]')!;
  type(field, '~/code/harbor-spike/');
  await wait(200);
  await settle();
  // Its own route reads the folders, as New message's does.
  expect(seen.some((url) => url.includes('/launch/folders') && url.includes('code%2Fharbor-spike'))).toBe(true);
  const start = document.querySelector<HTMLElement>('[data-home-folder-start]');
  expect(start?.getAttribute('data-home-folder-start')).toBe('~/code/harbor-spike');
  await act(async () => start!.click());
  await settle();
  expect(picker()).toBeNull();
  expect(readRoute().local).toEqual({ project: '', branch: null, folder: '~/code/harbor-spike' });
  await render(readRoute().local!);
  // No project: the folder alone, for the server to judge by the folder opener's own rules.
  expect(seen).toContain('/api/inbox/reviews/local/diff?folder=~%2Fcode%2Fharbor-spike');
  expect(document.querySelector('[data-local-same]')?.textContent).toBe('Same as main.');
  // Its back arrow returns to the projects.
  await act(async () => plus()!.click());
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-local-pick-other]')!.click());
  await settle();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-home-folders-back]')!.click());
  expect(picker()?.getAttribute('data-local-picker')).toBe('projects');
});
