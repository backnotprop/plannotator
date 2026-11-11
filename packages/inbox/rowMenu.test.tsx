import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { resetListGroupsForTests } from './listGroups';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { threadLink, rowMenuActions } = await import('./rowMenu');
const { ThreadRowMenu } = (hasDom ? await import('./components/RowMenu') : {}) as typeof import('./components/RowMenu');

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
let fetched: string[] = [];
let posted: { path: string; body: Record<string, unknown> }[] = [];
let clipboard: string[] = [];
let clipboardFails = false;

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

async function serverSections(): Promise<Map<string, string>> {
  const model = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] };
  return new Map(model.sections.flatMap((s) => s.threads.map((r) => [r.thread_id, s.id] as const)));
}

const TESTS = 22;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-rowmenu-dom-')));
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

beforeEach(() => {
  if (!hasDom) return;
  ids = worlds.shift()!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    else fetched.push(path);
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (clipboardFails) throw new Error('denied');
        clipboard.push(text);
      },
    },
  });
  // The legacy fallback fails too when the clipboard is denied (happy-dom has no copy command).
  (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
  fetched = [];
  posted = [];
  clipboard = [];
  clipboardFails = false;
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  setSystemTime();
  act(() => root?.unmount());
  host?.remove();
  resetListGroupsForTests();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  document.body.innerHTML = '';
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
  await until(() => !!rowButton(ids.waiting), 'the list');
  await until(() => fetched.some((path) => path.split('?')[0] === '/api/inbox/settings'), 'the settings');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

const rowButton = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`);
const rowWrap = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-row="${id}"]`);
const menu = () => document.querySelector<HTMLElement>('[data-row-menu]');
const items = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((el) => el.textContent?.trim());
const item = (action: string) => menu()?.querySelector<HTMLElement>(`[data-row-action="${action}"]`) ?? null;
const toast = () => document.querySelector<HTMLElement>('[data-inbox-toast]');

async function rightClick(el: HTMLElement, init: MouseEventInit & { pointerType?: string } = {}) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200, ...init }));
  });
}

async function openMenu(id: string) {
  await rightClick(rowButton(id)!);
  await until(() => menu()?.getAttribute('data-row-menu') === id, 'the menu');
}

async function choose(action: string) {
  const el = item(action)!;
  await act(async () => {
    el.click();
  });
}

