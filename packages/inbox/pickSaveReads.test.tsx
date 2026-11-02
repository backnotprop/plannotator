/**
 * One read for a run of saved answers, not one per save. A card saves on every
 * change, and each save used to read the list, the thread, the drafts and the
 * files (twice for the list and the files): the owner's debug log, 2026-11-02,
 * shows that burst behind each of 81 saves on a phone. Each save's answer
 * already brought its questions, so those reads wait for the last save. The
 * window over a REAL Inbox (tests/helpers/inbox-dom-server.ts); the saves are
 * slowed and their records handed to the stream by hand, as the record frame
 * comes while the save's answer is still on its way.
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
/** Past the window's 80 ms pause after a record, so nothing but the hold can spare a read. */
const SAVE_MS = 130;

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
/** The stream the window holds: a test hands it frames. */
let frames: Map<string, (event: MessageEvent<string>) => void>;
let seq = 1_000_000;
let saves = 0;
let reads: string[] = [];
let slow = false;

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

const frame = (name: string, data: object) => frames.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) }));

const TESTS = 3;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-pick-reads-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let buffer = '';
  let first: string | null = null;
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      const at = buffer.indexOf('\n');
      if (at >= 0 && first === null) first = buffer.slice(0, at).trim();
    }
  })();
  for (let i = 0; i < 400 && first === null; i++) await new Promise((r) => setTimeout(r, 25));
  if (first === null) throw new Error('the Inbox did not start');
  const started = JSON.parse(first) as { port: number; worlds: World[] };
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
  saves = 0;
  reads = [];
  slow = false;
  frames = new Map();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    if (method === 'POST' && path.endsWith('/picks') && answer.status === 200) {
      saves += 1;
      if (slow) {
        const { questions } = JSON.parse(answer.text) as { questions: { key: string }[] };
        // The record frame beats the save's own answer.
        seq += 1;
        frame('record', { seq, kind: 'question', id: 'qst_any', question: questions[0] });
        await new Promise((r) => setTimeout(r, SAVE_MS));
      }
    }
    if (method === 'GET') reads.push(path.split('?')[0]!);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
      frames.set(name, listener);
    }
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

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await wait(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open() {
  window.location.hash = `#thread=${world.waiting}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  const field = () => host!.querySelector<HTMLInputElement>('input[aria-label^="Other answer"]');
  await until(() => field() !== null, 'the question card');
  await until(() => frames.has('record'), 'the stream');
  await wait(200);
  reads = [];
  return field()!;
}

function type(field: HTMLInputElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const threadRoute = () => `/api/inbox/threads/${world.waiting}`;
const count = (route: string) => reads.filter((path) => path === route).length;

test.skipIf(!hasDom)('a run of saves reads nothing until the last one lands, then the list, thread, drafts and files once', async () => {
  const field = await open();
  slow = true;
  let words = '';
  for (let i = 0; i < 24; i += 1) {
    words += 'w';
    type(field, words);
    await wait(25);
  }
  expect(saves).toBeGreaterThanOrEqual(3);
  // Saves went through, and the window read nothing for them.
  expect(reads.filter((path) => path.startsWith('/api/inbox/threads') || path === '/api/inbox/drafts' || path === '/api/inbox/decisions')).toEqual([]);

  await until(() => field.value === words && count(threadRoute()) > 0, 'the read after the last save');
  await wait(SAVE_MS + 120);
  expect(saves).toBeLessThan(10);
  expect(count(threadRoute())).toBe(1);
  expect(count(`${threadRoute()}/attachments`)).toBe(1);
  expect(count('/api/inbox/threads')).toBeLessThanOrEqual(2);
  expect(count('/api/inbox/threads')).toBeGreaterThanOrEqual(1);
  expect(count('/api/inbox/drafts')).toBe(1);
});

test.skipIf(!hasDom)('a record that is not a question line is read at once, whatever is saving', async () => {
  const field = await open();
  slow = true;
  type(field, 'a');
  await until(() => saves === 1, 'the save');
  // An agent wrote meanwhile: the thread is read now, not when the saves end.
  seq += 1;
  frame('record', { seq, kind: 'message', first: false, message: { id: 'msg_x', thread_id: world.waiting, author: { kind: 'agent' }, body: '' } });
  await wait(100);
  expect(count(threadRoute())).toBe(1);
});

test.skipIf(!hasDom)('no stream at all: the list still follows a saved answer', async () => {
  const field = await open();
  type(field, 'a');
  await until(() => saves === 1 && count('/api/inbox/threads') === 1, 'the list read after the save');
  // The stream silent, nothing else was read, and the answer is saved.
  expect(count(threadRoute())).toBe(0);
  const saved = JSON.parse((await loopback(threadRoute())).text) as { thread: { messages: { questions?: { answer: { other?: string } | null }[] }[] } };
  expect(saved.thread.messages[0]!.questions?.[0]?.answer?.other).toBe('a');
});
