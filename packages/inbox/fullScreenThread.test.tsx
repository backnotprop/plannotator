/**
 * Full screen through the whole window (approval "inbox-one-fullscreen"):
 * InboxApp over a REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts in its `open-in` mode, whose thread
 * carries page.html, plan.md, build.zip, shot.png). An HTML file opens full
 * screen with the toolbar showing, whatever plan review's shared hide-tools
 * choice says, and nothing here writes that choice; every opening starts
 * showing; Side by side puts the file beside the thread; the comments drawer left
 * open comes back with the next file; a step keeps full screen.
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
const { getHtmlChromeState, saveHtmlChromeState } = (hasDom ? await import('@plannotator/ui/utils/htmlChrome') : {}) as typeof import('@plannotator/ui/utils/htmlChrome');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const CHROME_COOKIE = 'plannotator-html-chrome';
const DRAWER_COOKIE = 'plannotator-inbox-file-comments';
const VIEW_COOKIE = 'plannotator-inbox-file-view';

type World = { project: string; openIn: { thread: string; ids: Record<string, string> } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World;
let dir: string | null = null;
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

const TESTS = 2;

beforeAll(async () => {
  if (!hasDom) return;
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-fullscreen-dom-')));
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
  world = worlds.shift()!;
  document.cookie = `${CHROME_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${DRAWER_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${VIEW_COOKIE}=; path=/; max-age=0`;
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
  document.cookie = `${CHROME_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${DRAWER_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${VIEW_COOKIE}=; path=/; max-age=0`;
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

async function renderThread() {
  window.location.hash = `#thread=${world.openIn.thread}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector(`[data-attachment-id="${world.openIn.ids['page.html']}"]`) !== null, 'the thread and its tiles');
  return host;
}

const view = () => host!.querySelector<HTMLElement>('.ib-view');
const inFullScreen = () => view()?.hasAttribute('data-full-view') === true;
async function openTile(name: string) {
  const tile = host!.querySelector<HTMLElement>(`.ib-attachments [data-attachment-id="${world.openIn.ids[name]}"], [data-attachment-id="${world.openIn.ids[name]}"]`)!;
  await act(async () => tile.click());
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids[name], `${name} open`);
}
/** Close the file beside the thread. */
async function close() {
  await act(async () => host!.querySelector<HTMLButtonElement>('.ib-vhead [aria-label^="Close "]')!.click());
}

const toolbarState = () => host!.querySelector('[data-full-view-dock]')?.getAttribute('data-bar') ?? null;

test.skipIf(!hasDom)('an HTML file opens full screen with the toolbar showing, even where plan review keeps its tools hidden; Hide, Exit and Full screen never write that shared choice', async () => {
  // Plan review's shared choice says hidden: the Inbox no longer follows it (owner's choice, approval "inbox-one-fullscreen").
  saveHtmlChromeState({ sidebarOpen: true, panelOpen: true, toolsHidden: true });
  const chromeCookie = () => document.cookie.split('; ').find((c) => c.startsWith(`${CHROME_COOKIE}=`));
  const before = chromeCookie();
  const el = await renderThread();
  await openTile('page.html');
  await until(inFullScreen, 'full screen');
  expect(el.querySelector('.ib-vhead')).toBeNull();
  expect(toolbarState()).toBe('pinned');
  expect(el.querySelector('[data-full-view-pen]')).not.toBeNull();

  // Hide tucks it; Side by side puts the file beside the thread, focus on the switch's Side by side.
  await act(async () => el.querySelector<HTMLButtonElement>('[data-full-view-hide]')!.click());
  expect(toolbarState()).toBe('tucked');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-full-view-handle]')!.click());
  await act(async () => el.querySelector<HTMLButtonElement>('[data-full-view-exit="exit"]')!.click());
  await until(() => !inFullScreen(), 'beside the thread');
  expect(document.activeElement === el.querySelector('.ib-vhead [data-view-side]')).toBe(true);

  // Full screen again: the toolbar starts showing.
  await act(async () => el.querySelector<HTMLButtonElement>('.ib-vhead [data-full-screen-toggle]')!.click());
  await until(inFullScreen, 'full screen again');
  expect(toolbarState()).toBe('pinned');

  // Side by side again, closed and opened again: the page opens side by side (the remembered pick), and Full screen starts showing.
  await act(async () => el.querySelector<HTMLButtonElement>('[data-full-view-exit="exit"]')!.click());
  await close();
  await until(() => view() === null, 'the file closed');
  await openTile('page.html');
  expect(inFullScreen()).toBe(false);
  await act(async () => el.querySelector<HTMLButtonElement>('.ib-vhead [data-full-screen-toggle]')!.click());
  await until(inFullScreen, 'full screen once more');
  expect(toolbarState()).toBe('pinned');
  expect(getHtmlChromeState()).toEqual({ sidebarOpen: true, panelOpen: true, toolsHidden: true });
  // Not even rewritten (its save time is the one plan review wrote).
  expect(chromeCookie()).toBe(before);
});

test.skipIf(!hasDom)('a markdown file opens beside the thread; Full screen takes it to the one mode; the drawer left open comes back with the next file; a step keeps full screen', async () => {
  const el = await renderThread();
  await openTile('plan.md');
  expect(inFullScreen()).toBe(false);
  expect(el.querySelector('[data-html-tools-toggle]')).toBeNull();
  await act(async () => el.querySelector<HTMLButtonElement>('.ib-vhead [data-full-screen-toggle]')!.click());
  await until(inFullScreen, 'full screen');
  expect(toolbarState()).toBe('pinned');
  expect(document.activeElement === el.querySelector('[data-full-view-bar] button')).toBe(true);

  await act(async () => el.querySelector<HTMLButtonElement>('[data-full-view-comments]')!.click());
  expect(view()!.classList.contains('ib-drawer')).toBe(true);
  // A step to the HTML file keeps full screen and the drawer (the thread's order: page.html is before plan.md).
  await act(async () => {
    view()!.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }));
  });
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids['page.html'], 'the step');
  expect(inFullScreen()).toBe(true);
  expect(view()!.classList.contains('ib-drawer')).toBe(true);

  // Closed, then another file taken full screen: the drawer is open as it was left.
  await act(async () => el.querySelector<HTMLButtonElement>('[data-full-view-exit="exit"]')!.click());
  await close();
  await until(() => view() === null, 'the file closed');
  await openTile('plan.md');
  await act(async () => el.querySelector<HTMLButtonElement>('.ib-vhead [data-full-screen-toggle]')!.click());
  await until(inFullScreen, 'full screen');
  expect(view()!.classList.contains('ib-drawer')).toBe(true);
});