test('the link is the Inbox one address plus #thread=, and the items follow the row', () => {
  expect(threadLink('msg_1', { url: 'http://localhost:4321/', via: 'local' }, 'http://127.0.0.1:4321')).toBe('http://localhost:4321/#thread=msg_1');
  expect(threadLink('msg_1', { url: 'http://localhost:4321/', via: 'tailnet' }, 'https://box.ts.net:4321')).toBe('https://box.ts.net:4321/#thread=msg_1');
  expect(threadLink('msg_1', null, 'http://localhost:4321')).toBe('http://localhost:4321/#thread=msg_1');
  expect(threadLink('msg_1', { url: 'http://localhost:4321/', via: 'local' }, 'http://127.0.0.1:4321', 'msg_2')).toBe('http://localhost:4321/#thread=msg_1&msg=msg_2');
  const base = {
    thread_id: 'msg_1',
    section: 'waiting',
    unseen: 0,
    answered_not_sent: false,
    resolved_at: null,
    read_at: null,
    back_from_archive: false,
    agent_after_archive: false,
  } as unknown as Parameters<typeof rowMenuActions>[0];
  expect(rowMenuActions(base, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'read', 'archive']);
  expect(rowMenuActions({ ...base, section: 'quiet', read_at: '2026-10-20T00:00:00Z' }, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'unread', 'archive']);
  expect(rowMenuActions({ ...base, section: 'sent' }, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'archive']);
  expect(rowMenuActions({ ...base, section: 'quiet', resolved_at: '2026-10-20T00:00:00Z' }, true)).toEqual(['copy-thread', 'copy-link', 'copy-id']);
  expect(rowMenuActions(base, true, false)).toEqual(['pin', 'copy-thread', 'copy-link', 'copy-id', 'read', 'archive']);
  expect(rowMenuActions({ ...base, section: 'quiet', resolved_at: '2026-10-20T00:00:00Z' }, true, true)).toEqual(['unpin', 'copy-thread', 'copy-link', 'copy-id']);
  expect(rowMenuActions(base, true, null, null, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'snooze', 'read', 'archive']);
  const snoozedRow = { ...base, snoozed: { until: '2026-10-21T12:00:00Z', at: '2026-10-20T00:00:00Z' } } as typeof base;
  expect(rowMenuActions(snoozedRow, true, null, null, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'snooze', 'unsnooze', 'read', 'archive']);
  expect(rowMenuActions({ ...snoozedRow, section: 'quiet', resolved_at: '2026-10-20T00:00:00Z' }, true, null, null, true)).toEqual(['copy-thread', 'copy-link', 'copy-id']);
  const seen = { ...base, section: 'quiet' } as typeof base;
  expect(rowMenuActions(seen, true, null, 'new')).toEqual(['copy-thread', 'copy-link', 'copy-id', 'read', 'archive']);
  expect(rowMenuActions(seen, true, null, 'quiet')).toEqual(['copy-thread', 'copy-link', 'copy-id', 'archive']);
  expect(rowMenuActions(seen, false, null, 'new')).toEqual(['copy-thread', 'copy-link', 'copy-id', 'archive']);
  expect(rowMenuActions({ ...seen, read_at: '2026-10-20T00:00:00Z' }, true, null, 'new')).toEqual(['copy-thread', 'copy-link', 'copy-id', 'unread', 'archive']);
  expect(rowMenuActions({ ...seen, resolved_at: '2026-10-20T00:00:00Z' }, true, null, 'new')).toEqual(['copy-thread', 'copy-link', 'copy-id']);
  const read = { ...base, section: 'quiet', unread: false, sent: null } as typeof base;
  expect(rowMenuActions(read, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'mark-unread', 'archive']);
  expect(rowMenuActions({ ...read, read_at: '2026-10-20T00:00:00Z' }, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'mark-unread', 'unread', 'archive']);
  expect(rowMenuActions({ ...base, section: 'new', unseen: 1, unread: true, sent: null, read_at: '2026-10-20T00:00:00Z' } as typeof base, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'read', 'unread', 'archive']);
  expect(rowMenuActions(read, true, null, 'new')).toEqual(['copy-thread', 'copy-link', 'copy-id', 'read', 'mark-unread', 'archive']);
  expect(rowMenuActions({ ...base, unread: true, sent: null } as typeof base, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'read', 'archive']);
  expect(rowMenuActions({ ...read, sent: { at: '2026-10-20T00:00:00Z' } } as typeof base, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'archive']);
  expect(rowMenuActions({ ...read, read_at: '2026-10-20T00:00:00Z', sent: { at: '2026-10-20T00:00:00Z' } } as typeof base, true)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'unread', 'archive']);
  expect(rowMenuActions({ ...read, resolved_at: '2026-10-20T00:00:00Z' }, true)).toEqual(['copy-thread', 'copy-link', 'copy-id']);
  expect(rowMenuActions(read, false)).toEqual(['copy-thread', 'copy-link', 'copy-id', 'archive']);
});

test.skipIf(!hasDom)('a right-click opens the menu on that row, without opening the thread; Copy link writes its address', async () => {
  await renderApp();
  await openMenu(ids.waiting);
  expect(items()).toEqual(['Star thread', 'Copy thread', 'Copy link', 'Copy thread ID', 'Snooze', 'Mark read', 'Archive']);
  expect(menu()!.querySelector('[role="separator"]')).not.toBeNull();
  expect(rowWrap(ids.waiting)!.hasAttribute('data-menu')).toBe(true);
  expect(window.location.hash).not.toContain('thread=');
  expect(document.querySelector('.ib-sel')).toBeNull();
  await choose('copy-link');
  await until(() => !!toast(), 'the toast');
  expect(clipboard).toEqual([`http://localhost:${port}/#thread=${ids.waiting}`]);
  expect(toast()!.textContent).toContain('Link copied');
  expect(window.location.hash).not.toContain('thread=');
  await until(() => !rowWrap(ids.waiting)!.hasAttribute('data-menu'), 'the muted background to go');
});

