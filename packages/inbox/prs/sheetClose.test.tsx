/**
 * Bulk Close on the Pull requests board (approval "inbox-pr-board-bulk": Close shows the count with Undo, no confirm).
 * What regresses:
 *  - Close asking first, or closing several at once instead of one after another;
 *  - a refusal not reported in the host's words, sent again by itself, or leaving the selection;
 *  - closed PRs staying in Open, or a toast without the count and Undo;
 *  - Undo reopening anything but what that Close closed, or not picking them again and saying how each went.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No gh: the window's fetch is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from '../components/Toast';
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

// ledger: #7, #8 (failing checks: Close doesn't care), #9; web: #20.
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-09T11:59:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [pull(7), pull(8, { checks: 'failure' }), pull(9), pull(20, { repo: 'northwind/web' })],
  links: {},
  projects: { 'github.com/northwind/ledger': ['prj_ledger'], 'github.com/northwind/web': ['prj_web'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};
const key = (n: number, repo = 'northwind/ledger') => `github.com/${repo}#${n}`;
const WEB20 = key(20, 'northwind/web');

/** Every close and reopen the window asked for, in order, each answered when the test says. */
let sent: { route: string; key: string; answer: (status: number, body: Record<string, unknown>) => void }[] = [];
let toasts: { toast: Omit<InboxToastModel, 'id'>; ms: number }[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  sent = [];
  toasts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = /\/pulls\/(close|reopen|merge)$/.exec(String(url))?.[1];
    if (!route) return Response.json({});
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Promise<Response>((resolve) => {
      sent.push({ route, key: body.key, answer: (status, answer) => resolve(Response.json(answer, { status })) });
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
    onToast: (toast, ms) => toasts.push({ toast, ms }),
    ...over,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><SidebarProvider><SheetPage {...props} /></SidebarProvider></div>));
  return { refreshed };
}

const click = (el: HTMLElement) => act(() => el.click());
const tile = (k: string) => $(`[data-pr-tile="${k}"]`);
const rows = (kind: string) => $$(`[data-pr-merge-row="${kind}"]`).map((r) => r.textContent);
const pickedTiles = () => $$('[data-pr-tile][aria-checked="true"]').map((t) => t.dataset.prTile).sort();
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
/** Answers the request on its way, then the next one it starts, in turn. */
async function answerAll(answers: [number, Record<string, unknown>][]) {
  for (const [status, body] of answers) {
    sent.at(-1)!.answer(status, body);
    await settle();
  }
}

/** Select, then pick #7, #8 and #20, and press Close. */
function closeThree() {
  click($('[data-pr-select="select"]')!);
  for (const k of [key(7), key(8), WEB20]) click(tile(k)!);
  const close = $('[data-pr-close]')!;
  expect(close.textContent).toBe('Close 3');
  click(close);
}

test('Close goes at once, one PR after another; a refusal keeps its words and its pick; the toast has the count and Undo', async () => {
  if (!hasDom) return;
  const { refreshed } = draw();
  closeThree();
  // No confirm: the first close is already on its way, and only one at a time.
  expect(sent.map((s) => `${s.route} ${s.key}`)).toEqual([`close ${key(7)}`]);
  expect($('[data-pr-running="close"]')!.textContent).toBe('Closing 1 of 3…');
  expect($('[data-pr-clear]')).toBeNull();
  await answerAll([
    [200, { ok: true, key: key(7), url: '' }],
    [409, { error: 'It is already merged.', code: 'pull_merged' }],
    [200, { ok: true, key: WEB20, url: '' }],
  ]);

  expect(sent.map((s) => `${s.route} ${s.key}`)).toEqual([`close ${key(7)}`, `close ${key(8)}`, `close ${WEB20}`]);
  expect(rows('closed')).toEqual(['Closed #7, #20.']);
  expect(rows('refused')).toEqual(['#8 It is already merged.']);
  // What closed left Open; the refusal stays picked.
  expect(tile(key(7))).toBeNull();
  expect(tile(WEB20)).toBeNull();
  expect(pickedTiles()).toEqual([key(8)]);
  expect(refreshed).toEqual([1]);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.toast).toMatchObject({ lead: 'Closed 2', noKey: true });
  expect(typeof toasts[0]!.toast.onUndo).toBe('function');
  await settle();
  expect(sent).toHaveLength(3);
});

test('Undo reopens exactly what that Close closed, picks them again, and reports a refusal in its words', async () => {
  if (!hasDom) return;
  draw();
  closeThree();
  await answerAll([
    [200, { ok: true, key: key(7), url: '' }],
    [409, { error: 'It is already merged.', code: 'pull_merged' }],
    [200, { ok: true, key: WEB20, url: '' }],
  ]);
  // Clear leaves select mode: Undo still works and brings it back.
  click($('[data-pr-clear]')!);
  act(() => toasts[0]!.toast.onUndo!());
  expect(sent.slice(3).map((s) => `${s.route} ${s.key}`)).toEqual([`reopen ${key(7)}`]);
  expect($('[data-pr-running="reopen"]')!.textContent).toBe('Reopening 1 of 2…');
  await answerAll([
    [200, { ok: true, key: key(7), url: '' }],
    [502, { error: 'state cannot be changed. The head branch was deleted.', code: 'pull_close_failed' }],
  ]);
  expect(sent.slice(3).map((s) => `${s.route} ${s.key}`)).toEqual([`reopen ${key(7)}`, `reopen ${WEB20}`]);
  expect(rows('reopened')).toEqual(['Reopened #7.']);
  expect(rows('refused')).toEqual(['#20 state cannot be changed. The head branch was deleted.']);
  expect(tile(key(7))).not.toBeNull();
  expect(pickedTiles()).toEqual([key(7)]);
  expect(toasts.at(-1)!.toast).toMatchObject({ lead: 'Reopened 1' });
  expect(toasts.at(-1)!.toast.onUndo).toBeUndefined();
  await settle();
  expect(sent).toHaveLength(5);
});
