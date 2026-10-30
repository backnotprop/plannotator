/**
 * The count on the tab (approval "inbox-tab-count"), as the window keeps it:
 * the whole window (InboxApp) over a REAL Inbox in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts). What is proved: the title
 * reads "(N) Plannotator Inbox" and the favicon link carries a badged icon
 * while threads hold agent messages the person has not looked at; a seen
 * thread with an open question does not count; an agent's new message raises
 * it; opening a thread lowers it; at zero the title and the plain icon come
 * back. happy-dom has no 2D canvas, so the icon here is the SVG form; the PNG
 * a browser draws is shown by the screenshots in the PR.
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
import type { InboxListSection } from '@plannotator/core/inbox-types';

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

/** An agent starts a thread while the window is open (the server's stdin). */
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
  // The page as apps/inbox/index.html serves it.
  document.title = 'Plannotator Inbox';
  document.head.querySelector('link[rel="icon"]')?.remove();
  const link = document.createElement('link');
  link.rel = 'icon';
  link.setAttribute('href', '/favicon.png');
  document.head.appendChild(link);
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  pokeStream = null;
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
  // Every seeded thread is looked at but the one an agent is stopped on. The waiting
  // thread keeps its open question, which the sidebar counts and the tab does not.
  for (const row of await serverRows()) {
    if (row.thread_id !== world.stopped) await loopback(`/api/inbox/threads/${row.thread_id}/seen`, 'POST', '{}');
  }
  const waitingRow = (await serverRows()).find((r) => r.thread_id === world.waiting)!;
  expect(waitingRow.questions.open).toBeGreaterThan(0);
  expect(waitingRow.unseen).toBe(0);

  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => document.title === '(1) Plannotator Inbox', 'one thread counted');
  await until(() => iconLabel() === '1', 'the badged icon');
  expect(iconHref().startsWith('data:image/svg+xml')).toBe(true);
  // The plain icon rides inside the badged one.
  expect(decodeURIComponent(iconHref())).toContain('href="data:image/png;base64,');

  // An agent starts a thread: the count rises.
  const fresh = await agentSends('A fresh finding about the build.');
  act(() => pokeStream?.());
  await until(() => document.title === '(2) Plannotator Inbox' && iconLabel() === '2', 'the agent message counted');

  // Opening it is the look: the count falls.
  openThread(fresh);
  await until(() => document.title === '(1) Plannotator Inbox' && iconLabel() === '1', 'the opened thread cleared');

  // Opening the last one: no prefix, the plain icon again.
  openThread(world.stopped);
  await until(() => document.title === 'Plannotator Inbox' && iconHref() === '/favicon.png', 'the plain tab');
});
