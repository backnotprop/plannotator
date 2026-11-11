/**
 * The window's wiring of openThreadReads.ts (App.tsx `readAfterRecord`), over
 * the whole window (InboxApp) and a REAL Inbox in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts). The open thread is listed and
 * its repo is known (the scratch projects have no git `origin`, so the test's
 * fetch adds one to the thread read): the case where another thread's record
 * skips the thread read. Failures to catch: a record that cannot change the
 * open thread's files reading them again; a thread deleted elsewhere (no record says so) left on screen because the
 * list read that no longer has it does not read it; and the open thread's
 * own record (an agent's message in it) not drawn in place from the record,
 * or read the whole thread again (data/apply/stream.ts).
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

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

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
/** Every GET the window made, by path. */
let reads: string[] = [];
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

const threadReads = (id: string) => reads.filter((p) => p === `/api/inbox/threads/${id}`).length;
const filesReads = (id: string) => reads.filter((p) => p === `/api/inbox/threads/${id}/attachments`).length;

const TESTS = 2;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-open-reads-dom-')));
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
  reads = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET') reads.push(path.split('?')[0]!);
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    let text = answer.text;
    // The thread's repo is known (as for a project with a git origin): another thread's record needs no thread read.
    if (method === 'GET' && answer.status === 200 && /^\/api\/inbox\/threads\/msg_[A-Z0-9]+$/.test(path)) {
      const body = JSON.parse(text) as { thread: { project: { repo?: unknown } } };
      body.thread.project.repo = { display: 'acme/web', host: 'github.com' };
      text = JSON.stringify(body);
    }
    return new Response(text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
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
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
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

function openAt(threadId: string): HTMLElement {
  window.location.hash = `#thread=${threadId}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

const pane = (el: HTMLElement, id: string) => el.querySelector(`section.ib-pane[data-thread-id="${id}"]`);
const listReads = () => reads.filter((p) => p === '/api/inbox/threads').length;

test("another thread's record reads nothing of the open thread; its own record (no file) draws in place, with no read", async () => {
  if (!hasDom) return;
  const el = openAt(world.waiting);
  await until(() => pane(el, world.waiting) !== null && sendRecord !== null && filesReads(world.waiting) > 0, 'the open thread and its files');
  await wait(300);
  const thread = threadReads(world.waiting);
  const files = filesReads(world.waiting);
  const lists = listReads();

  await agentWrites(world.stopped);
  await until(() => listReads() > lists, 'the list read');
  await wait(300);
  expect(threadReads(world.waiting)).toBe(thread);
  expect(filesReads(world.waiting)).toBe(files);

  const drawn = () => pane(el, world.waiting)?.querySelectorAll('[data-message-article]').length ?? 0;
  const before = drawn();
  await agentWrites(world.waiting);
  await until(() => drawn() > before, "the open thread's own record drawn");
  await wait(300);
  expect(threadReads(world.waiting)).toBe(thread);
  // A message with no file moves no file: its files are not read again.
  expect(filesReads(world.waiting)).toBe(files);
}, 15000);

test('a thread deleted elsewhere: the next record of another thread reads it once the list lacks it, and the pane says it is gone', async () => {
  if (!hasDom) return;
  const el = openAt(world.waiting);
  await until(() => pane(el, world.waiting) !== null && sendRecord !== null, 'the open thread');
  await wait(300);
  const thread = threadReads(world.waiting);
  // Another window deletes it: no record says so.
  expect((await loopback(`/api/inbox/threads/${world.waiting}/delete`, 'POST', '{}')).status).toBe(200);
  await agentWrites(world.stopped);
  await until(() => threadReads(world.waiting) > thread, 'the read of the thread the list no longer has');
  await until(() => el.querySelector('[data-thread-wait]')?.getAttribute('data-thread-wait') === 'missing', 'the missing line');
}, 15000);
