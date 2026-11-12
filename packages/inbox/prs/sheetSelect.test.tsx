/**
 * Select mode on the Pull requests board (approval "inbox-pr-board-bulk", the owner's pick B: "select mode must be
 * different thing and not always on"). What regresses:
 *  - a box anywhere, in the grid or the table, before Select is pressed;
 *  - a tile's or a row's click outside select mode no longer opening the PR, or one inside it opening the PR instead
 *    of picking it;
 *  - the bar not taking the filter row's place while something is picked, or Clear / Done leaving boxes behind;
 *  - a shift-click not picking the range from the last pick, in the order on screen (the table's sort included);
 *  - Select all in a repository picking another repository's PRs or a merged one, or not letting them go again;
 *  - a phone without its count at the bottom, or without Done in the filter row;
 *  - Escape not leaving select mode, or taking the key from an open menu, a field, a dialog or what used it first.
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

const NOW = Date.parse('2026-11-09T12:00:00Z');

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? 'northwind/ledger';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Change ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
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

// ledger: a stack of #4 (merged), #5 and #6; #7; #8. web: #20.
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-09T11:59:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [
    pull(4, { state: 'merged', merged_at: '2026-11-08T10:00:00.000Z' }),
    pull(5, { base: 'b4', additions: 900 }),
    pull(6, { base: 'b5', additions: 2 }),
    pull(7, { additions: 40 }),
    pull(8, { additions: 300 }),
    pull(20, { repo: 'northwind/web', additions: 10 }),
  ],
  links: {},
  projects: { 'github.com/northwind/ledger': ['prj_ledger'], 'github.com/northwind/web': ['prj_web'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};
const key = (n: number, repo = 'northwind/ledger') => `github.com/${repo}#${n}`;
const LEDGER = [5, 6, 7, 8].map((n) => key(n));

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
  const opened: string[] = [];
  const props: SheetPageProps = {
    mode: 'pane',
    model: MODEL,
    error: null,
    loading: false,
    phone: false,
    view: 'open',
    risk: {},
    now: NOW,
    layout: 'grid',
    onLayout: () => {},
    onView: () => {},
    onOpenPull: (p: InboxPull) => opened.push(p.key),
    onOpenStack: (s: InboxPullStack) => opened.push(`stack ${s.id}`),
    onMerged: () => {},
    ...over,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><SidebarProvider><SheetPage {...props} /></SidebarProvider></div>));
  return { opened };
}

/** A mouse's click (a keyboard's has no `detail`), with Shift held or not. */
function mouse(el: HTMLElement, shiftKey = false) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, shiftKey }));
  });
}
const press = (selector: string) => act(() => $(selector)!.click());
const tile = (k: string) => $(`[data-pr-tile="${k}"]`)!;
const row = (k: string) => $(`[data-pr-row="${k}"]`)!;
const pickedTiles = () => $$('[data-pr-tile][aria-checked="true"]').map((t) => t.dataset.prTile);
const pickedRows = () => $$('[data-pr-row][data-picked]').map((r) => r.dataset.prRow);
const noBoxes = () => $$('.ib-prs-box, [role="checkbox"], .ib-prtb-c').length === 0;

test('select mode off: no box anywhere, grid or table; a tile and a row open the PR as before', () => {
  if (!hasDom) return;
  const { opened } = draw();
  expect(noBoxes()).toBe(true);
  expect($('[data-pr-select="select"]')!.textContent).toBe('Select');
  mouse(tile(key(7)));
  expect(opened).toEqual([key(7)]);
  // The keyboard's Enter still pins the popover.
  act(() => tile(key(8)).click());
  expect($(`[data-pr-pop="${key(8)}"]`)).not.toBeNull();

  act(() => root?.unmount());
  host?.remove();
  const table = draw({ layout: 'table' });
  expect(noBoxes()).toBe(true);
  mouse(row(key(8)));
  expect(table.opened).toEqual([key(8)]);
});

test('Select: a box in every open tile and before each repository; a click picks, and the bar takes the filter row', () => {
  if (!hasDom) return;
  const { opened } = draw();
  press('[data-pr-select="select"]');
  expect($$('[data-pr-tile][role="checkbox"]')).toHaveLength(5);
  const ledger = $('[data-pr-select-all][aria-label="Select all in ledger"]')!;
  expect(ledger.getAttribute('title')).toBe('Select all in ledger');
  expect($('[data-pr-select="done"]')!.textContent).toBe('Done');

  mouse(tile(key(7)));
  expect(opened).toEqual([]);
  expect(pickedTiles()).toEqual([key(7)]);
  expect($('[data-pr-filter]')).toBeNull();
  expect($('[data-pr-select]')).toBeNull();
  expect($('[data-pr-picked]')!.textContent).toBe('1 selected');
  // A second click lets it go: nothing picked, the filter row is back, still in select mode.
  mouse(tile(key(7)));
  expect(pickedTiles()).toEqual([]);
  expect($('[data-pr-filter]')).not.toBeNull();
  expect($('[data-pr-select="done"]')).not.toBeNull();

  mouse(tile(key(8)));
  press('[data-pr-clear]');
  expect(noBoxes()).toBe(true);
  expect($('[data-pr-filter]')).not.toBeNull();
  expect($('[data-pr-select="select"]')).not.toBeNull();
  mouse(tile(key(8)));
  expect(opened).toEqual([key(8)]);

  press('[data-pr-select="select"]');
  press('[data-pr-select="done"]');
  expect(noBoxes()).toBe(true);
});