test.skipIf(!hasDom)('Copy thread ID writes the id; a copy that fails says so', async () => {
  await renderApp();
  await openMenu(ids.stopped);
  await choose('copy-id');
  await until(() => toast()?.textContent?.includes('Thread ID copied') === true, 'the toast');
  expect(clipboard).toEqual([ids.stopped]);
  clipboardFails = true;
  await openMenu(ids.stopped);
  await choose('copy-link');
  await until(() => toast()?.textContent?.includes("Couldn't copy") === true, 'the failure');
  expect(clipboard).toEqual([ids.stopped]);
});

test.skipIf(!hasDom)('Copy thread on a row whose thread is not open reads it and copies its Markdown, leaving the row where it was', async () => {
  await renderApp();
  const before = (await serverSections()).get(ids.waiting);
  await openMenu(ids.waiting);
  fetched = [];
  await choose('copy-thread');
  await until(() => toast()?.textContent?.includes('Thread copied') === true, 'the toast');
  expect(fetched).toContain(`/api/inbox/threads/${ids.waiting}`);
  expect(clipboard).toHaveLength(1);
  expect(clipboard[0]).toStartWith('# ');
  expect(clipboard[0]).toContain('**Q1.** Which search index should the docs use?');
  expect(clipboard[0]).toContain('- Pagefind');
  expect(toast()!.textContent).toContain('1 message');
  expect(window.location.hash).not.toContain('thread=');
  expect((await serverSections()).get(ids.waiting)).toBe(before);
});

test.skipIf(!hasDom)('Mark read leaves the row in place, read, with its toast; in Quiet after a tidy the menu offers Mark unread, bold in place and in New after a tidy, sending nothing', async () => {
  await renderApp();
  await openMenu(ids.waiting);
  await choose('read');
  await until(() => !!toast(), 'the toast');
  expect(posted.some((p) => p.path === `/api/inbox/threads/${ids.waiting}/read`)).toBe(true);
  expect(toast()!.textContent).toContain('Marked read');
  expect(toast()!.textContent).not.toContain('Moved to Quiet');
  expect((await serverSections()).get(ids.waiting)).toBe('quiet');
  await until(() => rowButton(ids.waiting)?.classList.contains('ib-u') === false, 'the row read in place');
  expect(rowWrap(ids.waiting)?.closest('[data-section-id="waiting"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-list-refresh]')!.click());
  await until(() => !!document.querySelector('[data-section-id="quiet"] button.ib-band'), 'Quiet');
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-section-id="quiet"] button.ib-band')!.click();
  });
  await until(() => !!rowButton(ids.waiting), 'the row in Quiet');
  await openMenu(ids.waiting);
  expect(items()).toEqual(['Star thread', 'Copy thread', 'Copy link', 'Copy thread ID', 'Snooze', 'Mark unread', 'Move back', 'Archive']);
  const before = JSON.parse((await loopback(`/api/inbox/threads/${ids.waiting}`)).text) as { thread: { messages: { questions?: { state: string }[] }[] } };
  await choose('mark-unread');
  expect(posted.some((p) => p.path === `/api/inbox/threads/${ids.waiting}/mark-unread`)).toBe(true);
  await until(async () => (await serverSections()).get(ids.waiting) === 'new', 'the row back in New');
  await until(() => toast()?.textContent?.includes('Marked unread') === true, 'the toast');
  await until(() => rowButton(ids.waiting)?.classList.contains('ib-u') === true, 'the row bold in place');
  expect(rowWrap(ids.waiting)?.closest('[data-section-id="quiet"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-list-refresh]')!.click());
  await until(() => rowWrap(ids.waiting)?.closest('[data-section-id="new"]') != null, 'the row drawn in New');
  expect(rowButton(ids.waiting)!.classList.contains('ib-u')).toBe(true);
  const after = JSON.parse((await loopback(`/api/inbox/threads/${ids.waiting}`)).text) as typeof before;
  expect(after.thread.messages.length).toBe(before.thread.messages.length);
  expect(after.thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.state))).toEqual(['closed']);
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(async () => (await serverSections()).get(ids.waiting) === 'quiet', 'the row back in Quiet');
  await until(() => rowButton(ids.waiting)?.classList.contains('ib-u') === false, 'the row read again in place');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-list-refresh]')!.click());
  await until(() => rowWrap(ids.waiting)?.closest('[data-section-id="quiet"]') != null, 'the row drawn in Quiet');
  await openMenu(ids.waiting);
  await choose('unread');
  await until(async () => (await serverSections()).get(ids.waiting) === 'waiting', 'the question reopened');
  const reopened = JSON.parse((await loopback(`/api/inbox/threads/${ids.waiting}`)).text) as typeof before;
  expect(reopened.thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.state))).toEqual(['open']);
});

