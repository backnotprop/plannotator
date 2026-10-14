/**
 * "Open in" for attachments (design record "inbox-open-in", approved
 * 2026-10-14): the whole window (InboxApp) over a REAL Inbox server in a
 * temp data dir (its own process, tests/helpers/inbox-dom-server.ts in its
 * `open-in` mode). No app ever starts: that server's launcher only records
 * each launch to `launches.jsonl`. What is proved: the split button and its
 * menu per kind (HTML: Browser first; markdown: the editors, the default
 * app, Finder; anything else: Finder only), a pick launches through the
 * server and is remembered, a tile's ⋯ sits beside the tile's own control
 * (never inside it) with the same list, a missing file disables the apps but
 * not Copy path, and a page that came through the tailnet gets only "Open in
 * new tab" for HTML and images.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; openIn: { thread: string; ids: Record<string, string> } };
type Tailnet = { listener: number; host: string; login: string };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let tailnet: Tailnet | null = null;
let worlds: World[] = [];
let world: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
/** Requests go through the tailnet listener, as `tailscale serve` hands them over. */
let viaTailnet = false;

/** One request to the real Inbox (or its tailnet listener) over loopback. */
function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  const target = viaTailnet && tailnet ? { port: tailnet.listener, headers: { Host: tailnet.host, 'Tailscale-User-Login': tailnet.login } } : { port, headers: { Host: `127.0.0.1:${port}` } };
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port: target.port, path, method, headers: { 'Content-Type': 'application/json', ...target.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

const TESTS = 6;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-openin-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'open-in'], {
    env: {
      ...process.env,
      DOM_TESTS: '0',
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_TAILSCALE: '',
      OPEN_IN_PLATFORM: 'mac',
      HOME: dir,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    },
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
  const started = JSON.parse(line.trim()) as { port: number; worlds: World[]; tailnet: Tailnet };
  port = started.port;
  worlds = started.worlds;
  tailnet = started.tailnet;
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
  world = worlds.shift()!;
  viaTailnet = false;
  document.cookie = 'plannotator-open-in-app=; path=/; max-age=0';
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

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-view') !== null, 'the file beside the thread');
  return host;
}

