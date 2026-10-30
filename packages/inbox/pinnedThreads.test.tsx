/**
 * Pinned threads (approval "inbox-pinned-threads", variant Count) as the
 * window draws them: the whole window (InboxApp) over a REAL Inbox server in
 * a temp data dir (its own process, tests/helpers/inbox-dom-server.ts). What
 * is proved: Pin thread leads the row menu and puts the thread in a Pinned
 * section above Projects (and a pin on its list row); the header ⋯
 * menu's Pin thread and Unpin thread pin and unpin (no pin button in the header); the pinned row's state (a Stopped pill, a question count)
 * and its name; a click opens the thread and keeps the project filter; the
 * pinned row's ⋯ offers Unpin, Move up, Move down and Copy link, and the
 * moves change the order with focus kept on that row's ⋯; Unpin's toast and
 * its Undo putting the pin back at its old place (a restore of that one
 * thread with its original pinned_at); a quick pin-then-unpin on the
 * header menu sending both in order; an archived thread stays
 * pinned and opens as an archived thread; no section when nothing is pinned;
 * pinning from the header menu while Pinned is closed opens it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { movePin, pinnedState, unpinnedWhere } = await import('./pins');
const { SIDEBAR_CLOSED_COOKIE } = await import('./sidebarSections');
const { storage, setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
// Which sidebar sections are closed persists through Plannotator's storage (cookies in the app); a map stands in here.
const stored = new Map<string, string>();

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
type World = { project: string; stopped: string; waiting: string; mixed: string; same: string; picked: string; filed: string };
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedClipboard: PropertyDescriptor | undefined;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let clipboard: string[] = [];
let serverSession = '';

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function serverPins(): Promise<string[]> {
  const model = JSON.parse((await loopback('/api/inbox/threads?archived=exclude')).text) as { serverSession: string; pins?: InboxListRow[] };
  serverSession = model.serverSession;
  return (model.pins ?? []).map((row) => row.thread_id);
}

async function serverPinnedAt(threadId: string): Promise<string | null> {
  const model = JSON.parse((await loopback('/api/inbox/threads?archived=exclude')).text) as { pins?: InboxListRow[] };
  return model.pins?.find((row) => row.thread_id === threadId)?.pinned_at ?? null;
}

async function serverPin(threadId: string, pinned: boolean) {
  const answer = await loopback(`/api/inbox/threads/${threadId}/pin`, 'POST', JSON.stringify({ serverSession, pinned }));
  expect(answer.status).toBe(200);
}

const TESTS = 10;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-pins-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const lines = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await lines.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  const started = JSON.parse(line.trim()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(async () => {
  if (!hasDom) return;
  ids = worlds.shift()!;
  // Pins are the Inbox's, not one project's: every test starts with none.
  for (const id of await serverPins()) await serverPin(id, false);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void clipboard.push(text) } });
  posted = [];
  clipboard = [];
  window.location.hash = '';
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  document.body.innerHTML = '';
  resetStorageBackend();
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash = '') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!document.querySelector('.ib-projrow'), 'the sidebar');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

const rowButton = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`);
const pinnedSection = () => document.querySelector<HTMLElement>('[data-pinned-section]');
const pinnedOrder = () => [...document.querySelectorAll<HTMLElement>('[data-pinned-row]')].map((el) => el.getAttribute('data-pinned-row')!);
const pinnedRow = (id: string) => document.querySelector<HTMLElement>(`[data-pinned-row="${id}"]`);
const pinMore = (id: string) => document.querySelector<HTMLElement>(`[data-pin-more="${id}"]`);
const pinMenu = () => document.querySelector<HTMLElement>('[data-pin-menu]');
const rowMenu = () => document.querySelector<HTMLElement>('[data-row-menu]');
const toast = () => document.querySelector<HTMLElement>('[data-inbox-toast]');

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

const threadMenu = () => document.querySelector<HTMLElement>('[data-thread-menu]');

/** The open thread's header ⋯ menu, opened; its first item is the pin. */
async function openThreadMenu() {
  await until(() => !!document.querySelector('[data-thread-more]'), 'the header ⋯');
  await press(document.querySelector<HTMLElement>('[data-thread-more]')!);
  await until(() => !!threadMenu()?.querySelector('[data-thread-pin-item]'), 'the thread menu');
  return threadMenu()!.querySelector<HTMLElement>('[data-thread-pin-item]')!;
}

/** Choose the header menu's pin item; the label it had says which way it went. */
async function chooseThreadPin() {
  const item = await openThreadMenu();
  const label = item.textContent;
  await act(async () => item.click());
  await until(() => !threadMenu(), 'the menu to close');
  return label;
}

async function openPinMenu(id: string) {
  await press(pinMore(id)!);
  await until(() => pinMenu()?.getAttribute('data-pin-menu') === id, 'the pinned row menu');
}

