/**
 * The board's Table (approval "inbox-pr-board-bulk"). What regresses:
 *  - the Grid | Table switch missing on a desktop, or a phone drawing the table (it keeps the grid, with no switch);
 *  - a row's click not opening the PR as a tile's does, or the stack's mark in a row opening the PR instead of the stack;
 *  - a header's sort splitting a stack's layers;
 *  - the Merged view losing the table when Table is on.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullStack, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { SheetPageProps } from './SheetPage';

const hasDom = typeof document !== 'undefined';
const { SheetPage } = (hasDom ? await import('./SheetPage') : {}) as typeof import('./SheetPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const REPO = 'northwind/ledger';
const NOW = Date.parse('2026-11-09T12:00:00Z');

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  return {
    key: `github.com/${REPO}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo: REPO,
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `Change ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: REPO,
    head_sha: 'a'.repeat(40),
    additions: number,
    deletions: 1,
    files: 1,
    review: 'approved',
    approved_by: 'jun',
    reviewers: ['jun'],
    checks: 'success',
    conflicts: false,
    updated_at: '2026-11-08T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

// #5 under #6 is a stack; #7 and #8 stand alone. #4 was merged yesterday.
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-09T11:59:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [
    pull(5, { additions: 900 }),
    pull(6, { base: 'b5', additions: 2 }),
    pull(7, { mine: false, requested: true, author: 'tomas', review: null, checks: 'failure', additions: 40 }),
    pull(8, { additions: 300 }),
    pull(4, { state: 'merged', merged_at: '2026-11-08T10:00:00.000Z' }),
  ],
  links: {},
  projects: { [`github.com/${REPO}`]: ['prj_ledger'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};
const key = (n: number) => `github.com/${REPO}#${n}`;

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

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

function draw(over: Partial<SheetPageProps> = {}) {
  const opened: { pull: string; stack: string }[] = [];
  const stacks: string[] = [];
  const layouts: string[] = [];
  const props: SheetPageProps = {
    mode: 'pane',
    model: MODEL,
    error: null,
    loading: false,
    phone: false,
    view: 'open',
    risk: { [key(7)]: 'high' },
    now: NOW,
    layout: 'table',
    onLayout: (layout) => layouts.push(layout),
    onView: () => {},
    onOpenPull: (p: InboxPull, s: InboxPullStack) => opened.push({ pull: p.key, stack: s.id }),
    onOpenStack: (s: InboxPullStack) => stacks.push(s.id),
    onMerged: () => {},
    ...over,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><SidebarProvider><SheetPage {...props} /></SidebarProvider></div>));
  return { opened, stacks, layouts };
}

function redraw(over: Partial<SheetPageProps>) {
  act(() => root?.unmount());
  host?.remove();
  return draw(over);
}

const rowOrder = () => $$('[data-pr-row]').map((r) => r.dataset.prRow);

test('a desktop has the Grid | Table switch; Table draws rows under the repository, not tiles; a phone keeps the grid', () => {
  if (!hasDom) return;
  const { layouts } = draw({ layout: 'grid' });
  expect($('[data-pr-table]')).toBeNull();
  expect($$('[data-pr-tile]').length).toBeGreaterThan(0);
  act(() => $('[data-pr-layout="table"]')!.click());
  expect(layouts).toEqual(['table']);

  redraw({ layout: 'table' });
  expect($('[data-pr-layout="table"]')!.getAttribute('aria-pressed')).toBe('true');
  expect($('[data-pr-table]')).not.toBeNull();
  expect($$('[data-pr-tile]')).toHaveLength(0);
  expect(rowOrder()).toHaveLength(4);
  const group = $(`[data-pr-table] tbody[data-pr-repo] .ib-prtb-g`)!;
  expect(group.textContent).toContain('ledger');
  expect(group.textContent).toContain('4 open');
  const failing = $(`[data-pr-row="${key(7)}"]`)!;
  expect(failing.querySelector('.ib-prtb-ck')!.textContent).toBe('Failing');
  expect(failing.querySelector('.ib-prtb-risk')!.textContent).toBe('High');
  expect(failing.querySelector('.ib-prtb-a [data-face="tomas"]')).not.toBeNull();

  redraw({ layout: 'table', phone: true, mode: 'page' });
  expect($('[data-pr-layout]')).toBeNull();
  expect($('[data-pr-table]')).toBeNull();
  expect($$('[data-pr-tile]').length).toBeGreaterThan(0);
});

test("a row's click opens the PR, as a tile's does; the stack's mark in its first row opens the stack", () => {
  if (!hasDom) return;
  const { opened, stacks } = draw();
  act(() => $(`[data-pr-row="${key(8)}"] .ib-prtb-t`)!.click());
  expect(opened).toEqual([{ pull: key(8), stack: key(8) }]);
  // The keyboard's way: Enter on the row's number button is a click on it.
  act(() => $(`[data-pr-row="${key(6)}"] [data-pr-open]`)!.click());
  expect(opened[1]).toEqual({ pull: key(6), stack: key(6) });

  act(() => $(`[data-pr-row="${key(5)}"] [data-pr-stack-mark]`)!.click());
  expect(stacks).toEqual([key(6)]);
  expect(opened).toHaveLength(2);
  // Only the stack's first row has the mark; the layer above has the elbow.
  expect($(`[data-pr-row="${key(6)}"] [data-pr-stack-mark]`)).toBeNull();
  expect($(`[data-pr-row="${key(6)}"] .ib-prtb-elbow`)).not.toBeNull();
});

test("a header sorts, again reverses, and a stack's layers stay together in landing order", () => {
  if (!hasDom) return;
  draw();
  const size = () => $('[data-pr-sort="size"]')!;
  act(() => size().click());
  // The stack sorts by #5 (+900): last, with #6 right after it.
  expect(rowOrder()).toEqual([key(7), key(8), key(5), key(6)]);
  expect(size().closest('th')!.getAttribute('aria-sort')).toBe('ascending');
  act(() => size().click());
  expect(rowOrder()).toEqual([key(5), key(6), key(8), key(7)]);
  expect(size().closest('th')!.getAttribute('aria-sort')).toBe('descending');
});

test('Merged with Table on: the merged PRs as rows', () => {
  if (!hasDom) return;
  draw({ view: 'merged' });
  expect(rowOrder()).toEqual([key(4)]);
  expect($('.ib-prtb-g')!.textContent).toContain('1 merged');
  expect($$('[data-pr-tile]')).toHaveLength(0);
});
