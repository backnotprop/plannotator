/**
 * A subject an older Inbox kept verbatim, holding an agent's leaked
 * tool-call text and a line break (the owner's thread
 * msg_01M5DBNXYNG5TA0DZV6C42PYRQ), shows in the window as the one line the
 * agent meant: in its list row and in the thread's header, never the raw
 * `</subject>` / `<parameter name=…>` text. The whole window (InboxApp) over
 * a REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts `leaked-subject`, which writes the raw
 * line as the old store did).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const SHOWN = 'Everything of mine waiting on you or ready to look at, in one place';

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let leaked = '';
let listHeld: Promise<void> | null = null;
let looks = 0;
let threadReads = 0;
let failFirstList = false;
let releaseList = () => {};
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

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-leaked-subject-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'leaked-subject'], {
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
  const started = JSON.parse(line.trim()) as { port: number; worlds: { leaked: string }[] };
  port = started.port;
  leaked = started.worlds[0]!.leaked;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (failFirstList && path === '/api/inbox/threads') {
      failFirstList = false;
      listHeld = new Promise<void>((done) => (releaseList = done));
      throw new TypeError('Failed to fetch');
    }
    if (listHeld && path === '/api/inbox/threads') await listHeld;
    if ((init?.method ?? 'GET') === 'POST' && path.endsWith('/seen')) looks += 1;
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    if ((init?.method ?? 'GET') === 'GET' && path === `/api/inbox/threads/${leaked}`) threadReads += 1;
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
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

test.skipIf(!hasDom)('an old leaked subject shows as its first line in the list row and the thread header; opened from its link, the thread is looked at only after the first list read lands', async () => {
  window.location.hash = `#thread=${leaked}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  let release = () => {};
  listHeld = new Promise<void>((done) => (release = done));
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => threadReads > 0, 'the thread read');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(looks).toBe(0);
  release();
  listHeld = null;
  await until(() => host!.querySelector('.ib-subject') !== null && host!.querySelector(`[data-row="${leaked}"]`) !== null, 'the row and the thread');
  await until(() => looks > 0, 'the look');
  const row = host.querySelector(`[data-row="${leaked}"]`)!;
  expect(row.textContent).toContain(SHOWN);
  expect(host.querySelector('.ib-subject')!.textContent).toBe(SHOWN);
  const everything = host.textContent ?? '';
  expect(everything).not.toContain('</subject>');
  expect(everything).not.toContain('<parameter');
  expect(everything).not.toContain('ws-rollup-2026-10-20-a');
}, 30_000);

test.skipIf(!hasDom)('when the first list read fails, the thread opened from its link is still looked at, once, without waiting for a list', async () => {
  looks = 0;
  failFirstList = true;
  window.location.hash = `#thread=${leaked}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => looks > 0, 'the look');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(looks).toBe(1);
  releaseList();
  listHeld = null;
  await until(() => host!.querySelector('.ib-subject') !== null, 'the thread');
  expect(looks).toBe(1);
}, 30_000);