const fileHash = (name: string) => `#thread=${world.openIn.thread}&file=${world.openIn.ids[name]}`;
const pane = (el: ParentNode) => el.querySelector('.ib-view .ib-vhead')!;
const menuOf = (id: string) => document.querySelector<HTMLElement>(`[data-open-in-menu="${id}"]`);
const itemsOf = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[data-open-in-item]')].map((item) => item.getAttribute('data-open-in-item'));
const checkedOf = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[data-open-in-item]')].filter((item) => item.querySelector('.ib-openin-check')).map((item) => item.getAttribute('data-open-in-item'));
const launches = () => {
  const file = join(dir!, 'data', 'launches.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { app: string; path: string }) : [];
};

async function openMenu(el: ParentNode, trigger: string, id: string): Promise<HTMLElement> {
  await act(async () => el.querySelector<HTMLButtonElement>(trigger)!.click());
  await until(() => menuOf(id) !== null, 'the menu');
  return menuOf(id)!;
}

test.skipIf(!hasDom)('HTML: the button opens the page in a new browser tab; the menu is Browser (checked), the editors, Finder, Copy path', async () => {
  const el = await renderApp(fileHash('page.html'));
  const id = world.openIn.ids['page.html']!;
  await until(() => pane(el).querySelector('[data-open-in-primary]') !== null, 'the split button');
  const primary = pane(el).querySelector<HTMLAnchorElement>('[data-open-in-primary="browser"]')!;
  expect(primary.tagName).toBe('A');
  expect(primary.getAttribute('href')).toBe(`/api/inbox/attachments/${id}/page`);
  expect(primary.getAttribute('target')).toBe('_blank');
  expect(primary.getAttribute('rel')).toBe('noopener noreferrer');
  expect(primary.textContent).toBe('Open');
  // Before Download, as the mock draws it.
  const order = [...pane(el).children].map((child) => (child.hasAttribute('data-open-in') ? 'open-in' : child.hasAttribute('data-attachment-download') ? 'download' : null)).filter(Boolean);
  expect(order).toEqual(['open-in', 'download']);
  const menu = await openMenu(pane(el), '[data-open-in-caret]', id);
  expect(itemsOf(menu)).toEqual(['browser', 'vscode', 'cursor', 'zed', 'reveal', 'copy-path']);
  expect(checkedOf(menu)).toEqual(['browser']);
  // No narrative in the list: icons and names.
  expect([...menu.querySelectorAll('[data-open-in-item]')].map((item) => item.textContent)).toEqual(['Browser', 'VS Code', 'Cursor', 'Zed', 'Finder', 'Copy path']);
  expect(menu.querySelector<HTMLAnchorElement>('[data-open-in-item="browser"]')!.getAttribute('href')).toBe(`/api/inbox/attachments/${id}/page`);
});

test.skipIf(!hasDom)('markdown: the first editor is the button; picking another launches the file as it is now and is remembered', async () => {
  const el = await renderApp(fileHash('plan.md'));
  const id = world.openIn.ids['plan.md']!;
  await until(() => pane(el).querySelector('[data-open-in-primary]') !== null, 'the split button');
  expect(pane(el).querySelector('[data-open-in-primary]')!.getAttribute('data-open-in-primary')).toBe('vscode');
  const menu = await openMenu(pane(el), '[data-open-in-caret]', id);
  // macOS: md also gets the default app.
  expect(itemsOf(menu)).toEqual(['vscode', 'cursor', 'zed', 'default', 'reveal', 'copy-path']);
  expect(checkedOf(menu)).toEqual(['vscode']);
  const before = launches().length;
  await act(async () => menu.querySelector<HTMLElement>('[data-open-in-item="cursor"]')!.click());
  await until(() => launches().length === before + 1, 'the launch');
  const launched = launches().at(-1)!;
  expect(launched.app).toBe('cursor');
  expect(launched.path.endsWith('/plan.md')).toBe(true);
  await until(() => pane(el).querySelector('[data-open-in-primary]')?.getAttribute('data-open-in-primary') === 'cursor', 'cursor remembered');
  // The left half launches the remembered app straight away.
  await act(async () => pane(el).querySelector<HTMLButtonElement>('[data-open-in-primary]')!.click());
  await until(() => launches().length === before + 2, 'the second launch');
  expect(launches().at(-1)!.app).toBe('cursor');
});

test.skipIf(!hasDom)('anything else (a zip): Finder and Copy path only; its tile ⋯ sits beside the download link, never inside it', async () => {
  const el = await renderApp(fileHash('build.zip'));
  const id = world.openIn.ids['build.zip']!;
  await until(() => pane(el).querySelector('[data-open-in-primary]') !== null, 'the split button');
  expect(pane(el).querySelector('[data-open-in-primary]')!.getAttribute('data-open-in-primary')).toBe('reveal');
  expect(itemsOf(await openMenu(pane(el), '[data-open-in-caret]', id))).toEqual(['reveal', 'copy-path']);
  await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => menuOf(id) === null || !menuOf(id)!.isConnected, 'the menu closed');

  const tile = el.querySelector<HTMLElement>(`.ib-thread [data-open-in-tile="${id}"], [data-open-in-tile="${id}"]`)!;
  const link = tile.querySelector<HTMLAnchorElement>(`a[data-attachment-id="${id}"]`)!;
  const more = tile.querySelector<HTMLButtonElement>(`button[data-open-in-more="${id}"]`)!;
  expect(link.parentElement).toBe(tile);
  expect(more.parentElement).toBe(tile);
  expect(link.contains(more)).toBe(false);
  expect(more.getAttribute('aria-label')).toBe('Open in…, build.zip');
  expect(itemsOf(await openMenu(tile, `button[data-open-in-more="${id}"]`, id))).toEqual(['reveal', 'copy-path']);
});

