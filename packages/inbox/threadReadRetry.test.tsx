/**
 * Opening a thread whose read fails or hangs. Context: the owner (0.28.25)
 * saw the right side stay empty for 5-10 s after opening a thread link; why
 * his read failed is not known. Measured in a sandbox Inbox: a thread of that
 * shape opens in about 0.5 s cold, but ONE failed read of
 * `GET /api/inbox/threads/:id` (a dropped connection, a 5xx) left the right
 * side blank, with no word and no retry, until some agent wrote anywhere in
 * the Inbox (the event stream re-reads the open thread), and a read with no
 * answer waited for good.
 *
 * What is proved, over the whole window (InboxApp) and a REAL Inbox in a temp
 * data dir (its own process, tests/helpers/inbox-dom-server.ts): with the
 * first read failing as a dropped connection and as a 500, and NO store line
 * written meanwhile (the event stream is a stand-in nobody pokes), the thread
 * is on screen within the first retry and its look is recorded; a read with
 * no answer fails after THREAD_READ_TIMEOUT_MS and is read again; while the
 * read is failing the thread's place says so and offers Try again, which
 * reads at once and, holding focus, hands it to the thread's subject; opening
 * another thread or closing stops the retries; a thread the server does not
 * have (404) says so with Close and is not read again.
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
/** How each read of the thread fails, first to last; past the list it is answered by the server. */
let failures: ('reset' | 500 | 'hang')[] = [];
/** Every read of `GET /api/inbox/threads/<id>` the window made. */
let threadReads: string[] = [];
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

const TESTS = 6;

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
  posted = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST') posted.push(path);
    if (method === 'GET' && /^\/api\/inbox\/threads\/msg_[A-Z0-9]+$/.test(path)) {
      threadReads.push(path);
      const failure = failures.shift();
      if (failure === 'reset') throw new TypeError('Failed to fetch');
      // No answer: only the window's own timeout (its AbortSignal) ends it.
      if (failure === 'hang')
        return await new Promise<Response>((_, fail) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener('abort', () => fail(new DOMException('The operation was aborted.', 'AbortError')));
        });
      if (failure === 500) return new Response(JSON.stringify({ error: 'Internal error.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  // The event stream is a stand-in that never fires: no store line re-reads the open thread here.
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
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
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 25) {
    if (check()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Open the window straight on a thread link, as a click on `…/#thread=<id>` does. */
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
    const opened = performance.now();
    const el = renderAt(`#thread=${world.waiting}`);
    // While the read is failing, the thread's place says so (it used to be blank).
    await until(() => waiting(el)?.getAttribute('data-thread-wait') === 'failed', 'the failed line');
    expect(waiting(el)!.textContent).toContain("Couldn't load this thread");
    expect(el.querySelector('[data-thread-wait-retry]')).not.toBeNull();
    // Read again by itself, within the first wait: no store line, no event, no click.
    await until(() => pane(el, world.waiting) !== null, 'the thread', 3000);
    expect(performance.now() - opened).toBeLessThan(THREAD_READ_RETRY_MS[0] + 2500);
    expect(threadReads.length).toBe(2);
    expect(waiting(el)).toBeNull();
    // Its look is recorded, as for a read that lands at once.
    await until(() => posted.some((p) => p === `/api/inbox/threads/${world.waiting}/seen`), 'the look');
  });
}

test('Try again reads at once; a read that keeps failing keeps being tried', async () => {
  if (!hasDom) return;
  failures = ['reset', 'reset', 500, 500, 500, 500];
  const el = renderAt(`#thread=${world.stopped}`);
  await until(() => waiting(el)?.getAttribute('data-thread-wait') === 'failed', 'the failed line');
  // The first retry fails too (THREAD_READ_RETRY_MS[0]), then the window waits longer.
  await until(() => threadReads.length === 2, 'the first retry', 2000);
  await wait(200);
  expect(threadReads.length).toBe(2);
  // Try again: one read now, not after the wait.
  failures = [];
  const retry = el.querySelector<HTMLButtonElement>('[data-thread-wait-retry]')!;
  act(() => {
    retry.focus();
    retry.click();
  });
  await until(() => pane(el, world.stopped) !== null, 'the thread after Try again', 1500);
  expect(threadReads.length).toBe(3);
  // Focus was on Try again: it goes to the thread's subject, not to the page.
  expect(document.activeElement).toBe(pane(el, world.stopped)!.querySelector('.ib-subject'));
});

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
}, THREAD_READ_TIMEOUT_MS + 8000);

test('opening another thread, or closing, stops the retries', async () => {
  if (!hasDom) return;
  failures = Array.from({ length: 50 }, () => 'reset' as const);
  const el = renderAt(`#thread=${world.waiting}`);
  await until(() => threadReads.length >= 2, 'a retry of the first thread', 2000);
  // Another thread opens (its reads are answered): the first one is not read again.
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
  // A failing thread, then closed: no read after the close.
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
}, 15000);

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
});
