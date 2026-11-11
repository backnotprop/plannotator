/** happy-dom has no 2D canvas, so the icon here is the SVG form. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { FACE_FAVICON_PNG_BYTES, FACE_FAVICON_PNG_DATA_URL, FAVICON_PNG_DATA_URL } from '@plannotator/core/favicon';
import { resetInboxFaviconForTests } from './faviconChoice';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; stopped: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let world: World = { project: '', stopped: '', waiting: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let pokeStream: (() => void) | null = null;
let restoreBadge: (() => void) | null = null;
let listReadsFail = false;
let failedListReads = 0;

function watchBadge(): (number | 'clear')[] {
  const badges: (number | 'clear')[] = [];
  const nav = navigator as { setAppBadge?: unknown; clearAppBadge?: unknown };
  const saved = { set: nav.setAppBadge, clear: nav.clearAppBadge };
  nav.setAppBadge = async (n: number) => void badges.push(n);
  nav.clearAppBadge = async () => void badges.push('clear');
  restoreBadge = () => {
    nav.setAppBadge = saved.set;
    nav.clearAppBadge = saved.clear;
  };
  return badges;
}

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; bytes: Buffer; type: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks), type: String(res.headers['content-type'] ?? 'application/json') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

async function agentSends(body: string): Promise<string> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_tab', body } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

async function serverRows() {
  const model = JSON.parse((await loopback('/api/inbox/threads?archived=exclude')).bytes.toString('utf8')) as { sections: InboxListSection[] };
  return model.sections.flatMap((s) => s.threads);
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-tabcount-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await readLine()) as { port: number; worlds: World[] };
  port = started.port;
  world = started.worlds[0]!;
});

afterAll(async () => {
  if (!hasDom) return;
  childOut?.releaseLock();
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (listReadsFail && String(input).startsWith('/api/inbox/threads?')) {
      failedListReads += 1;
      return new Response('{"error":"down"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(new Uint8Array(answer.bytes), { status: answer.status, headers: { 'Content-Type': answer.type } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') pokeStream = () => listener({ data: '' } as MessageEvent<string>);
    }
    close() {}
  };
  document.title = 'Plannotator Inbox';
  document.head.querySelector('link[rel="icon"]')?.remove();
  const link = document.createElement('link');
  link.rel = 'icon';
  link.setAttribute('href', '/favicon.ico');
  link.setAttribute('sizes', '16x16 32x32 48x48');
  document.head.appendChild(link);
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  restoreBadge?.();
  restoreBadge = null;
  listReadsFail = false;
  root = null;
  host = null;
  pokeStream = null;
  resetInboxFaviconForTests();
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}; title "${document.title}"`);
}

const iconHref = () => document.head.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '';
const iconLabel = () => /<text[^>]*>([^<]*)<\/text>/.exec(decodeURIComponent(iconHref()))?.[1] ?? null;

function openThread(id: string) {
  act(() => {
    window.location.hash = `#thread=${id}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

test.skipIf(!hasDom)('the tab counts threads with news the person has not looked at, and clears as they look', async () => {
  for (const row of await serverRows()) {
    if (row.thread_id !== world.stopped) await loopback(`/api/inbox/threads/${row.thread_id}/seen`, 'POST', '{}');
  }
  const waitingRow = (await serverRows()).find((r) => r.thread_id === world.waiting)!;
  expect(waitingRow.questions.open).toBeGreaterThan(0);
  expect(waitingRow.unseen).toBe(0);

  const badges = watchBadge();

  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => document.title === '(1) Plannotator Inbox', 'one thread counted');
  expect(badges.at(-1)).toBe(1);
  await until(() => iconLabel() === '1', 'the badged icon');
  expect(iconHref().startsWith('data:image/svg+xml')).toBe(true);
  expect(decodeURIComponent(iconHref())).toContain(`href="${FAVICON_PNG_DATA_URL}"`);

  const fresh = await agentSends('A fresh finding about the build.');
  act(() => pokeStream?.());
  await until(() => document.title === '(2) Plannotator Inbox' && iconLabel() === '2', 'the agent message counted');
  expect(badges.at(-1)).toBe(2);

  openThread(fresh);
  await until(() => document.title === '(1) Plannotator Inbox' && iconLabel() === '1', 'the opened thread cleared');

  openThread(world.stopped);
  await until(() => document.title === 'Plannotator Inbox' && iconHref() === '/favicon.ico', 'the plain tab');
  expect(badges.at(-1)).toBe('clear');
});

test.skipIf(!hasDom)('a favicon picked in Settings is the tab icon at once, the badge drawn over it, and saved for every page', async () => {
  const fresh = await agentSends('A thread for the favicon pick.');
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => iconLabel() !== null, 'the badged icon');
  expect(decodeURIComponent(iconHref())).not.toContain(FACE_FAVICON_PNG_DATA_URL);

  act(() => {
    window.location.hash = '#settings/general';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  const choice = () => document.querySelector<HTMLInputElement>('input[name="ib-favicon"][value="totman"]');
  await until(() => choice() !== null, 'the Favicon row');
  const labels = [...document.querySelectorAll('input[name="ib-favicon"]')].map((input) => input.closest('label')?.textContent);
  expect(labels).toEqual(['Glass', 'Yellow', 'Face']);
  expect(document.querySelector<HTMLInputElement>('input[name="ib-favicon"][value="glass"]')?.checked).toBe(true);

  act(() => choice()!.click());
  await until(() => decodeURIComponent(iconHref()).includes(FACE_FAVICON_PNG_DATA_URL) && iconLabel() !== null, 'the badge over the Face icon');
  await until(async () => JSON.parse((await loopback('/api/inbox/settings')).bytes.toString('utf8')).favicon === 'totman', 'the saved choice');
  const served = await loopback('/favicon.png');
  expect(new Uint8Array(served.bytes)).toEqual(FACE_FAVICON_PNG_BYTES);

  await loopback(`/api/inbox/threads/${fresh}/seen`, 'POST', '{}');
  for (const row of await serverRows()) await loopback(`/api/inbox/threads/${row.thread_id}/seen`, 'POST', '{}');
  act(() => pokeStream?.());
  await until(() => iconHref() === FACE_FAVICON_PNG_DATA_URL, 'the plain Face icon');
});

test.skipIf(!hasDom)("the app's badge is one for every window: a window with no list, and a window going away, leave it as it is", async () => {
  await agentSends('News for the badge every window shares.');
  const badges = watchBadge();
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => typeof badges.at(-1) === 'number', 'the first window badging its count');
  const count = badges.at(-1);
  const writes = badges.length;

  listReadsFail = true;
  failedListReads = 0;
  const secondHost = document.createElement('div');
  document.body.appendChild(secondHost);
  let second: Root | null = null;
  act(() => {
    second = createRoot(secondHost);
    second.render(<InboxApp />);
  });
  await until(() => failedListReads > 0, "the second window's failed list read");
  await wait(200);
  expect(badges.slice(writes)).toEqual([]);

  act(() => second!.unmount());
  secondHost.remove();
  act(() => root!.unmount());
  root = null;
  expect(badges.slice(writes)).toEqual([]);
  expect(badges.at(-1)).toBe(count);
});
