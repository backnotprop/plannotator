/**
 * Bulk Merge on the Pull requests board (approval "inbox-pr-board-bulk": a confirm before merging, "merge the green ones
 * and tell me about the rest"). What regresses:
 *  - a merge sent on the first click, or a confirm that a click elsewhere or Escape does not drop;
 *  - the confirm not listing what merges and what stays, with why;
 *  - PRs merged at once instead of one after another, or a refusal sent again by itself;
 *  - the report not naming what merged and each refusal in the forge's words, or a refused pick leaving the selection;
 *  - a phone without its "Tap again" words.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No gh: the window's fetch is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
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
    head_sha: String(number).padStart(40, 'a'),
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

// ledger: a stack of #4 (merged), #5 and #6; #7 green; #8 failing. web: #20 green.
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-09T11:59:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [
    pull(4, { state: 'merged', merged_at: '2026-11-08T10:00:00.000Z' }),
    pull(5, { base: 'b4' }),
    pull(6, { base: 'b5' }),
    pull(7),
    pull(8, { checks: 'failure' }),
    pull(20, { repo: 'northwind/web' }),
  ],
  links: {},
  projects: { 'github.com/northwind/ledger': ['prj_ledger'], 'github.com/northwind/web': ['prj_web'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};
const key = (n: number, repo = 'northwind/ledger') => `github.com/${repo}#${n}`;

/** Every merge the window asked for, in order, each answered when the test says. */
let sent: { key: string; head_sha: string; confirmed: unknown; answer: (status: number, body: Record<string, unknown>) => void }[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  sent = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/pulls/merge')) return Response.json({});
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Promise<Response>((resolve) => {
      sent.push({ key: body.key, head_sha: body.head_sha, confirmed: body.confirmed, answer: (status, answer) => resolve(Response.json(answer, { status })) });
    });
  }) as unknown as typeof fetch;
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
  const refreshed: number[] = [];
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
    onOpenPull: () => {},
    onOpenStack: () => {},
    onMerged: () => refreshed.push(1),
    ...over,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><SidebarProvider><SheetPage {...props} /></SidebarProvider></div>));
  return { refreshed };
}

const click = (el: HTMLElement) => act(() => el.click());
const tile = (k: string) => $(`[data-pr-tile="${k}"]`)!;
const rows = (kind: string) => $$(`[data-pr-merge-row="${kind}"]`).map((r) => r.textContent);
const pickedTiles = () => $$('[data-pr-tile][aria-checked="true"]').map((t) => t.dataset.prTile).sort();
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Select, then pick #6 (waits on #5), #5, #7, #8 (failing) and #20. */
function pickFive() {
  click($('[data-pr-select="select"]')!);
  for (const k of [key(5), key(6), key(7), key(8), key(20, 'northwind/web')]) click(tile(k));
}

test('Merge counts the green ones; the first click only asks, listing what merges and what stays; a click elsewhere or Escape drops it', () => {
  if (!hasDom) return;
  draw();
  pickFive();
  const merge = $('[data-pr-merge]')!;
  expect(merge.textContent).toBe('Merge 3');
  expect($('[data-pr-merge-hint]')!.textContent).toBe('2 can’t merge now; they stay selected.');

  click(merge);
  expect(sent).toEqual([]);
  expect($('[data-pr-merge]')!.textContent).toBe('Confirm merge');
  expect($('[data-pr-merge-hint]')!.textContent).toBe('Click again to merge 3 pull requests. A merge can’t be undone.');
  expect(rows('merge')).toEqual(['#5Change 5', '#7Change 7', '#20Change 20']);
  expect(rows('skip')).toEqual(['#6 can’t merge now: it lands after #5.', '#8 can’t merge now: its checks are failing.']);

  act(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  expect($('[data-pr-merge]')!.textContent).toBe('Merge 3');
  expect($('[data-pr-merge-list]')).toBeNull();

  click($('[data-pr-merge]')!);
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect($('[data-pr-merge]')!.textContent).toBe('Merge 3');
  // Only the confirm went: select mode and the picks stay.
  expect(pickedTiles()).toHaveLength(5);
  expect(sent).toEqual([]);
});

test('the second click merges one after another at the heads seen; a refusal is reported in its words, never sent again, and stays picked', async () => {
  if (!hasDom) return;
  const { refreshed } = draw();
  pickFive();
  click($('[data-pr-merge]')!);
  click($('[data-pr-merge]')!);

  // One at a time: the next waits for the answer before it.
  expect(sent.map((s) => s.key)).toEqual([key(5)]);
  expect(sent[0]).toMatchObject({ head_sha: pull(5).head_sha, confirmed: true });
  expect($('[data-pr-merging]')!.textContent).toBe('Merging 1 of 3…');
  expect($('[data-pr-clear]')).toBeNull();
  sent[0]!.answer(200, { ok: true, key: key(5), method: 'merge', url: '' });
  await settle();
  expect(sent.map((s) => s.key)).toEqual([key(5), key(7)]);
  expect($('[data-pr-merging]')!.textContent).toBe('Merging 2 of 3…');
  sent[1]!.answer(409, { error: 'GitHub won’t merge it now: the branch is behind its base.', code: 'pull_not_mergeable' });
  await settle();
  sent[2]!.answer(200, { ok: true, key: key(20, 'northwind/web'), method: 'squash', url: '' });
  await settle();

  expect(sent).toHaveLength(3);
  expect(rows('merged')).toEqual(['Merged #5, #20.']);
  expect(rows('refused')).toEqual(['#7 GitHub won’t merge it now: the branch is behind its base.']);
  expect(rows('skipped')).toEqual(['#6 Not merged: it lands after #5.', '#8 Not merged: its checks are failing.']);
  // What merged left Open (#20 alone; #5 stays in its stack's pod as a merged layer); the rest stay picked.
  expect($(`[data-pr-tile="${key(20, 'northwind/web')}"]`)).toBeNull();
  expect(tile(key(5)).dataset.state).toBe('merged');
  expect(pickedTiles()).toEqual([key(6), key(7), key(8)].sort());
  expect($('[data-pr-picked]')!.textContent).toBe('3 selected');
  expect(refreshed).toEqual([1]);
  await settle();
  expect(sent).toHaveLength(3);
});

test('a phone: the sheet says Tap again, and nothing merges before the second tap', () => {
  if (!hasDom) return;
  draw({ phone: true, mode: 'page' });
  click($('[data-pr-select="select"]')!);
  click(tile(key(7)));
  click(tile(key(20, 'northwind/web')));
  const sheet = $('.ib-prs-picksheet')!;
  click(sheet.querySelector<HTMLElement>('[data-pr-merge]')!);
  expect(sheet.querySelector('[data-pr-merge-hint]')!.textContent).toBe('Tap again to merge 2. A merge can’t be undone.');
  expect(sent).toEqual([]);
  click(sheet.querySelector<HTMLElement>('[data-pr-merge]')!);
  expect(sent.map((s) => s.key)).toEqual([key(7)]);
});
