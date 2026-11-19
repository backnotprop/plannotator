import { drawsDuring } from '../../tests/helpers/react-draws';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { act } = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { readSettingsAtLoad } = (hasDom ? await import('./settingsAtLoad') : {}) as typeof import('./settingsAtLoad');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let world: { project: string; stopped: string; waiting: string } = { project: '', stopped: '', waiting: '' };
let dir: string | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let asked: string[] = [];
/** Settings reads whose answer has come back (asked counts a read when it is sent). */
let settingsAnswered = 0;
let listHeld: Promise<void> | null = null;
const listeners = new Map<string, ((event: MessageEvent) => void)[]>();

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-settings-at-load-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'tags'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
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
  const started = JSON.parse(line.trim()) as { port: number; worlds: (typeof world)[] };
  port = started.port;
  world = started.worlds[0]!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(input).split('?')[0]!);
    if (listHeld && String(input).startsWith('/api/inbox/threads')) await listHeld;
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    if (String(input).split('?')[0] === '/api/inbox/settings') settingsAnswered++;
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(name: string, listener: (event: MessageEvent) => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }
    removeEventListener() {}
    close() {}
  };
});

afterAll(async () => {
  if (!hasDom) return;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  asked = [];
  listeners.clear();
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

async function openWindow() {
  window.location.hash = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector(`[data-row="${world.stopped}"]`) !== null, 'the list');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

test.skipIf(!hasDom)('settings read at page load are on the page while the first list read is still out', async () => {
  expect((await loopback('/api/inbox/settings', 'POST', JSON.stringify({ text_size: 13 }))).status).toBe(200);
  let release = () => {};
  listHeld = new Promise<void>((done) => (release = done));
  readSettingsAtLoad();
  window.location.hash = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => document.documentElement.style.getPropertyValue('--inbox-text-size') === '13', 'the saved text size');
  expect(host.querySelector(`[data-row="${world.stopped}"]`)).toBeNull();
  release();
  listHeld = null;
  await until(() => host!.querySelector(`[data-row="${world.stopped}"]`) !== null, 'the list');
  expect(asked.filter((path) => path === '/api/inbox/settings')).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)('a settings read that brings the same settings (another window saved a switch) redraws none of the window', async () => {
  await openWindow();
  const status = listeners.get('capabilities') ?? [];
  expect(status.length).toBeGreaterThan(0);
  // The load's own reads finish first: on a slow runner one still lands after the list, and its draw is not the
  // settings read's. Quiet means 300 ms with nothing drawn.
  for (let i = 0; ; i++) {
    const settling = await drawsDuring(() => act(async () => void (await new Promise((r) => setTimeout(r, 300)))));
    if (settling.size === 0) break;
    if (i >= 20) throw new Error(`the window never went quiet: ${[...settling.keys()].join(', ')}`);
  }
  const before = settingsAnswered;
  const draws = await drawsDuring(async () => {
    for (const listener of status) listener(new MessageEvent('capabilities', { data: '{}' }));
    await until(() => settingsAnswered > before, 'the settings read');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
  });
  expect(draws.get('Sidebar') ?? 0).toBe(0);
  expect(draws.get('InboxList') ?? 0).toBe(0);
}, 30_000);