test.skipIf(!hasDom)('a row Mark unread brought back keeps Move back in its menu, which reopens the question its Mark read closed', async () => {
  await loopback(`/api/inbox/threads/${ids.waiting}/read`, 'POST', '{}');
  await loopback(`/api/inbox/threads/${ids.waiting}/mark-unread`, 'POST', '{}');
  await renderApp();
  await openMenu(ids.waiting);
  expect(items()).toEqual(['Star thread', 'Copy thread', 'Copy link', 'Copy thread ID', 'Snooze', 'Mark read', 'Move back', 'Archive']);
  await choose('unread');
  await until(async () => (await serverSections()).get(ids.waiting) === 'waiting', 'the question reopened');
  const thread = JSON.parse((await loopback(`/api/inbox/threads/${ids.waiting}`)).text) as { thread: { messages: { questions?: { state: string }[] }[] } };
  expect(thread.thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.state))).toEqual(['open']);
});

test.skipIf(!hasDom)('Archive shows the row archived in place, faded, with the Archived toast; it leaves at the tidy, and Undo then brings it back', async () => {
  await renderApp();
  await openMenu(ids.waiting);
  await choose('archive');
  await until(() => !!toast(), 'the toast');
  expect(posted.some((p) => p.path === `/api/inbox/messages/${ids.waiting}/resolve` && p.body.resolved === true)).toBe(true);
  expect(toast()!.textContent).toContain('Archived');
  await until(() => rowWrap(ids.waiting)?.hasAttribute('data-archived') === true, 'the row archived in place');
  expect(rowWrap(ids.waiting)!.textContent).toContain('Archived');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-list-refresh]')!.click());
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(() => !!rowButton(ids.waiting), 'the row back');
  expect(rowWrap(ids.waiting)!.hasAttribute('data-archived')).toBe(false);
  expect(document.querySelector('[data-inbox-notice]')).toBeNull();
});

test.skipIf(!hasDom)('Escape closes the menu and puts focus back on the row; the keyboard opens it too', async () => {
  await renderApp();
  const row = rowButton(ids.mixed)!;
  act(() => row.focus());
  // Shift+F10 on the focused row: the list sends the row a `contextmenu` (macOS browsers send none).
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.mixed, 'the menu');
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !menu(), 'the menu to close');
  await until(() => document.activeElement === rowButton(ids.mixed), 'focus on the row');
  await act(async () => {
    rowButton(ids.mixed)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.mixed, 'the menu again');
  await act(async () => {
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  await until(() => !menu(), 'the menu to close on Tab');
  await until(() => document.activeElement === rowButton(ids.mixed), 'focus on the row after Tab');
  expect(window.location.hash).not.toContain('thread=');
});

test.skipIf(!hasDom)('Snooze by keyboard: focus lands on the first time, and Back puts it on Snooze again, never on the page', async () => {
  // A Wednesday morning, so the times are all four: after 6 PM there is no Later today, and on a Friday Next week is In 3 days.
  setSystemTime(new Date('2026-11-04T10:00:00Z'));
  await renderApp();
  const row = rowButton(ids.waiting)!;
  act(() => row.focus());
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.waiting, 'the menu');
  await choose('snooze');
  await until(() => !!menu()?.querySelector('[data-snooze-view="times"]'), 'the times');
  await until(() => document.activeElement === menu()!.querySelector('[data-snooze-choice]'), 'focus on the first time');
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  });
  await until(() => document.activeElement === menu()!.querySelectorAll('[data-snooze-choice]')[1], 'focus on the second time');
  await act(async () => {
    menu()!.querySelector<HTMLElement>('[data-snooze-back]')!.click();
  });
  await until(() => !!item('snooze'), 'the menu again');
  await until(() => document.activeElement === item('snooze'), 'focus on Snooze after Back');
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !menu(), 'the menu to close');
  await until(() => document.activeElement === rowButton(ids.waiting), 'focus on the row');
});

