/**
 * Bulk Close on the Pull requests board (approval "inbox-pr-board-bulk": Close shows the count with Undo, no confirm).
 * What regresses:
 *  - Close asking first, or closing several at once instead of one after another;
 *  - a refusal not reported in the host's words, sent again by itself, or leaving the selection;
 *  - closed PRs staying in Open, or a toast without the count and Undo;
 *  - Undo reopening anything but what that Close closed, or not picking them again and saying how each went;
 *  - on a phone, the toast covering the pick sheet's buttons;
 *  - (approval "inbox-pr-board-close-safe") Close anywhere but last of the actions, inside the field's box, or without
 *    its warning look; Merge's note inside the bar; a toast that doesn't name what closed; the Undo line under the bar
 *    not outliving another toast, a pick, select mode or the board leaving the screen, outliving the server's window,
 *    reopening anything but what that Close closed, or reopening it twice; Undo replacing picks made since, staying
 *    silent on Merged, or leaving the focus nowhere; the focus not on the new line's Undo after Close;
 *  - a linked machine's PR closed or reopened here, or its Undo going anywhere but the machine that closed it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No gh: the window's fetch is stubbed.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { INBOX_PULL_REOPEN_WINDOW_MS } from '@plannotator/core/inbox-types';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from '../components/Toast';
import type { SheetPageProps } from './SheetPage';

const hasDom = typeof document !== 'undefined';
const { SheetPage } = (hasDom ? await import('./SheetPage') : {}) as typeof import('./SheetPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { forgetClosed } = (hasDom ? await import('./closedUndo') : {}) as typeof import('./closedUndo');
const { forgetHiddenChanges } = (hasDom ? await import('../pulls/hiddenPulls') : {}) as typeof import('../pulls/hiddenPulls');

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
let sent: { route: string; key: string; url: string; answer: (status: number, body: Record<string, unknown>) => void }[] = [];
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
      sent.push({ route, key: body.key, url: String(url), answer: (status, answer) => resolve(Response.json(answer, { status })) });
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  jest.useRealTimers();
  act(() => forgetClosed());
  forgetHiddenChanges();
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
  const render = (p: SheetPageProps) => act(() => root!.render(<div className="pn-inbox"><SidebarProvider><SheetPage {...p} /></SidebarProvider></div>));
  render(props);
  return { refreshed, redraw: (more: Partial<SheetPageProps>) => render({ ...props, ...more }) };
}

const click = (el: HTMLElement) => act(() => el.click());
const tile = (k: string) => $(`[data-pr-tile="${k}"]`);
const rows = (kind: string) => $$(`[data-pr-merge-row="${kind}"]`).map((r) => r.textContent);
const pickedTiles = () => $$('[data-pr-tile][aria-checked="true"]').map((t) => t.dataset.prTile).sort();
// Microtasks only, so it settles under fake timers too (the stubbed answers resolve without a timer).
const settle = () => act(async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
});
const line = () => $$('[data-pr-closed-line]').map((l) => l.textContent);
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
  // Done stays where it is mid-run, but can't be pressed.
  expect($('[data-pr-select="done"]')!.hasAttribute('disabled')).toBe(true);
  await answerAll([
    [200, { ok: true, key: key(7), url: '' }],
    [409, { error: 'It is already merged.', code: 'pull_merged' }],
    [200, { ok: true, key: WEB20, url: '' }],
  ]);

  expect(sent.map((s) => `${s.route} ${s.key}`)).toEqual([`close ${key(7)}`, `close ${key(8)}`, `close ${WEB20}`]);
  // What closed is said once, by the Undo line under the bar (across two repositories, each number after its name).
  expect(rows('closed')).toEqual([]);
  expect(line()).toEqual(['Closed 2: ledger #7 · web #20.Undo']);
  expect(rows('refused')).toEqual(['#8 It is already merged.']);
  // What closed left Open; the refusal stays picked.
  expect(tile(key(7))).toBeNull();
  expect(tile(WEB20)).toBeNull();
  expect(pickedTiles()).toEqual([key(8)]);
  expect(refreshed).toEqual([1]);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.toast).toMatchObject({ lead: 'Closed 2', detail: 'ledger #7 · web #20', noKey: true });
  expect(toasts[0]!.ms).toBe(8_000);
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
  // Done leaves select mode: Undo still works and brings it back.
  click($('[data-pr-select="done"]')!);
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
  // The one the forge refused for now stays on the line, for the rest of the window; either Undo tries that one only.
  expect(line()).toEqual(['Closed #20 Change 20.Undo']);
  act(() => toasts[0]!.toast.onUndo!());
  expect(sent.slice(5).map((s) => `${s.route} ${s.key}`)).toEqual([`reopen ${WEB20}`]);
  await answerAll([[200, { ok: true, key: WEB20, url: '' }]]);
  expect(line()).toEqual([]);
  expect(sent).toHaveLength(6);
});

test("a linked machine's PR is closed there and its Undo reopens it there; an asleep machine's refusal is said in its words", async () => {
  if (!hasDom) return;
  const MINI = 'ibx_01K0000000000000000000000B';
  draw({ model: { ...MODEL, pulls: MODEL.pulls.map((p) => (p.number === 7 || p.number === 8 ? { ...p, machine: MINI } : p)) } });
  closeThree();
  await answerAll([
    [200, { ok: true, key: key(7), url: '' }],
    [503, { error: 'Mini cannot be reached now.', code: 'machine_offline' }],
    [200, { ok: true, key: WEB20, url: '' }],
  ]);
  expect(sent.map((s) => s.url)).toEqual([`/api/inbox/m/${MINI}/pulls/close`, `/api/inbox/m/${MINI}/pulls/close`, '/api/inbox/pulls/close']);
  expect(rows('refused')).toEqual(['#8 Mini cannot be reached now.']);
  act(() => toasts[0]!.toast.onUndo!());
  await answerAll([
    [200, { ok: true, key: key(7), url: '' }],
    [200, { ok: true, key: WEB20, url: '' }],
  ]);
  expect(sent.slice(3).map((s) => s.url)).toEqual([`/api/inbox/m/${MINI}/pulls/reopen`, '/api/inbox/pulls/reopen']);
  expect(rows('reopened')).toEqual(['Reopened #7, #20.']);
});

test("a phone's pick sheet lifts the window's toast above it while it shows, and lets it go after", () => {
  if (!hasDom) return;
  draw({ phone: true });
  const inbox = $('.pn-inbox')!;
  click($('[data-pr-select="select"]')!);
  click(tile(key(7))!);
  expect($('[data-pr-actions] [data-pr-close]')).not.toBeNull();
  expect(inbox.hasAttribute('data-prs-sheet')).toBe(true);
  expect(inbox.style.getPropertyValue('--ib-prs-sheet-h')).toMatch(/^\d+px$/);
  click($('[data-pr-select="done"]')!);
  expect($('[data-pr-actions]')).toBeNull();
  expect(inbox.hasAttribute('data-prs-sheet')).toBe(false);
  expect(inbox.style.getPropertyValue('--ib-prs-sheet-h')).toBe('');
});

test("a phone's Close that all went leaves no empty sheet behind: the Undo line says it", async () => {
  if (!hasDom) return;
  draw({ phone: true });
  click($('[data-pr-select="select"]')!);
  click(tile(key(7))!);
  click($('[data-pr-close]')!);
  await answerAll([[200, { ok: true, key: key(7), url: '' }]]);
  expect($('.ib-prs-picksheet')).toBeNull();
  expect(line()).toEqual(['Closed #7 Change 7.Undo']);
});

const bar = () => $('.ib-prs-bar')!;
/** The bar's actions, in order, by what each is. */
const acts = () =>
  [...$('.ib-prs-acts')!.children].map((el) => ['data-pr-picked', 'data-pr-merge', 'data-pr-review', 'data-pr-hide', 'data-pr-close'].find((a) => el.hasAttribute(a)));

