/**
 * One name per project on screen (owner's pick, 2026-10-29: the folder's
 * name, the parent only when two projects on screen share it), while the list
 * is held. The list holds still while a thread is open and the sidebar does
 * not: archiving a project's only thread takes it out of the sidebar at once,
 * but its row stays on screen until the thread closes. The real-data check of
 * #2349 found the two then named the other "superfans" project two ways (the
 * sidebar "superfans", its row "superfans · a"). The whole window (InboxApp)
 * over a REAL Inbox in a temp data dir (tests/helpers/inbox-dom-server.ts).
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

let child: ReturnType<typeof Bun.spawn> | null = null;
let lines: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let world: { waiting: string };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;

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
    const { value, done } = await lines!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

/** An agent's first message from `root`: the folder becomes a project. */
async function firstFrom(root: string): Promise<{ sent: string; project: string }> {
  const stdin = child!.stdin as import('bun').FileSink;
  stdin.write(`${JSON.stringify({ first: { root, session: `ses_${root.split('/').at(-2)}`, body: `News from ${root}.` } })}\n`);
  await stdin.flush();
  return JSON.parse(await readLine()) as { sent: string; project: string };
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-label-held-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  lines = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await readLine()) as { port: number; worlds: { waiting: string }[] };
  port = started.port;
  world = started.worlds[0]!;
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
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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
  document.body.innerHTML = '';
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

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

const projectRow = (id: string) => document.querySelector<HTMLElement>(`.ib-projrow[data-project="${id}"]`);
const sidebarName = (id: string) => projectRow(id)?.querySelector('.ib-name')?.textContent ?? null;
const rowName = (threadId: string) => document.querySelector(`.ib-listcol [data-thread-id="${threadId}"] .ib-p`)?.textContent ?? null;

test.skipIf(!hasDom)('archiving the only thread of a clashing project while the list is held: the sidebar and the rows name the other one the same', async () => {
  const a = await firstFrom(join(dir!, 'projects', 'a', 'superfans'));
  const b = await firstFrom(join(dir!, 'projects', 'b', 'superfans'));
  window.location.hash = `#thread=${world.waiting}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!document.querySelector('section.ib-pane') && !!projectRow(a.project) && rowName(a.sent) !== null, 'the thread, the sidebar and the rows');
  // Two "superfans" on screen: each names its parent, the same in both places.
  expect(sidebarName(a.project)).toBe('superfans · a');
  expect(rowName(a.sent)).toBe('superfans · a');

  // Archive b's only thread from its project menu, the thread still open: b leaves the sidebar at once,
  // its row stays on screen (the held list) until the thread closes.
  await press(projectRow(b.project)!.querySelector<HTMLElement>('.ib-pmore')!);
  await until(() => !!document.querySelector(`[data-project-menu="${b.project}"] [data-project-action="archive"]`), 'the menu');
  await act(async () => {
    document.querySelector<HTMLElement>(`[data-project-menu="${b.project}"] [data-project-action="archive"]`)!.click();
  });
  await until(() => projectRow(b.project) === null, 'b to leave the sidebar');
  expect(rowName(b.sent)).not.toBeNull();

  // One name for a in both places while b's row is still on screen.
  expect(sidebarName(a.project)).toBe(rowName(a.sent));
  expect(rowName(a.sent)).toBe('superfans · a');
});
