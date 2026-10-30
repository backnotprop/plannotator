/**
 * New message in the list header while the main sidebar is closed (the
 * owner: "If I had the sidebar closed, I need to be able to write a new
 * message. It should appear in the far right of inbox, but only when the main
 * sidebar is closed."). The whole window (InboxApp) over a REAL Inbox server
 * in a temp data dir (tests/helpers/inbox-dom-server.ts). What this catches:
 * the header button showing beside an open sidebar (two New messages), going
 * missing when the sidebar is closed (no way to write a message, with or
 * without a thread open), not following the sidebar toggle, not opening
 * compose, and focus not coming back to it when compose closes.
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

import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { storage } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const SIDEBAR_COOKIE = 'plannotator-inbox-sidebar-open';

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let seeded: { waiting: string } | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

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

beforeAll(async () => {
  if (!hasDom) return;
  // Cookies (the sidebar's open state) need a real origin.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-list-compose-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_BROWSER: NO_BROWSER },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const started = JSON.parse(line.trim()) as { port: number; worlds: { waiting: string }[] };
  port = started.port;
  seeded = started.worlds[0]!;
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
  storage.removeItem(SIDEBAR_COOKIE);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  storage.removeItem(SIDEBAR_COOKIE);
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
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
  await until(() => !!host!.querySelector('.ib-lhead h1') && !!host!.querySelector('[data-thread-id]'), 'the list');
  return host;
}

const headerCompose = (el: ParentNode) => el.querySelector<HTMLButtonElement>('.ib-lhead [data-open-compose]');
const headerSearch = (el: ParentNode) => el.querySelector<HTMLButtonElement>('.ib-lhead [data-open-search]');
const searchDialog = () => document.querySelector('[role="dialog"][aria-label="Search the Inbox"]');
const sidebarState = (el: ParentNode) => el.querySelector('[data-collapsible]')?.getAttribute('data-state') ?? null;
const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement | null;

test.skipIf(!hasDom)('the sidebar open: no New message in the list header (the sidebar has it); closing it brings the header one, opening it takes it away', async () => {
  const el = await renderApp();
  expect(sidebarState(el)).toBe('expanded');
  expect(el.querySelector('.ib-side [data-open-compose]')).not.toBeNull();
  expect(headerCompose(el)).toBeNull();

  act(() => (el.querySelector('.ib-lhead [data-sidebar="trigger"]') as HTMLButtonElement).click());
  await until(() => sidebarState(el) === 'collapsed', 'the sidebar closed');
  expect(headerCompose(el)).not.toBeNull();
  // The header's right end: New message, then Tidy's ⋮ (the approved Tidy frames).
  expect(headerCompose(el)!.nextElementSibling).toBe(el.querySelector('.ib-lhead [data-tidy-menu]'));
  expect(el.querySelector('.ib-lhead')!.lastElementChild).toBe(el.querySelector('.ib-lhead [data-tidy-menu]'));

  act(() => (el.querySelector('.ib-lhead [data-sidebar="trigger"]') as HTMLButtonElement).click());
  await until(() => sidebarState(el) === 'expanded', 'the sidebar open');
  expect(headerCompose(el)).toBeNull();
});

test.skipIf(!hasDom)('the sidebar closed, no thread open: the header New message opens compose, and focus comes back to it', async () => {
  storage.setItem(SIDEBAR_COOKIE, 'false');
  const el = await renderApp();
  expect(sidebarState(el)).toBe('collapsed');
  const button = headerCompose(el)!;
  expect(button).not.toBeNull();
  expect(button.getAttribute('aria-label')).toBe('New message');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  // The component tooltip, never the browser's native one.
  expect(button.hasAttribute('title')).toBe(false);

  act(() => button.focus());
  act(() => button.click());
  await until(() => !!dialog()?.querySelector('[data-compose-to]'), 'compose');
  // Empty, so Escape closes it at once; focus goes back to what opened it.
  act(() => {
    (dialog()!.querySelector('textarea') ?? dialog()!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => dialog() === null, 'compose closed');
  await until(() => document.activeElement === headerCompose(el), 'focus back on the header New message');
});

test.skipIf(!hasDom)('the sidebar closed, a thread open beside the list: the header New message is still there and opens compose', async () => {
  storage.setItem(SIDEBAR_COOKIE, 'false');
  const el = await renderApp(`#thread=${seeded!.waiting}`);
  await until(() => !!el.querySelector('.ib-listcol.ib-narrow'), 'the list beside the thread');
  expect(sidebarState(el)).toBe('collapsed');
  const button = headerCompose(el)!;
  expect(button).not.toBeNull();
  act(() => button.click());
  await until(() => !!dialog()?.querySelector('[data-compose-to]'), 'compose');
});

test.skipIf(!hasDom)('Search in the list header: only while the sidebar is closed, before New message, and it opens the same search as the sidebar', async () => {
  const el = await renderApp();
  expect(sidebarState(el)).toBe('expanded');
  expect(el.querySelector('.ib-side [data-open-search]')).not.toBeNull();
  expect(headerSearch(el)).toBeNull();

  act(() => (el.querySelector('.ib-lhead [data-sidebar="trigger"]') as HTMLButtonElement).click());
  await until(() => sidebarState(el) === 'collapsed', 'the sidebar closed');
  const search = headerSearch(el)!;
  expect(search).not.toBeNull();
  expect(search.getAttribute('aria-label')).toBe('Search');
  expect(search.getAttribute('aria-haspopup')).toBe('dialog');
  expect(search.hasAttribute('title')).toBe(false);
  // The sidebar's Search names the same shortcut.
  expect(search.getAttribute('aria-keyshortcuts')).toBe(el.querySelector('.ib-side [data-open-search]')!.getAttribute('aria-keyshortcuts'));
  // Search, then New message, then Tidy's menu (the phone header's order).
  expect(search.nextElementSibling).toBe(headerCompose(el));
  expect(headerCompose(el)!.nextElementSibling).toBe(el.querySelector('.ib-lhead [data-tidy-menu]'));

  act(() => search.click());
  await until(() => searchDialog() !== null, 'search');

  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  storage.setItem(SIDEBAR_COOKIE, 'true');
  const reopened = await renderApp();
  expect(sidebarState(reopened)).toBe('expanded');
  expect(headerSearch(reopened)).toBeNull();
});