test.skipIf(!hasDom)('a touch never opens it, and outside the rows the browser keeps its own menu', async () => {
  await renderApp();
  const row = rowButton(ids.same)!;
  await act(async () => {
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  });
  const touchEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  await act(async () => {
    row.dispatchEvent(touchEvent);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(menu()).toBeNull();
  expect(touchEvent.defaultPrevented).toBe(false);
  const band = document.querySelector<HTMLElement>('.ib-band')!;
  const onBand = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  await act(async () => {
    band.dispatchEvent(onBand);
  });
  expect(menu()).toBeNull();
  expect(onBand.defaultPrevented).toBe(false);
});

async function focusElsewhere(): Promise<HTMLElement> {
  const search = document.querySelector<HTMLElement>('[data-open-search]')!;
  act(() => search.focus());
  expect(document.activeElement).toBe(search);
  return search;
}

test.skipIf(!hasDom)('focus was elsewhere: Escape, Copy and Tab each put it on the row, never back where it was', async () => {
  await renderApp();
  const search = await focusElsewhere();
  await openMenu(ids.waiting);
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !menu(), 'the menu to close on Escape');
  await until(() => document.activeElement === rowButton(ids.waiting), 'focus on the row after Escape');

  act(() => search.focus());
  await openMenu(ids.waiting);
  await choose('copy-id');
  await until(() => !menu(), 'the menu to close on Copy');
  await until(() => document.activeElement === rowButton(ids.waiting), 'focus on the row after Copy');
  expect(clipboard).toEqual([ids.waiting]);

  act(() => search.focus());
  await openMenu(ids.waiting);
  await act(async () => {
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  await until(() => !menu(), 'the menu to close on Tab');
  await until(() => document.activeElement === rowButton(ids.waiting), 'focus on the row after Tab');
});

test.skipIf(!hasDom)('Archive with no thread open: the row stays in its slot, archived, and no row moves; at the tidy it leaves and the next row takes its slot', async () => {
  await renderApp();
  await focusElsewhere();
  const listed = () => [...document.querySelectorAll('.ib-lbody [data-thread-id]')].map((el) => el.getAttribute('data-thread-id')!);
  const order = listed();
  await openMenu(ids.waiting);
  await choose('archive');
  await until(() => rowWrap(ids.waiting)?.hasAttribute('data-archived') === true, 'the row archived in place');
  expect(listed()).toEqual(order);
  expect(document.activeElement).not.toBe(document.body);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-list-refresh]')!.click());
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  expect(listed()).toEqual(order.filter((id) => id !== ids.waiting));
});

test.skipIf(!hasDom)('the context-menu key: the keyup `contextmenu` (Chromium on Windows) is cancelled while the menu is open; rows name Shift+F10', async () => {
  await renderApp();
  const row = rowButton(ids.stopped)!;
  expect(row.getAttribute('aria-keyshortcuts')).toBe('Shift+F10');
  expect(row.hasAttribute('aria-haspopup')).toBe(false);
  act(() => row.focus());
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.stopped, 'the menu');
  const focused = (document.activeElement ?? document.body) as HTMLElement;
  focused.dispatchEvent(new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true }));
  const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 });
  await act(async () => {
    focused.dispatchEvent(native);
  });
  expect(native.defaultPrevented).toBe(true);
  expect(menu()?.getAttribute('data-row-menu')).toBe(ids.stopped);
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !menu(), 'the menu to close');
  const later = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  await act(async () => {
    document.querySelector<HTMLElement>('.ib-band')!.dispatchEvent(later);
  });
  expect(later.defaultPrevented).toBe(false);
});

