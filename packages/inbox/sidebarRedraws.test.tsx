/**
 * Moving back to a thread already seen draws each of the sidebar's agent rows at most once (when the agents read
 * hands it a new agent), never once per draw of the window: each row is memoized, and every other prop it gets must
 * keep its identity across the window's draws. The live region's announcer was a new function on each draw, so all
 * rows, with their menus and tips, drew on every step (three times each here; about 600 row draws for the owner's
 * 40 agents when Settings opened). The whole window
 * (InboxApp) over a real Inbox with live agents (tests/helpers/inbox-dom-server.ts `tags`); the draws come from
 * React's commit hook (tests/helpers/react-draws.ts).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
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

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let world: { project: string; stopped: string; waiting: string } = { project: '', stopped: '', waiting: '' };
let dir: string | null = null;
let root: ReturnType<typeof createRoot> | null = null;
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-sidebar-redraws-dom-')));
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
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
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

const agentRows = () => host!.querySelectorAll('[data-sidebar-agent]').length;

async function openWindow() {
  window.location.hash = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => agentRows() > 1 && host!.querySelector(`[data-row="${world.stopped}"]`) !== null, 'the list and the agents');
}

async function openThread(id: string) {
  window.location.hash = `#thread=${id}`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await until(() => host!.querySelector(`section.ib-pane[data-thread-id="${id}"]`) !== null, `thread ${id}`);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

test.skipIf(!hasDom)('moving back to a thread already seen draws each agent row at most once', async () => {
  await openWindow();
  await openThread(world.stopped);
  await openThread(world.waiting);
  const draws = await drawsDuring(() => openThread(world.stopped));
  expect(agentRows()).toBeGreaterThan(1);
  expect(draws.get('AgentRow') ?? 0).toBeLessThanOrEqual(agentRows());
});