async function choosePin(action: string) {
  await act(async () => {
    pinMenu()!.querySelector<HTMLElement>(`[data-pin-action="${action}"]`)!.click();
  });
}

test('the order a move makes, the state a pinned row shows, and the toast words', () => {
  expect(movePin(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
  expect(movePin(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  expect(movePin(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
  expect(movePin(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  const row = (over: Record<string, unknown>) =>
    ({ section: 'waiting', unread: true, unseen: 1, resolved_at: null, back_from_archive: false, read_at: null, questions: { open: 3, holds_up: [] }, ...over }) as unknown as InboxListRow;
  expect(pinnedState(row({}))).toMatchObject({ kind: 'wait', n: 3, words: '3 questions', calm: false });
  expect(pinnedState(row({ section: 'stopped' }))).toMatchObject({ kind: 'stop', words: 'Stopped' });
  expect(pinnedState(row({ section: 'holding', questions: { open: 2, holds_up: ['a', 'b'] } }))).toMatchObject({ kind: 'hold', n: 2, words: 'Holds up 2' });
  // The list row's count words: an action item named beside the questions.
  expect(pinnedState(row({ questions: { open: 2, actions: 1, holds_up: [] } }))).toMatchObject({ kind: 'wait', n: 2, words: '1 question, 1 action item' });
  expect(pinnedState(row({ questions: { open: 1, actions: 1, holds_up: [] } }))).toMatchObject({ words: '1 action item' });
  expect(pinnedState(row({ section: 'new' }))).toMatchObject({ kind: 'new', words: 'New' });
  // The dot follows unseen agent news, not `unread`: news seen with picks still to send is no dot...
  expect(pinnedState(row({ section: 'new', unread: true, unseen: 0, answered_not_sent: true }))).toMatchObject({ kind: 'quiet', words: 'Draft', calm: true });
  // ...and unseen news gets it even where `unread` is off (a row in New for a draft too).
  expect(pinnedState(row({ section: 'new', unread: false, unseen: 2 }))).toMatchObject({ kind: 'new', words: 'New', calm: false });
  // Archived is the list's own rule: a thread that came back is placed as an open one.
  expect(pinnedState(row({ section: 'new', resolved_at: 'x', back_from_archive: true }))).toMatchObject({ kind: 'new' });
  expect(pinnedState(row({ section: 'quiet', unread: false, read_at: 'x' }))).toMatchObject({ kind: 'quiet', words: 'Read', calm: true });
  expect(pinnedState(row({ section: 'quiet', unread: false, resolved_at: 'x' }))).toMatchObject({ kind: 'archived', words: 'Archived', calm: true });
  expect(unpinnedWhere(row({}))).toBe('Still in Waiting on you');
  expect(unpinnedWhere(row({ resolved_at: 'x' }))).toBe('Still in Archived');
});

test.skipIf(!hasDom)('no section when nothing is pinned; Pin thread leads the row menu and the thread appears in Pinned, above Projects', async () => {
  await renderApp();
  expect(pinnedSection()).toBeNull();
  expect(document.querySelector('.ib-side-sec-l')!.textContent).toBe('Projects');
  await act(async () => {
    rowButton(ids.stopped)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => rowMenu()?.getAttribute('data-row-menu') === ids.stopped, 'the row menu');
  const items = [...rowMenu()!.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());
  expect(items[0]).toBe('Pin thread');
  // Its own group: a separator right after it.
  expect(rowMenu()!.querySelector('[data-row-action="pin"] + [role="separator"]')).not.toBeNull();
  await act(async () => {
    rowMenu()!.querySelector<HTMLElement>('[data-row-action="pin"]')!.click();
  });
  await until(() => pinnedOrder().length === 1, 'the pinned row');
  expect(await serverPins()).toEqual([ids.stopped]);
  // Above Projects, labelled by its header, Pinned.
  const labels = [...document.querySelectorAll('.ib-side-sec-l')].map((el) => el.textContent);
  expect(labels).toEqual(['Pinned', 'Projects']);
  expect(pinnedSection()!.getAttribute('aria-labelledby')).toBe(document.querySelector('[data-sidebar-section="pinned"]')!.id);
  // The Count variant: Stopped as a pill; the name says subject, project, state; bold (it waits on the person).
  const pin = pinnedRow(ids.stopped)!;
  expect(pin.querySelector('.ib-spill')!.textContent).toBe('Stopped');
  expect(pin.getAttribute('aria-label')).toMatch(/, billing-\d+, Stopped$/);
  expect(pin.classList.contains('ib-u')).toBe(true);
  // The list row keeps its place and gains the pin; its name ends ", pinned". No toast for a pin.
  await until(() => !!rowButton(ids.stopped)?.querySelector('[data-pin-mark]'), 'the pin on the list row');
  expect(rowButton(ids.stopped)!.textContent).toMatch(/, pinned$/);
  expect(toast()).toBeNull();
  // The menu now offers Unpin thread.
  await act(async () => {
    rowButton(ids.stopped)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => !!rowMenu()?.querySelector('[data-row-action="unpin"]'), 'Unpin thread');
});

test.skipIf(!hasDom)("the header ⋯ menu's Pin thread pins and Unpin thread unpins the open thread, and the header has no pin button", async () => {
  await renderApp(`#thread=${ids.waiting}`);
  await until(() => !!document.querySelector('[data-thread-more]'), 'the header ⋯');
  expect(document.querySelector('[data-pin-toggle]')).toBeNull();
  // First in the menu, in its own group, as the row menu leads with it.
  const first = await openThreadMenu();
  expect(threadMenu()!.querySelector('[role="menuitem"]')).toBe(first);
  expect(first.nextElementSibling?.getAttribute('role')).toBe('separator');
  await act(async () => first.click());
  await until(() => !threadMenu(), 'the menu to close');
  await until(() => pinnedOrder().includes(ids.waiting), 'the pinned row');
  // The open thread's pinned row wears the selection pill and aria-current, not the current page's card.
  expect(pinnedRow(ids.waiting)!.getAttribute('aria-current')).toBe('true');
  expect(pinnedRow(ids.waiting)!.classList.contains('ib-on')).toBe(true);
  // A question count, as a project's.
  expect(pinnedRow(ids.waiting)!.querySelector('.ib-n')!.textContent).toBe('1');
  expect(await chooseThreadPin()).toBe('Unpin thread');
  await until(() => pinnedSection() === null, 'the section to go');
  await until(() => !!toast(), 'the Unpinned toast');
  expect(toast()!.textContent).toContain('Unpinned');
  expect(toast()!.textContent).toContain('Still in Waiting on you');
});

test.skipIf(!hasDom)('pinning from the header menu while Pinned is closed opens Pinned, so the new pin is seen', async () => {
  await serverPin(ids.stopped, true);
  storage.setItem(SIDEBAR_CLOSED_COOKIE, 'pinned');
  await renderApp(`#thread=${ids.waiting}`);
  const header = () => document.querySelector<HTMLElement>('[data-sidebar-section="pinned"]')!;
  await until(() => pinnedSection() !== null, 'Pinned');
  // Closed: the pin that is not on screen is not drawn; its Stopped counts on the header.
  expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(pinnedOrder()).toEqual([]);
  expect(header().querySelector('.ib-n')!.textContent).toContain('1');
  expect(await chooseThreadPin()).toBe('Pin thread');
  await until(() => pinnedOrder().length === 2, 'both pinned rows');
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(storage.getItem(SIDEBAR_CLOSED_COOKIE)).toBeNull();
});

test.skipIf(!hasDom)("a quick pin-then-unpin from the header menu sends both, in order, and ends unpinned", async () => {
  await renderApp(`#thread=${ids.mixed}`);
  // Two choices before the first request answers: the second is not lost.
  expect(await chooseThreadPin()).toBe('Pin thread');
  expect(await chooseThreadPin()).toBe('Unpin thread');
  await until(() => posted.filter((p) => p.path.endsWith(`/threads/${ids.mixed}/pin`)).length === 2, 'both requests');
  expect(posted.filter((p) => p.path.endsWith(`/threads/${ids.mixed}/pin`)).map((p) => p.body.pinned)).toEqual([true, false]);
  await until(() => !!toast(), 'the Unpinned toast');
  expect(await serverPins()).toEqual([]);
  expect(pinnedSection()).toBeNull();
  expect((await openThreadMenu()).textContent).toBe('Pin thread');
});

test.skipIf(!hasDom)('a click opens the thread and keeps the project filter; the open thread\'s pinned row does nothing', async () => {
  for (const id of [ids.stopped, ids.waiting]) await serverPin(id, true);
  await renderApp(`#project=${ids.project}`);
  await until(() => pinnedOrder().length === 2, 'the pinned rows');
  await act(async () => pinnedRow(ids.waiting)!.click());
  await until(() => window.location.hash.includes(`thread=${ids.waiting}`), 'the thread to open');
  expect(window.location.hash).toContain(`project=${ids.project}`);
  const hash = window.location.hash;
  await act(async () => pinnedRow(ids.waiting)!.click());
  expect(window.location.hash).toBe(hash);
});

test.skipIf(!hasDom)("the pinned row's ⋯: Move up and Move down reorder with focus kept; Copy link copies the thread's address", async () => {
  for (const id of [ids.stopped, ids.waiting, ids.mixed]) await serverPin(id, true);
  await renderApp();
  await until(() => pinnedOrder().length === 3, 'the pinned rows');
  expect(pinnedOrder()).toEqual([ids.stopped, ids.waiting, ids.mixed]);
  const more = pinMore(ids.stopped)!;
  expect(more.getAttribute('aria-haspopup')).toBe('menu');
  expect(pinnedRow(ids.stopped)!.contains(more)).toBe(false);
  await openPinMenu(ids.stopped);
  const items = [...pinMenu()!.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());
  expect(items).toEqual(['Unpin', 'Move up', 'Move down', 'Copy link']);
  // The first pin cannot move up.
  expect(pinMenu()!.querySelector('[data-pin-action="up"]')!.hasAttribute('data-disabled')).toBe(true);
  await choosePin('down');
  await until(() => pinnedOrder()[1] === ids.stopped, 'the move down');
  expect(await serverPins()).toEqual([ids.waiting, ids.stopped, ids.mixed]);
  await until(() => document.activeElement === pinMore(ids.stopped), "focus on the moved row's ⋯");
  await openPinMenu(ids.mixed);
  expect(pinMenu()!.querySelector('[data-pin-action="down"]')!.hasAttribute('data-disabled')).toBe(true);
  await choosePin('up');
  await until(() => pinnedOrder()[1] === ids.mixed, 'the move up');
  expect(await serverPins()).toEqual([ids.waiting, ids.mixed, ids.stopped]);
  await openPinMenu(ids.mixed);
  await choosePin('copy-link');
  await until(() => clipboard.length === 1, 'the copy');
  expect(clipboard[0]).toBe(`http://localhost:${port}/#thread=${ids.mixed}`);
});

test.skipIf(!hasDom)("Unpin from the pinned row's ⋯: the toast, focus on the next pin, and Undo puts it back at its old place", async () => {
  for (const id of [ids.stopped, ids.waiting, ids.mixed]) await serverPin(id, true);
  const firstPinnedAt = await serverPinnedAt(ids.waiting);
  expect(firstPinnedAt).toEqual(expect.any(String));
  await renderApp();
  await until(() => pinnedOrder().length === 3, 'the pinned rows');
  await openPinMenu(ids.waiting);
  await choosePin('unpin');
  await until(() => pinnedOrder().length === 2, 'the unpin');
  await until(() => !!toast(), 'the toast');
  expect(toast()!.textContent).toContain('Unpinned');
  await until(() => document.activeElement === pinMore(ids.mixed), "focus on the next pin's ⋯");
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(() => pinnedOrder().length === 3, 'the pin back');
  expect(pinnedOrder()).toEqual([ids.stopped, ids.waiting, ids.mixed]);
  expect(await serverPins()).toEqual([ids.stopped, ids.waiting, ids.mixed]);
  // The Undo restores that one thread, with the time it was first pinned, never a remembered whole order.
  const undo = posted.find((p) => p.path === '/api/inbox/pins')!;
  expect(undo.body.order).toBeUndefined();
  expect(undo.body.restore).toEqual({ thread_id: ids.waiting, index: 1, pinned_at: firstPinnedAt });
  expect(await serverPinnedAt(ids.waiting)).toBe(firstPinnedAt);
});

test.skipIf(!hasDom)('an archived thread stays pinned, shown archived, and opens as an archived thread', async () => {
  await serverPin(ids.same, true);
  await renderApp();
  await until(() => pinnedOrder().length === 1, 'the pinned row');
  await act(async () => {
    rowButton(ids.same)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => !!rowMenu(), 'the row menu');
  await act(async () => {
    rowMenu()!.querySelector<HTMLElement>('[data-row-action="archive"]')!.click();
  });
  await until(() => !rowButton(ids.same), 'the row to leave the list');
  await until(() => pinnedRow(ids.same)?.getAttribute('data-state') === 'archived', 'the pinned row shown archived');
  expect(pinnedRow(ids.same)!.getAttribute('aria-label')).toMatch(/Archived$/);
  expect(pinnedRow(ids.same)!.classList.contains('ib-calm')).toBe(true);
  await act(async () => pinnedRow(ids.same)!.click());
  await until(() => window.location.hash.includes(`thread=${ids.same}`), 'the thread');
  await until(async () => (await openThreadMenu()).textContent === 'Unpin thread', 'the thread open, pinned');
});

test.skipIf(!hasDom)('many pins: every one drawn in the shared scroll area with Projects', async () => {
  for (const id of [ids.stopped, ids.waiting, ids.mixed, ids.same, ids.picked, ids.filed]) await serverPin(id, true);
  await renderApp();
  await until(() => pinnedOrder().length === 6, 'the pinned rows');
  const scroll = document.querySelector<HTMLElement>('.ib-sidescroll')!;
  expect(scroll.contains(pinnedSection())).toBe(true);
  expect(scroll.querySelector('.ib-projs')).not.toBeNull();
});