test('Close is the last action, in the warning look, after the field and outside it, with Merge and without; Merge\'s note is under the bar', () => {
  if (!hasDom) return;
  draw();
  click($('[data-pr-select="select"]')!);
  const field = $('.ib-prs-field')!;
  // #7 can merge: Merge shows.
  click(tile(key(7))!);
  expect(acts()).toEqual(['data-pr-picked', 'data-pr-merge', 'data-pr-review', 'data-pr-hide', 'data-pr-close']);
  const close = $('[data-pr-close]')!;
  expect(field.contains(close)).toBe(false);
  expect(field.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(close.nextElementSibling).toBeNull();
  expect($('.ib-prs-acts')!.nextElementSibling).toBe($('[data-pr-select="done"]'));
  expect($$('[data-danger]')).toEqual([close]);
  // #8 alone can't (failing checks): no Merge, Close still last; the why is on its own line under the bar.
  click(tile(key(7))!);
  click(tile(key(8))!);
  expect(acts()).toEqual(['data-pr-picked', 'data-pr-review', 'data-pr-hide', 'data-pr-close']);
  expect($('.ib-prs-acts')!.nextElementSibling).toBe($('[data-pr-select="done"]'));
  const note = $('[data-pr-merge-hint]')!;
  expect(note.textContent).toBe('#8 can’t merge now: its checks are failing.');
  expect(bar().contains(note)).toBe(false);
  expect(note.closest('.ib-prs-under')!.previousElementSibling).toBe(bar());
});

test('one PR closed: the toast names its number and title, and the line keeps Undo past another toast, the picks, Done and the board leaving', async () => {
  if (!hasDom) return;
  draw();
  click($('[data-pr-select="select"]')!);
  click(tile(key(7))!);
  click($('[data-pr-close]')!);
  await answerAll([[200, { ok: true, key: key(7), url: '' }]]);
  expect(toasts[0]!.toast).toMatchObject({ lead: 'Closed #7', detail: 'Change 7' });
  expect(line()).toEqual(['Closed #7 Change 7.Undo']);
  // Said once, by the toast: the line is no live region, and its Undo is described by its words.
  expect($('[data-pr-closed-lines]')!.getAttribute('aria-live')).toBeNull();
  const undoNow = $('[data-pr-closed-undo]')!;
  expect(document.getElementById(undoNow.getAttribute('aria-describedby')!)!.textContent).toBe('Closed #7 Change 7.');
  // Another pick, then another toast (Hide's, which also leaves select mode), the board gone and back: the line stays.
  click(tile(key(8))!);
  expect(line()).toEqual(['Closed #7 Change 7.Undo']);
  click($('[data-pr-hide]')!);
  await settle();
  expect(toasts.map((t) => t.toast.lead)).toEqual(['Closed #7', 'Hid #8']);
  expect($('[data-pr-select="select"]')).not.toBeNull();
  expect(line()).toEqual(['Closed #7 Change 7.Undo']);
  act(() => root!.unmount());
  host!.remove();
  draw();
  expect(line()).toEqual(['Closed #7 Change 7.Undo']);
  // Its Undo, by the keyboard: a button, which reopens exactly #7, once; the toast's Undo after it sends nothing.
  const undo = $('[data-pr-closed-undo]')!;
  expect(undo.tagName).toBe('BUTTON');
  click(undo);
  expect(sent.filter((s) => s.route === 'reopen').map((s) => s.key)).toEqual([key(7)]);
  await answerAll([[200, { ok: true, key: key(7), url: '' }]]);
  expect(line()).toEqual([]);
  act(() => toasts[0]!.toast.onUndo!());
  await settle();
  expect(sent.filter((s) => s.route === 'reopen')).toHaveLength(1);
});

test("the line goes when the server's window ends; a reopen the server refuses as too late says its words and is not offered again", async () => {
  if (!hasDom) return;
  jest.useFakeTimers();
  draw();
  click($('[data-pr-select="select"]')!);
  click(tile(key(7))!);
  click(tile(key(9))!);
  click($('[data-pr-close]')!);
  await answerAll([
    [200, { ok: true, key: key(7), url: '' }],
    [200, { ok: true, key: key(9), url: '' }],
  ]);
  // In the order closed, which is the order on screen.
  expect(sent.map((s) => s.key)).toEqual([key(9), key(7)]);
  expect(line()).toEqual(['Closed 2: #9, #7.Undo']);
  act(() => jest.advanceTimersByTime(INBOX_PULL_REOPEN_WINDOW_MS - 1_000));
  expect(line()).toHaveLength(1);
  // A press just before the end that the server takes as past its window: its own words, and the line is gone.
  click($('[data-pr-closed-undo]')!);
  const late = 'Only a pull request closed here in the last 5 minutes can be reopened here.';
  await answerAll([
    [409, { error: late, code: 'reopen_not_closed_here' }],
    [409, { error: late, code: 'reopen_not_closed_here' }],
  ]);
  expect(rows('refused')).toEqual([`#9 ${late}`, `#7 ${late}`]);
  expect(line()).toEqual([]);

  // Another Close: its line ends with the window, to the millisecond.
  click(tile(key(8))!);
  click($('[data-pr-close]')!);
  await answerAll([[200, { ok: true, key: key(8), url: '' }]]);
  expect(line()).toHaveLength(1);
  act(() => jest.advanceTimersByTime(INBOX_PULL_REOPEN_WINDOW_MS - 1));
  expect(line()).toHaveLength(1);
  act(() => jest.advanceTimersByTime(1));
  expect(line()).toEqual([]);
});

test('Undo leaves picks made since alone; with none, it picks what reopened; the focus goes to the line\'s Undo after Close, to Done after Undo', async () => {
  if (!hasDom) return;
  draw();
  click($('[data-pr-select="select"]')!);
  click(tile(key(7))!);
  click($('[data-pr-close]')!);
  await answerAll([[200, { ok: true, key: key(7), url: '' }]]);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.activeElement).toBe($('[data-pr-closed-undo]'));
  // Something else picked since: Undo reopens #7 and leaves the picks as they are.
  click(tile(key(9))!);
  click($('[data-pr-closed-undo]')!);
  await answerAll([[200, { ok: true, key: key(7), url: '' }]]);
  expect(rows('reopened')).toEqual(['Reopened #7.']);
  expect(pickedTiles()).toEqual([key(9)]);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.activeElement).toBe($('[data-pr-select="done"]'));
  // Nothing picked: what reopened is picked again.
  click($('[data-pr-close]')!);
  await answerAll([[200, { ok: true, key: key(9), url: '' }]]);
  expect(pickedTiles()).toEqual([]);
  click($('[data-pr-closed-undo]')!);
  await answerAll([[200, { ok: true, key: key(9), url: '' }]]);
  expect(pickedTiles()).toEqual([key(9)]);
});

test('Undo pressed on the Merged view goes back to Open, where a refusal shows in its words', async () => {
  if (!hasDom) return;
  const views: string[] = [];
  draw({ onView: (v) => views.push(v) });
  click($('[data-pr-select="select"]')!);
  click(tile(key(7))!);
  click($('[data-pr-close]')!);
  await answerAll([[200, { ok: true, key: key(7), url: '' }]]);
  act(() => root!.unmount());
  host!.remove();
  const { redraw } = draw({ view: 'merged', onView: (v) => views.push(v) });
  click($('[data-pr-closed-undo]')!);
  expect(views).toEqual(['open']);
  redraw({ view: 'open' });
  const late = 'Only a pull request closed here in the last 5 minutes can be reopened here.';
  await answerAll([[409, { error: late, code: 'reopen_not_closed_here' }]]);
  expect(rows('refused')).toEqual([`#7 ${late}`]);
});