test('a shift-click picks the range from the last pick, in the order on screen; in the table, its sorted order', () => {
  if (!hasDom) return;
  draw();
  press('[data-pr-select="select"]');
  const order = $$('[data-pr-tile][role="checkbox"]').map((t) => t.dataset.prTile!);
  mouse(tile(order[0]!));
  mouse(tile(order[3]!), true);
  expect(pickedTiles()).toEqual(order.slice(0, 4));
  expect($('[data-pr-picked]')!.textContent).toBe('4 selected');

  act(() => root?.unmount());
  host?.remove();
  draw({ layout: 'table' });
  press('[data-pr-sort="size"]');
  press('[data-pr-select="select"]');
  const rows = $$('[data-pr-row]').map((r) => r.dataset.prRow!);
  // Size: #7 (+40), #8 (+300), then the stack by its next layer to land, #5 (+900), its merged #4 first.
  expect(rows.slice(0, 5)).toEqual([key(7), key(8), key(4), key(5), key(6)]);
  mouse(row(key(6)));
  mouse(row(key(8)), true);
  expect(pickedRows()).toEqual([key(8), key(5), key(6)]);
});

test("Select all in a repository picks its open PRs only, shows half while some are, and again lets them go; the table's head picks all", () => {
  if (!hasDom) return;
  draw();
  press('[data-pr-select="select"]');
  const all = () => $('[data-pr-select-all][aria-label="Select all in ledger"]')!;
  act(() => all().click());
  expect(pickedTiles().sort()).toEqual([...LEDGER].sort());
  expect(all().getAttribute('aria-checked')).toBe('true');
  mouse(tile(key(7)));
  expect(all().getAttribute('aria-checked')).toBe('mixed');
  act(() => all().click());
  expect(pickedTiles().sort()).toEqual([...LEDGER].sort());
  act(() => all().click());
  expect(pickedTiles()).toEqual([]);

  act(() => root?.unmount());
  host?.remove();
  draw({ layout: 'table' });
  press('[data-pr-select="select"]');
  act(() => $('[data-pr-select-all][aria-label="Select all"]')!.click());
  expect(pickedRows().sort()).toEqual([...LEDGER, key(20, 'northwind/web')].sort());
  act(() => $('[data-pr-select-all][aria-label="Select all in web"]')!.click());
  expect(pickedRows().sort()).toEqual([...LEDGER].sort());
});

test('a phone: the filter row keeps Done, and the count and Clear sit in a sheet at the bottom', () => {
  if (!hasDom) return;
  draw({ phone: true, mode: 'page' });
  press('[data-pr-select="select"]');
  act(() => tile(key(7)).click());
  expect($('[data-pr-filter]')).not.toBeNull();
  expect($('[data-pr-select="done"]')).not.toBeNull();
  const sheet = $('.ib-prs-picksheet')!;
  expect(sheet.querySelector('[data-pr-picked]')!.textContent).toBe('1 selected');
  act(() => (sheet.querySelector('[data-pr-clear]') as HTMLElement).click());
  expect($('.ib-prs-picksheet')).toBeNull();
  expect(noBoxes()).toBe(true);
});

/**
 * An Escape from `from` (the page's body when absent), as a person's key reaches the page, and whether it was used when
 * it reached a window listener added before the page drew, as App's ladder is.
 */
let windowSaw: boolean | null = null;
const onWindow = (event: KeyboardEvent) => {
  if (event.key === 'Escape') windowSaw = event.defaultPrevented;
};
beforeEach(() => {
  if (hasDom) window.addEventListener('keydown', onWindow);
});
afterEach(() => {
  if (hasDom) window.removeEventListener('keydown', onWindow);
});
function escape(from?: HTMLElement | null) {
  windowSaw = null;
  act(() => {
    (from ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  return { usedBeforeWindow: windowSaw };
}

test('Escape leaves select mode, its picks and boxes gone, focus from Clear on Select; App\'s ladder on the window stands down', async () => {
  if (!hasDom) return;
  const { opened } = draw();
  // Outside select mode Escape is not the board's: the window's ladder gets it unused.
  expect(escape().usedBeforeWindow).toBe(false);

  press('[data-pr-select="select"]');
  mouse(tile(key(7)));
  $('[data-pr-clear]')!.focus();
  const sent = escape($('[data-pr-clear]'));
  expect(sent.usedBeforeWindow).toBe(true);
  expect(noBoxes()).toBe(true);
  expect($('[data-pr-select="select"]')).not.toBeNull();
  expect($('[data-pr-filter]')).not.toBeNull();
  expect(opened).toEqual([]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.activeElement).toBe($('[data-pr-select="select"]'));
});

test('Escape closes what is open first: a menu, a field, a dialog or a key already used keep it, and select mode stays', () => {
  if (!hasDom) return;
  draw({ layout: 'table' });
  press('[data-pr-select="select"]');
  mouse(row(key(7)));
  const stays = () => expect(pickedRows()).toEqual([key(7)]);

  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  const item = document.createElement('button');
  item.setAttribute('role', 'menuitem');
  menu.appendChild(item);
  document.body.appendChild(menu);
  expect(escape(item).usedBeforeWindow).toBe(false);
  stays();
  menu.remove();

  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.appendChild(dialog);
  escape();
  stays();
  dialog.remove();

  const field = document.createElement('input');
  document.body.appendChild(field);
  escape(field);
  stays();
  field.remove();

  // Something inside the page used this Escape (a popover, the filter's list): it marks the key, the board leaves it.
  const used = (event: KeyboardEvent) => event.preventDefault();
  host!.addEventListener('keydown', used);
  escape(row(key(8)));
  host!.removeEventListener('keydown', used);
  stays();

  escape(row(key(8)));
  expect(pickedRows()).toEqual([]);
  expect(noBoxes()).toBe(true);
});