test.skipIf(!hasDom)('with a thread open: Archive from another row keeps it in place shown archived, the toast names it, and Undo brings it back in place', async () => {
  await renderApp(`#thread=${ids.stopped}`);
  await until(() => !!document.querySelector('section.ib-pane'), 'the thread');
  const placed = () => [...document.querySelectorAll('.ib-listcol [data-row]')].map((el) => el.getAttribute('data-row'));
  const before = placed();
  const subject = rowButton(ids.waiting)!.querySelector('.ib-title')!.textContent!;
  await openMenu(ids.waiting);
  await choose('archive');
  await until(() => toast()?.textContent?.includes('Archived') === true, 'the toast');
  expect(toast()!.textContent).toContain(`“${subject}”`);
  expect(posted.some((p) => p.path === `/api/inbox/messages/${ids.waiting}/resolve` && p.body.resolved === true)).toBe(true);
  await until(() => rowButton(ids.waiting)?.querySelector('.ib-c .ib-cs')?.textContent === 'Archived', 'the row shown archived');
  expect(placed()).toEqual(before);
  expect(window.location.hash).toContain(`thread=${ids.stopped}`);
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(async () => (await serverSections()).get(ids.waiting) === 'waiting', 'the thread unarchived');
  await until(() => rowButton(ids.waiting)?.querySelector('.ib-c .ib-cs')?.textContent !== 'Archived', 'the row no longer shown archived');
  expect(placed()).toEqual(before);
});

function mouseClick(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
}

test.skipIf(!hasDom)('with a thread open, Archive from the menu then a mouse close of the thread: focus is not moved to the old slot', async () => {
  await renderApp(`#thread=${ids.stopped}`);
  await until(() => !!document.querySelector('section.ib-pane'), 'the thread');
  const order = [...document.querySelectorAll('.ib-lbody [data-thread-id]')].map((el) => el.getAttribute('data-thread-id')!);
  const next = order[order.indexOf(ids.waiting) + 1]!;
  await openMenu(ids.waiting);
  await choose('archive');
  await until(() => rowButton(ids.waiting)?.querySelector('.ib-c .ib-cs')?.textContent === 'Archived', 'the row shown archived');
  mouseClick(document.querySelector<HTMLElement>('section.ib-pane [aria-label="Close the thread"]')!);
  await until(() => !rowButton(ids.waiting), 'the archived row to leave once the thread closed');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(document.activeElement).not.toBe(rowButton(next));
});

test.skipIf(!hasDom)('after the context-menu key, a pointer press drops the keyup guard: a right-click is not swallowed', async () => {
  await renderApp();
  const row = rowButton(ids.picked)!;
  act(() => row.focus());
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.picked, 'the menu');
  const inside = item('copy-link')!;
  inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, pointerType: 'mouse' }));
  const right = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 400, clientY: 300 });
  const seen: { prevented: boolean | null } = { prevented: null };
  const look = (event: Event) => {
    seen.prevented = event.defaultPrevented;
  };
  window.addEventListener('contextmenu', look);
  try {
    await act(async () => {
      inside.dispatchEvent(right);
    });
  } finally {
    window.removeEventListener('contextmenu', look);
  }
  expect(seen.prevented).toBe(false);
});

