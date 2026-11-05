/**
 * The Pull requests list's filter (approval "pr-list-filters", round 7 take B "One filter button"), in the window, with
 * the view and the project held the way App holds them (the address). What regresses:
 *  - the filter shown before the first answer, or anything but "Reviews" and the mark in the head (a project's name, the
 *    on-you count: the head must never grow);
 *  - a pick not narrowing the rows, the mark not saying it is narrowed, or the picks not named once over the list;
 *    × or Clear filters clearing one and not the other, or in two steps;
 *  - the menu's counts not following the other choice; project rows for a single project; Clear filters at rest;
 *  - a project gone from the list kept as a filter (an empty list naming no project);
 *  - a stack the address names but the view leaves out opening a blank pane;
 *  - a view with nothing in it saying "Nothing open in your projects", or a failed read said as an empty view;
 *  - the phone's menu not a bottom sheet.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from '../api';
import type { PullFilter } from './model';
import type { PullsPageProps } from './PullsPage';

import { pullsStateOf } from './reviewsTestState';
const hasDom = typeof document !== 'undefined';
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const WEB = 'northwind/web-app';
const BILL = 'northwind/billing-svc';

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? WEB;
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
    reviewers: ['jun'],
    checks: 'success',
    updated_at: '2026-11-03T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

// web-app: dana's own (#1, waiting on review), jun's asking her (#2, on you), mei's assigned to her (#3, on you),
// tomas's (#4, others). billing-svc: dana's own (#5), jun's asking her (#6, on you).
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-03T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [
    pull(1),
    pull(2, { mine: false, requested: true, author: 'jun' }),
    pull(3, { mine: false, assigned: true, author: 'mei' }),
    pull(4, { mine: false, author: 'tomas' }),
    pull(5, { repo: BILL }),
    pull(6, { repo: BILL, mine: false, requested: true, author: 'jun' }),
  ],
  links: {},
  projects: { [`github.com/${WEB}`]: ['prj_web'], [`github.com/${BILL}`]: ['prj_bill'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};

const AT = '2026-11-01T09:00:00.000Z';
const PROJECTS = [
  { id: 'prj_web', key: 'web', name: 'web-app', root: '/home/dana/web-app', created_at: AT, threads: 1, unread: 0 },
  { id: 'prj_bill', key: 'bill', name: 'billing-svc', root: '/home/dana/billing-svc', created_at: AT, threads: 1, unread: 0 },
] as unknown as ProjectFolder[];
const NAMES = new Map([
  ['prj_web', 'web-app'],
  ['prj_bill', 'billing-svc'],
]);

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
/** The rows shown, the folded ones opened. */
const rowNumbers = () =>
  $$('[data-pulls-row]')
    .map((r) => Number(r.getAttribute('data-pulls-row')!.split('#')[1]))
    .sort((a, b) => a - b);

/** The page with its view and project held the way App holds them: each pick is drawn again. */
function draw(over: Partial<PullsPageProps> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const picks: { filter: PullFilter; project: string | null }[] = [];
  let props: PullsPageProps = {
    state: pullsStateOf(MODEL),
    stackId: null,
    project: null,
    filter: 'all',
    projects: PROJECTS,
    projectNames: NAMES,
    phone: false,
    onNew: () => {},
    onOpenStack: () => {},
    onScope: (next) => {
      picks.push(next);
      props = { ...props, ...next };
      render();
    },
    onReview: () => {},
    onOpenThread: () => {},
    onLaunch: () => {},
    onStarted: () => {},
    ...over,
  };
  const render = () =>
    act(() =>
      root!.render(
        <div className="pn-inbox">
          <SidebarProvider>
            <PullsPage {...props} />
          </SidebarProvider>
        </div>,
      ),
    );
  render();
  return { picks };
}

async function openWaiting() {
  for (const fold of $$('[data-reviews-fold][aria-expanded="false"]')) {
    await act(async () => fold.click());
    await settle();
  }
}

/** The menu's rows: what each says, its count, and whether it is the chosen one. */
const menuRows = (selector: string) =>
  $$(`[data-pulls-filter-menu] ${selector}`).map((row) => ({
    label: row.querySelector('.ib-pmi-l')!.textContent,
    n: row.querySelector('.ib-pmi-n')!.textContent,
    on: row.getAttribute('aria-checked') === 'true',
  }));

