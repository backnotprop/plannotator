/**
 * Hide pull request from the Inbox list, as the whole window (InboxApp) draws it over a REAL Inbox server in a temp data
 * dir (its own process, tests/helpers/inbox-dom-server.ts `pulls`: Code review on, each world's `waiting` thread with
 * one open PR of its own). What regresses: the Undo of a Hide made in the Inbox list (its row menu) leaving the thread
 * out of the list on screen, or holding it behind "N new" as if an agent had written: an Undo is the person's own
 * write, so the row comes back in place at once. No forge is read: a `gh` that always fails is first on PATH.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetListGroupsForTests } from './listGroups';

// Each test waits on another process's answers several times over.
setDefaultTimeout(30_000);

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World;
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-hide-list-dom-')));
  mkdirSync(join(dir, 'bin'));
  // Never the real tailscale or forge CLIs.
  for (const cli of ['tailscale', 'gh', 'glab']) {
    writeFileSync(join(dir, 'bin', cli), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, 'bin', cli), 0o755);
  }
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '2', 'pulls'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const lines = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await lines.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  const started = JSON.parse(line.trim()) as { port: number; worlds: World[] };
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
  ids = worlds.shift()!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  // No event stream: what brings the row back must be the window's own write, not another read.
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  resetListGroupsForTests();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  document.body.innerHTML = '';
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const rowButton = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`);
const menu = () => document.querySelector<HTMLElement>('[data-row-menu]');
const item = (action: string) => menu()?.querySelector<HTMLElement>(`[data-row-action="${action}"]`) ?? null;
const undo = () => document.querySelector<HTMLElement>('[data-inbox-toast] [data-toast-undo]');

test.skipIf(!hasDom)("Undo of a Hide made from the Inbox list's row menu brings the row back in place at once, not behind \"N new\"", async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!rowButton(ids.waiting), 'the list');

  await act(async () => {
    rowButton(ids.waiting)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => !!item('hide-pulls'), "the menu's Hide pull request");
  await act(async () => {
    item('hide-pulls')!.click();
  });
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  await until(() => !!undo(), 'the toast with Undo');

  await act(async () => {
    undo()!.click();
  });
  // The server shows the PR again; the window puts its thread back as its own write.
  await until(() => !!rowButton(ids.waiting), 'the row back in place');
  expect(document.querySelector('.pn-inbox')?.textContent ?? '').not.toMatch(/\b1 new\b/);
});