test.skipIf(!hasDom)('an image tile: its default viewer (checked), Finder, Copy path; no editor', async () => {
  const el = await renderApp(fileHash('shot.png'));
  const id = world.openIn.ids['shot.png']!;
  await until(() => el.querySelector(`button[data-open-in-more="${id}"]`) !== null, 'the tile ⋯');
  const menu = await openMenu(el, `button[data-open-in-more="${id}"]`, id);
  expect(itemsOf(menu)).toEqual(['default', 'reveal', 'copy-path']);
  expect(checkedOf(menu)).toEqual(['default']);
  const before = launches().length;
  await act(async () => menu.querySelector<HTMLElement>('[data-open-in-item="default"]')!.click());
  await until(() => launches().length === before + 1, 'the launch');
  expect(launches().at(-1)!.app).toBe('default');
});

test.skipIf(!hasDom)('a file no longer on disk: the apps are disabled and say Missing; Copy path still works', async () => {
  const el = await renderApp(fileHash('gone.md'));
  const id = world.openIn.ids['gone.md']!;
  await until(() => pane(el).querySelector('[data-open-in-primary]') !== null, 'the split button');
  const primary = pane(el).querySelector<HTMLButtonElement>('[data-open-in-primary]')!;
  expect(primary.disabled).toBe(true);
  expect(primary.title).toBe('Missing');
  const menu = await openMenu(pane(el), '[data-open-in-caret]', id);
  const disabled = [...menu.querySelectorAll<HTMLElement>('[data-open-in-item]')].map((item) => [item.getAttribute('data-open-in-item'), item.hasAttribute('data-disabled')]);
  expect(disabled).toEqual([
    ['vscode', true],
    ['cursor', true],
    ['zed', true],
    ['default', true],
    ['reveal', true],
    ['copy-path', false],
  ]);
  const copied: string[] = [];
  const clipboard = { writeText: async (text: string) => void copied.push(text) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  const before = launches().length;
  await act(async () => menu.querySelector<HTMLElement>('[data-open-in-item="copy-path"]')!.click());
  await until(() => copied.length === 1, 'the path copied');
  expect(copied[0]!.endsWith('/gone.md')).toBe(true);
  expect(launches().length).toBe(before);
});

test.skipIf(!hasDom)('through the tailnet: one Open in new tab icon for HTML and images, nothing for the rest, no tile ⋯', async () => {
  viaTailnet = true;
  const el = await renderApp(fileHash('page.html'));
  const ids = world.openIn.ids;
  await until(() => pane(el).querySelector('[data-open-in-tab]') !== null, 'the new-tab icon');
  const tab = pane(el).querySelector<HTMLAnchorElement>('[data-open-in-tab]')!;
  expect(tab.getAttribute('href')).toBe(`/api/inbox/attachments/${ids['page.html']}/page`);
  expect(tab.getAttribute('aria-label')).toBe('Open in new tab');
  expect(tab.getAttribute('target')).toBe('_blank');
  expect(el.querySelector('[data-open-in]')).toBeNull();
  expect(el.querySelector('[data-open-in-more]')).toBeNull();
  // An image: its own route in a new tab; markdown: nothing.
  window.location.hash = fileHash('shot.png');
  await until(() => pane(el).querySelector('[data-open-in-tab]')?.getAttribute('href') === `/api/inbox/attachments/${ids['shot.png']}/image`, 'the image tab');
  window.location.hash = fileHash('plan.md');
  await until(() => el.querySelector('[data-attachment-pane]')?.getAttribute('data-attachment-pane') === ids['plan.md'], 'the markdown file');
  expect(pane(el).querySelector('[data-open-in-tab]')).toBeNull();
  expect(el.querySelector('[data-open-in]')).toBeNull();
});