test.skipIf(!hasDom)('the row leaves while its menu is open: focus goes to the row in its slot, from the order when the menu opened', async () => {
  const rowOf = (id: string) =>
    ({ thread_id: id, subject: id, section: 'new', unseen: 0, answered_not_sent: false, resolved_at: null, read_at: null }) as unknown as import('@plannotator/core/inbox-types').InboxListRow;
  let setRows: (rows: string[]) => void = () => {};
  function Harness() {
    const [rows, set] = useState(['a', 'b', 'c']);
    setRows = set;
    return (
      <div className="pn-inbox">
        <ThreadRowMenu className="ib-lbody" rowOf={(id) => (rows.includes(id) ? rowOf(id) : null)} canMarkRead={false} held={false} onAction={() => {}} onTarget={() => {}}>
          <button type="button" className="ib-band">Quiet</button>
          {rows.map((id) => (
            <div key={id} data-row={id}>
              <button type="button" data-thread-id={id}>{id}</button>
            </div>
          ))}
        </ThreadRowMenu>
      </div>
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness />);
  });
  const b = document.querySelector<HTMLElement>('[data-thread-id="b"]')!;
  await rightClick(b);
  await until(() => menu()?.getAttribute('data-row-menu') === 'b', 'the menu');
  await act(async () => {
    setRows(['a', 'c']);
  });
  await until(() => !menu(), 'the menu to close');
  await until(() => document.activeElement === document.querySelector('[data-thread-id="c"]'), 'focus on the row in its slot');
});

async function snoozeTomorrow(popup: string) {
  await until(() => !!document.querySelector(`${popup} [data-snooze-choice="tomorrow"]`), 'the times');
  await act(async () => {
    document.querySelector<HTMLElement>(`${popup} [data-snooze-choice="tomorrow"]`)!.click();
  });
}
const groupOfRow = (id: string) => rowWrap(id)?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null;
const snoozedBand = () => document.querySelector<HTMLElement>('[data-section-id="snoozed"] button.ib-band');
const placedRows = () => [...document.querySelectorAll('.ib-listcol [data-row]')].map((el) => el.getAttribute('data-row'));

test.skipIf(!hasDom)("with a thread open: Snooze from another row moves only that row into the Snoozed band at once; other held changes stay held; Undo puts it back in its slot", async () => {
  await renderApp(`#thread=${ids.stopped}`);
  await until(() => !!document.querySelector('section.ib-pane'), 'the thread');
  const markedFrom = groupOfRow(ids.mixed);
  await openMenu(ids.mixed);
  await choose('read');
  await until(async () => (await serverSections()).get(ids.mixed) === 'quiet', 'Mark read written');
  await until(() => !!toast(), 'the toast');
  expect(groupOfRow(ids.mixed)).toBe(markedFrom);
  const before = placedRows();
  await openMenu(ids.waiting);
  await choose('snooze');
  await snoozeTomorrow(`[data-row-menu="${ids.waiting}"]`);
  await until(() => toast()?.textContent?.includes('Snoozed') === true, 'the toast');
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  expect(snoozedBand()?.getAttribute('aria-expanded')).toBe('false');
  expect(placedRows()).toEqual(before.filter((id) => id !== ids.waiting));
  expect(groupOfRow(ids.mixed)).toBe(markedFrom);
  expect(window.location.hash).toContain(`thread=${ids.stopped}`);
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(() => !!rowButton(ids.waiting), 'the row back');
  expect(placedRows()).toEqual(before);
  expect(snoozedBand()).toBeNull();
  expect((await serverSections()).get(ids.waiting)).toBe('waiting');
});

async function headerSnooze() {
  await act(async () => {
    document.querySelector<HTMLElement>('section.ib-pane [data-thread-more]')!.click();
  });
  await until(() => !!document.querySelector('[data-thread-menu] [data-thread-snooze-item]'), 'Snooze in the ⋯ menu');
  await act(async () => {
    document.querySelector<HTMLElement>('[data-thread-menu] [data-thread-snooze-item]')!.click();
  });
}