test.if(hasDom)('at rest: "Reviews" and the filter mark, nothing else in the head; nothing before the first answer', async () => {
  draw({ state: pullsStateOf(null, true) });
  await settle();
  expect($('[data-pulls-heading]')!.textContent).toBe('Reviews');
  expect($('[data-pulls-filter-trigger]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  draw();
  await settle();
  const head = $('[data-pulls-list] .ib-lhead')!;
  expect(head.textContent).toBe('Reviews');
  const trigger = head.querySelector<HTMLElement>('[data-pulls-filter-trigger]')!;
  expect(trigger.getAttribute('aria-label')).toBe('Filter');
  expect(trigger.hasAttribute('data-set')).toBe(false);
  expect($('[data-pulls-scope]')).toBeNull();
  await openWaiting();
  expect(rowNumbers()).toEqual([1, 2, 3, 4, 5, 6]);
});

test.if(hasDom)('the menu: views and projects with counts and a tick; a pick narrows the rows, the mark says so, the line names it once', async () => {
  const drawn = draw();
  await settle();
  await press($('[data-pulls-filter-trigger]')!);
  expect($('[data-pulls-filter-menu]')!.getAttribute('role')).toBe('menu');
  expect(menuRows('[data-pulls-filter]')).toEqual([
    { label: 'All', n: '6', on: true },
    { label: 'Mine', n: '2', on: false },
    { label: 'To review', n: '3', on: false },
    { label: 'Others', n: '1', on: false },
  ]);
  expect(menuRows('[data-pulls-filter-project-option]')).toEqual([
    { label: 'All projects', n: '6', on: true },
    { label: 'web-app', n: '4', on: false },
    { label: 'billing-svc', n: '2', on: false },
  ]);
  // Nothing narrowed: nothing to clear.
  expect($('[data-pulls-filter-clear-item]')).toBeNull();

  await act(async () => $('[data-pulls-filter="review"]')!.click());
  await settle();
  expect(drawn.picks).toEqual([{ filter: 'review', project: null }]);
  await openWaiting();
  expect(rowNumbers()).toEqual([2, 3, 6]);
  const trigger = $('[data-pulls-filter-trigger]')!;
  expect(trigger.hasAttribute('data-set')).toBe(true);
  expect(trigger.getAttribute('aria-label')).toBe('Filter: To review');
  expect($('[data-pulls-scope-view]')!.textContent).toBe('To review');
  expect($('[data-pulls-scope-project]')).toBeNull();
  // The head never grows: still only "Reviews".
  expect($('[data-pulls-list] .ib-lhead')!.textContent).toBe('Reviews');

  // The projects' counts follow the view.
  await press(trigger);
  expect(menuRows('[data-pulls-filter-project-option]').map((r) => r.n)).toEqual(['3', '2', '1']);
  await act(async () => $('[data-pulls-filter-project-option="prj_web"]')!.click());
  await settle();
  expect(drawn.picks.at(-1)).toEqual({ filter: 'review', project: 'prj_web' });
  expect(rowNumbers()).toEqual([2, 3]);
  expect($('[data-pulls-scope-project]')!.textContent).toBe('web-app');
  expect(trigger.getAttribute('aria-label')).toBe('Filter: To review, web-app');
  // The views' counts follow the project; both picked rows are the checked ones.
  await press(trigger);
  expect(menuRows('[data-pulls-filter]').map((r) => r.n)).toEqual(['4', '1', '2', '1']);
  expect($$('[data-pulls-filter-menu] [aria-checked="true"]').map((r) => r.getAttribute('data-pulls-filter') ?? r.getAttribute('data-pulls-filter-project-option'))).toEqual(['review', 'prj_web']);
});

test.if(hasDom)('× and Clear filters clear the view and the project in one step', async () => {
  const drawn = draw({ filter: 'mine', project: 'prj_bill' });
  await settle();
  await openWaiting();
  expect(rowNumbers()).toEqual([5]);
  await act(async () => $('[data-pulls-filter-clear]')!.click());
  await settle();
  expect(drawn.picks).toEqual([{ filter: 'all', project: null }]);
  expect($('[data-pulls-scope]')).toBeNull();
  await openWaiting();
  expect(rowNumbers()).toEqual([1, 2, 3, 4, 5, 6]);

  act(() => root?.unmount());
  host?.remove();
  const again = draw({ filter: 'others', project: null });
  await settle();
  await press($('[data-pulls-filter-trigger]')!);
  await act(async () => $('[data-pulls-filter-clear-item]')!.click());
  await settle();
  expect(again.picks).toEqual([{ filter: 'all', project: null }]);
});

test.if(hasDom)('nothing anywhere: "No reviews yet", with the way to start one', async () => {
  let asked = 0;
  draw({ state: pullsStateOf({ ...MODEL, pulls: [] }), onNew: () => asked++ });
  await settle();
  expect($('[data-pulls-list]')!.textContent).toContain('No reviews yet');
  await act(async () => $('[data-reviews-new="empty"]')!.click());
  await act(async () => $('[data-reviews-new="head"]')!.click());
  expect(asked).toBe(2);
});

test.if(hasDom)('one project offered: no project rows', async () => {
  const one: InboxPullsAnswer = { ...MODEL, pulls: [pull(1), pull(4, { mine: false, author: 'tomas' })], projects: { [`github.com/${WEB}`]: ['prj_web'] } };
  draw({ state: pullsStateOf(one) });
  await settle();
  await press($('[data-pulls-filter-trigger]')!);
  expect($$('[data-pulls-filter-menu] [data-pulls-filter]')).toHaveLength(4);
  expect($('[data-pulls-filter-project-option]')).toBeNull();
});

test.if(hasDom)('a project gone from the list is no filter: every PR, no line naming it, the mark at rest', async () => {
  draw({ project: 'prj_gone' });
  await settle();
  expect($('[data-pulls-scope]')).toBeNull();
  expect($('[data-pulls-filter-trigger]')!.getAttribute('aria-label')).toBe('Filter');
  await openWaiting();
  expect(rowNumbers()).toEqual([1, 2, 3, 4, 5, 6]);
  expect(document.body.textContent).not.toContain('Project');
});

test.if(hasDom)('a stack the address names opens even when the view leaves it out: never a blank pane', async () => {
  draw({ filter: 'mine', stackId: `github.com/${WEB}#4` });
  await settle();
  expect($('[data-pulls-pane-empty]')).toBeNull();
  expect($('[data-pulls-stack]')).not.toBeNull();
});

test.if(hasDom)('an empty view says what the view holds; a failed read is never said as an empty view', async () => {
  const theirs: InboxPullsAnswer = { ...MODEL, pulls: [pull(4, { mine: false, author: 'tomas' })] };
  draw({ filter: 'mine', state: pullsStateOf(theirs) });
  await settle();
  expect($('[data-pulls-empty]')!.getAttribute('data-pulls-empty')).toBe('view-mine');
  act(() => root?.unmount());
  host?.remove();

  const failed: InboxPullsAnswer = { ...theirs, pulls: [], hosts: [{ cli: 'gh', host: 'github.com', login: null, error: 'unavailable' }] };
  draw({ filter: 'mine', state: pullsStateOf(failed) });
  await settle();
  expect($('[data-pulls-empty]')!.getAttribute('data-pulls-empty')).toBe('unread');
});

test.if(hasDom)('Others failing or on its way: Mine and To review still say what they hold; Others never says "Nothing else open"; a failed own read is never hidden behind "Reading…"', async () => {
  const theirs = (host: InboxPullsAnswer['hosts'][number]): InboxPullsAnswer => ({ ...MODEL, pulls: [], hosts: [host] });
  const failed = theirs({ cli: 'gh', host: 'github.com', login: 'dana', others_error: 'unavailable' });
  const cases: [PullFilter, InboxPullsAnswer, string][] = [
    ['mine', failed, 'view-mine'],
    ['review', failed, 'view-review'],
    ['others', failed, 'unread'],
    ['others', theirs({ cli: 'gh', host: 'github.com', login: 'dana', others_pending: true }), 'reading'],
    ['all', theirs({ cli: 'gh', host: 'github.com', login: 'dana', others_pending: true }), 'reading'],
  ];
  // The person's own read failed while Others is on its way: the failure is said at once, never "Reading…".
  const ownFailed = theirs({ cli: 'gh', host: 'github.com', login: 'dana', error: 'unavailable', others_pending: true });
  for (const filter of ['all', 'others'] as const) {
    draw({ filter, state: pullsStateOf(ownFailed) });
    await settle();
    expect(`${filter}: ${$('[data-pulls-empty]')!.getAttribute('data-pulls-empty')}`).not.toBe(`${filter}: reading`);
    expect($('[data-pulls-list]')!.textContent).not.toContain('Reading your pull requests');
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
  for (const [filter, model, said] of cases) {
    draw({ filter, state: pullsStateOf(model) });
    await settle();
    expect(`${filter}: ${$('[data-pulls-empty]')!.getAttribute('data-pulls-empty')}`).toBe(`${filter}: ${said}`);
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
});

test.if(hasDom)("a phone's menu is a bottom sheet titled Filter", async () => {
  draw({ phone: true, filter: 'review', project: 'prj_web' });
  await settle();
  await press($('[data-pulls-filter-trigger]')!);
  const menu = $('[data-pulls-filter-menu]')!;
  expect(menu.closest('.ib-pm-pos')!.hasAttribute('data-phone')).toBe(true);
  expect($('.ib-pm-scrim')).not.toBeNull();
  expect(menu.querySelector('.ib-pm-title')!.textContent).toBe('Filter');
});
