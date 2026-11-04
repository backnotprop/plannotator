/**
 * The window's reads after an agent's message (#2593), over the whole window
 * (InboxApp) and a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts). What this catches: the list read again
 * whole after every message (it names the list it holds and takes only the
 * changed rows); the drafts and Tidy read again after a message that cannot
 * change them; the drafts NOT read after a message in a thread holding unsent
 * work, or Tidy not read when its menu opens; and a list put together from
 * changes drawn any differently from a fresh window's (rows, order, bold,
 * sections, the sidebar's counts).
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
const { resetListReads } = (hasDom ? await import('./api') : {}) as typeof import('./api');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; stopped: string; waiting: string; picked: string; news: string[] };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', stopped: '', waiting: '', picked: '', news: [] };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
/** Every GET the window made (path and query), and what each list read was answered with. */
let reads: string[] = [];
let listAnswers: ('delta' | 'whole')[] = [];
let sendRecord: ((record: unknown) => void) | null = null;
let seq = 1_000_000;

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

/** An agent writes in a thread; the window hears the message's record as the event stream sends it. */
async function agentWrites(threadId: string): Promise<void> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_late', body: `More news (${Date.now()}).`, reply_to: threadId } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  const sent = (JSON.parse(await readLine()) as { sent: string }).sent;
  const thread = JSON.parse((await loopback(`/api/inbox/threads/${threadId}`)).text) as { thread: { messages: { id: string }[] } };
  const message = thread.thread.messages.find((m) => m.id === sent)!;
  expect(message).toBeDefined();
  act(() => sendRecord!({ seq: ++seq, kind: 'message', id: sent, message }));
}

const count = (path: string) => reads.filter((p) => p.split('?')[0] === path).length;
const listReads = () => reads.filter((p) => p.startsWith('/api/inbox/threads?'));

const TESTS = 2;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-list-delta-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'news'], {
    // The preload's PLANNOTATOR_TEST_SANDBOX carries over: the Inbox's agent home is a scratch one in its data dir.
    env: {
      ...process.env,
      DOM_TESTS: '0',
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      NO_ANON_PING: '1',
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    },
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
  reads = [];
  listAnswers = [];
  resetListReads();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET') reads.push(path);
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    if (method === 'GET' && path.startsWith('/api/inbox/threads?')) listAnswers.push('delta' in (JSON.parse(answer.text) as object) ? 'delta' : 'whole');
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  // The event stream is a stand-in: only the records a test sends reach the window.
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') sendRecord = (record) => listener({ data: JSON.stringify(record) } as MessageEvent<string>);
    }
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: false,
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
  unmount();
  globalThis.fetch = savedFetch;
  sendRecord = null;
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

function mount(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

/** What the list and the sidebar draw, without the times (a minute may turn between two windows). */
function drawn(el: HTMLElement) {
  const rows = [...el.querySelectorAll<HTMLElement>('.ib-row[data-thread-id]')].map((row) => `${row.dataset.threadId}|${row.dataset.section}|${row.classList.contains('ib-u') ? 'bold' : ''}`);
  const sidebar = (el.querySelector('.ib-side')?.textContent ?? '').replace(/\s+/g, ' ');
  return { rows, sidebar };
}

const listShown = (el: HTMLElement) => el.querySelectorAll('.ib-row[data-thread-id]').length > 0;

test('an agent message elsewhere: the list read takes only the changed rows; the drafts and Tidy are not read; the list drawn is a fresh window\'s', async () => {
  if (!hasDom) return;
  const el = mount();
  await until(() => listShown(el) && sendRecord !== null, 'the list and the stream');
  await wait(500);
  const drafts = count('/api/inbox/drafts');
  const tidy = count('/api/inbox/tidy');
  const lists = listReads().length;
  expect(lists).toBeGreaterThan(0);

  // Two threads with no unsent work; one a news thread the list shows as new.
  await agentWrites(world.stopped);
  await until(() => listReads().length > lists, 'the list read after the first message');
  await agentWrites(world.news[0]!);
  await until(() => listReads().length > lists + 1, 'the list read after the second message');
  await wait(500);

  expect(count('/api/inbox/drafts')).toBe(drafts);
  expect(count('/api/inbox/tidy')).toBe(tidy);
  // The first read was whole; each read after it named the list held and was answered with the changes.
  expect(listAnswers[0]).toBe('whole');
  expect(listReads().slice(1).every((path) => /[?&]since=[^&]+/.test(path))).toBe(true);
  expect(listAnswers.slice(1).every((answer) => answer === 'delta')).toBe(true);

  // Show: the list on screen takes everything; it is what a fresh window draws.
  const show = el.querySelector<HTMLButtonElement>('[data-inbox-notice]');
  if (show) act(() => show.click());
  await wait(500);
  const merged = drawn(el);
  unmount();
  resetListReads();
  const fresh = mount();
  await until(() => listShown(fresh), 'the fresh window');
  await wait(500);
  expect(merged).toEqual(drawn(fresh));
}, 30_000);

test('a message in a thread holding unsent work reads the drafts; Tidy is read when its menu opens', async () => {
  if (!hasDom) return;
  const el = mount();
  await until(() => listShown(el) && sendRecord !== null, 'the list and the stream');
  await wait(500);
  const drafts = count('/api/inbox/drafts');
  const tidy = count('/api/inbox/tidy');

  // The person picked in this thread and has not sent it: its row and the Drafts page can change.
  await agentWrites(world.picked);
  await until(() => count('/api/inbox/drafts') > drafts, 'the drafts read');

  // A message elsewhere made the plan stale; opening ⋮ reads it.
  await agentWrites(world.stopped);
  await wait(500);
  expect(count('/api/inbox/tidy')).toBe(tidy);
  const trigger = el.querySelector<HTMLButtonElement>('.ib-lhead [data-tidy-menu]');
  expect(trigger).not.toBeNull();
  act(() => trigger!.click());
  await until(() => count('/api/inbox/tidy') > tidy, 'the Tidy read as its menu opens');
}, 30_000);
