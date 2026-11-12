import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PHONE_QUERY } from './phone';

const hasDom = typeof document !== 'undefined';
const { InboxApp, THREAD_READ_RETRY_MS, THREAD_READ_TIMEOUT_MS } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string; stopped: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '', stopped: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let failures: ('reset' | 500 | 'hang')[] = [];
let threadReads: string[] = [];
let readAt: number[] = [];
let hold: Promise<void> | null = null;
let posted: string[] = [];

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

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

async function agentSends(body: string, reply_to: string): Promise<string> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_late', body, reply_to } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

let pokeStream: (() => void) | null = null;

const TESTS = 7;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-thread-retry-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await readLine()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
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
  world = worlds.shift()!;
  failures = [];
  threadReads = [];
  readAt = [];
  hold = null;
  posted = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST') posted.push(path);
    if (method === 'GET' && /^\/api\/inbox\/threads\/msg_[A-Z0-9]+$/.test(path)) {
      threadReads.push(path);
      readAt.push(performance.now());
      const failure = failures.shift();
      if (failure === 'reset') throw new TypeError('Failed to fetch');
      if (failure === 'hang')
        return await new Promise<Response>((_, fail) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener('abort', () => fail(new DOMException('The operation was aborted.', 'AbortError')));
        });
      if (failure === 500) return new Response(JSON.stringify({ error: 'Internal error.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      if (hold) await hold;
    }
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') pokeStream = () => listener({ data: '' } as MessageEvent<string>);
    }
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === PHONE_QUERY ? false : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  pokeStream = null;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const TEST_MS = 20_000;

async function until(check: () => boolean, what: string, ms = 5000) {
  const deadline = performance.now() + ms;
  for (;;) {
    if (check()) return;
    if (performance.now() >= deadline) break;
    await wait(25);
  }
  const place = host ? (waiting(host)?.getAttribute('data-thread-wait') ?? (host.querySelector('section.ib-pane[data-thread-id]') ? 'a thread' : 'nothing')) : 'no window';
  throw new Error(`timed out waiting for ${what} (${threadReads.length} thread reads; the thread's place shows: ${place})`);
}

function renderAt(hash: string): HTMLElement {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

const pane = (el: HTMLElement, id: string) => el.querySelector(`section.ib-pane[data-thread-id="${id}"]`);
const waiting = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-thread-wait]');

for (const kind of ['reset', 500] as const) {
  test(`a first read that fails (${kind === 'reset' ? 'a dropped connection' : 'a 500'}) is read again by itself, with no event-stream re-read`, async () => {
    if (!hasDom) return;
    failures = [kind];
    let answer!: () => void;
    hold = new Promise<void>((done) => (answer = done));
    const el = renderAt(`#thread=${world.waiting}`);
    await until(() => waiting(el)?.getAttribute('data-thread-wait') === 'failed', 'the failed line');
    expect(waiting(el)!.textContent).toContain("Couldn't load this thread");
    expect(el.querySelector('[data-thread-wait-retry]')).not.toBeNull();
    await until(() => threadReads.length === 2, 'the retry', 3000);
    expect(readAt[1]! - readAt[0]!).toBeGreaterThanOrEqual(THREAD_READ_RETRY_MS[0] - 20);
    expect(readAt[1]! - readAt[0]!).toBeLessThan(THREAD_READ_RETRY_MS[0] + 2500);
    expect(waiting(el)?.getAttribute('data-thread-wait')).toBe('failed');
    answer();
    await until(() => pane(el, world.waiting) !== null, 'the thread', 3000);
    expect(threadReads.length).toBe(2);
    expect(waiting(el)).toBeNull();
    await until(() => posted.some((p) => p === `/api/inbox/threads/${world.waiting}/seen`), 'the look');
  }, TEST_MS);
}

test('Try again reads at once; a read that keeps failing keeps being tried', async () => {
  if (!hasDom) return;
  failures = ['reset', 'reset', 500, 500, 500, 500];
  const el = renderAt(`#thread=${world.stopped}`);
  await until(() => waiting(el)?.getAttribute('data-thread-wait') === 'failed', 'the failed line');
  await until(() => threadReads.length === 2, 'the first retry', 2000);
  await wait(200);
  expect(threadReads.length).toBe(2);
  failures = [];
  const retry = el.querySelector<HTMLButtonElement>('[data-thread-wait-retry]')!;
  act(() => {
    retry.focus();
    retry.click();
  });
  await until(() => pane(el, world.stopped) !== null, 'the thread after Try again', 1500);
  expect(threadReads.length).toBe(3);
  expect(document.activeElement).toBe(pane(el, world.stopped)!.querySelector('.ib-subject'));
}, TEST_MS);

test('a read with no answer fails after THREAD_READ_TIMEOUT_MS and is read again', async () => {
  if (!hasDom) return;
  failures = ['hang'];
  const opened = performance.now();
  const el = renderAt(`#thread=${world.waiting}`);
  await until(() => waiting(el)?.getAttribute('data-thread-wait') === 'loading', 'the opening line');
  expect(waiting(el)!.getAttribute('aria-busy')).toBe('true');
  await until(() => pane(el, world.waiting) !== null, 'the thread after the timeout', THREAD_READ_TIMEOUT_MS + 3000);
  const took = performance.now() - opened;
  expect(took).toBeGreaterThanOrEqual(THREAD_READ_TIMEOUT_MS);
  expect(took).toBeLessThan(THREAD_READ_TIMEOUT_MS + THREAD_READ_RETRY_MS[0] + 2500);
  expect(threadReads.length).toBe(2);
}, THREAD_READ_TIMEOUT_MS + TEST_MS);

test('opening another thread, or closing, stops the retries', async () => {
  if (!hasDom) return;
  failures = Array.from({ length: 50 }, () => 'reset' as const);
  const el = renderAt(`#thread=${world.waiting}`);
  await until(() => threadReads.length >= 2, 'a retry of the first thread', 2000);
  failures = [];
  act(() => {
    window.location.hash = `#thread=${world.stopped}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => pane(el, world.stopped) !== null, 'the second thread');
  const firstReads = () => threadReads.filter((p) => p.endsWith(world.waiting)).length;
  const before = firstReads();
  await wait(THREAD_READ_RETRY_MS[1] + THREAD_READ_RETRY_MS[2] + 300);
  expect(firstReads()).toBe(before);
  failures = Array.from({ length: 50 }, () => 'reset' as const);
  act(() => {
    window.location.hash = `#thread=${world.waiting}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => waiting(el)?.getAttribute('data-thread-wait') === 'failed', 'the failed line again');
  expect(waiting(el)!.getAttribute('aria-busy')).toBe('false');
  act(() => {
    window.location.hash = '';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => waiting(el) === null, 'the thread closed');
  const atClose = threadReads.length;
  await wait(THREAD_READ_RETRY_MS[1] + THREAD_READ_RETRY_MS[2] + 300);
  expect(threadReads.length).toBe(atClose);
}, TEST_MS + 10_000);

test("a record's re-read of the open thread that fails is read again until it lands, then stops; closing stops it", async () => {
  if (!hasDom) return;
  const el = renderAt(`#thread=${world.waiting}`);
  await until(() => pane(el, world.waiting) !== null && pokeStream !== null, 'the thread');
  await wait(300);
  const body = `Canary at 25%; error rate flat (${Date.now()}).`;
  await agentSends(body, world.waiting);
  const before = threadReads.length;
  failures = ['reset', 500];
  act(() => pokeStream!());
  await until(() => pane(el, world.waiting)?.textContent?.includes(body) === true, "the agent's message", THREAD_READ_RETRY_MS[0] + THREAD_READ_RETRY_MS[1] + 2500);
  expect(threadReads.length - before).toBe(3);
  expect(waiting(el)).toBeNull();
  await wait(THREAD_READ_RETRY_MS[2] + 300);
  expect(threadReads.length - before).toBe(3);

  failures = Array.from({ length: 50 }, () => 'reset' as const);
  const second = threadReads.length;
  act(() => pokeStream!());
  await until(() => threadReads.length - second >= 2, 'the re-read and its first retry', 2000);
  act(() => {
    window.location.hash = '';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => pane(el, world.waiting) === null, 'the thread closed');
  const atClose = threadReads.length;
  await wait(THREAD_READ_RETRY_MS[1] + THREAD_READ_RETRY_MS[2] + 300);
  expect(threadReads.length).toBe(atClose);
}, TEST_MS + 10_000);

test('a thread the server does not have says so, offers Close, and is not read again', async () => {
  if (!hasDom) return;
  const gone = 'msg_01ZZZZZZZZZZZZZZZZZZZZZZZZ';
  const el = renderAt(`#thread=${gone}`);
  await until(() => waiting(el)?.getAttribute('data-thread-wait') === 'missing', 'the missing line');
  expect(waiting(el)!.textContent).toContain('not in the Inbox');
  await wait(THREAD_READ_RETRY_MS[0] + 400);
  expect(threadReads.length).toBe(1);
  act(() => el.querySelector<HTMLButtonElement>('[data-thread-wait-close]')!.click());
  await until(() => !window.location.hash.includes(gone) && waiting(el) === null, 'the thread closed');
}, TEST_MS);