test.skipIf(!hasDom)("Snooze from the open thread's ⋯ menu: its row leaves for the Snoozed band at once and the thread stays open, saying until when", async () => {
  await renderApp(`#thread=${ids.waiting}`);
  await until(() => !!document.querySelector('section.ib-pane [data-thread-more]'), 'the header ⋯');
  await until(() => !!rowButton(ids.waiting), 'the open row');
  const before = placedRows();
  await headerSnooze();
  await snoozeTomorrow('[data-thread-snooze-menu]');
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  expect(placedRows()).toEqual(before.filter((id) => id !== ids.waiting));
  expect(snoozedBand()).not.toBeNull();
  expect(window.location.hash).toContain(`thread=${ids.waiting}`);
  await until(() => !!document.querySelector('section.ib-pane [data-snooze-line]'), 'the snooze line');
});

test.skipIf(!hasDom)('Snooze the open thread, then Unsnooze in it: its row comes back between the same neighbours at once, the band as it was', async () => {
  await renderApp(`#thread=${ids.waiting}`);
  await until(() => !!document.querySelector('section.ib-pane [data-thread-more]'), 'the header ⋯');
  await until(() => !!rowButton(ids.waiting), 'the open row');
  const before = placedRows();
  const band = () => snoozedBand()?.textContent ?? null;
  const bandBefore = band();
  await headerSnooze();
  await snoozeTomorrow('[data-thread-snooze-menu]');
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  await until(() => !!document.querySelector('section.ib-pane [data-unsnooze]'), 'Unsnooze in the thread');
  await act(async () => {
    document.querySelector<HTMLElement>('section.ib-pane [data-unsnooze]')!.click();
  });
  await until(async () => (await serverSections()).get(ids.waiting) === 'waiting', 'the unsnooze written');
  await until(() => !!rowButton(ids.waiting), 'the row back');
  expect(placedRows()).toEqual(before);
  expect(band()).toBe(bandBefore);
  expect(window.location.hash).toContain(`thread=${ids.waiting}`);
});

test.skipIf(!hasDom)('with a thread open, a mouse Snooze from another row whose write is slow: when the row leaves, focus goes to the row now in its slot', async () => {
  await renderApp(`#thread=${ids.stopped}`);
  await until(() => !!document.querySelector('section.ib-pane'), 'the thread');
  const order = [...document.querySelectorAll('.ib-lbody [data-thread-id]')].map((el) => el.getAttribute('data-thread-id')!);
  const at = order.indexOf(ids.waiting);
  const next = order[at + 1] ?? order[at - 1]!;
  const fast = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).includes('/snooze')) await new Promise((r) => setTimeout(r, 600));
    return fast(input, init);
  }) as typeof fetch;
  act(() => {
    window.dispatchEvent(new Event('pointerdown'));
  });
  await openMenu(ids.waiting);
  mouseClick(item('snooze')!);
  await until(() => !!document.querySelector(`[data-row-menu="${ids.waiting}"] [data-snooze-choice="tomorrow"]`), 'the times');
  mouseClick(document.querySelector<HTMLElement>(`[data-row-menu="${ids.waiting}"] [data-snooze-choice="tomorrow"]`)!);
  await until(() => !menu(), 'the menu to close');
  expect(rowButton(ids.waiting)).not.toBeNull();
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  await until(() => document.activeElement === rowButton(next), 'focus on the row in its slot');
});

test.skipIf(!hasDom)('with a thread open, Snooze by keyboard from another row: focus goes to the row now in its slot, never the page', async () => {
  await renderApp(`#thread=${ids.stopped}`);
  await until(() => !!document.querySelector('section.ib-pane'), 'the thread');
  const order = [...document.querySelectorAll('.ib-lbody [data-thread-id]')].map((el) => el.getAttribute('data-thread-id')!);
  const at = order.indexOf(ids.waiting);
  const next = order[at + 1] ?? order[at - 1]!;
  const row = rowButton(ids.waiting)!;
  act(() => row.focus());
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.waiting, 'the menu');
  await choose('snooze');
  await snoozeTomorrow(`[data-row-menu="${ids.waiting}"]`);
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  await until(() => document.activeElement === rowButton(next), 'focus on the row in its slot');
});
