/**
 * The warning before a Mark read that sets questions aside (the owner's ask, 2026-11-10: "warn the user if it will
 * close out questions with a set-aside message to the agent, and ask if they want to continue. Option to never show
 * the warning again."), as the window draws it: the whole window (InboxApp) over a REAL Inbox in a temp data dir (its
 * own process, tests/helpers/inbox-dom-server.ts, which starts every world with the warning off; each test here turns
 * it on first, as a person who never ticked "Don't show this again" has it). What is proved:
 *
 *  - Mark read on a thread with open questions asks first; Cancel writes nothing (no Mark read, the questions stay
 *    open), and going on (Enter) does what Mark read did before (the questions close, the toast);
 *  - Mark read on a thread with no question never asks;
 *  - "Don't show this again" saves the switch off on the Inbox (so every window and the next load skip it) and the
 *    next Mark read with questions goes without asking;
 *  - the project menu's Mark all as read asks once for the batch; Cancel sends no batch.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. It starts an Inbox: CI runs it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { resetListGroupsForTests } from './listGroups';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; stopped: string; waiting: string; news: string[] };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World = { project: '', stopped: '', waiting: '', news: [] };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];

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

async function questionStates(threadId: string): Promise<string[]> {
  const model = JSON.parse((await loopback(`/api/inbox/threads/${threadId}`)).text) as { thread: { messages: { questions?: InboxQuestion[] }[] } };
  return model.thread.messages.flatMap((m) => m.questions ?? []).map((q) => q.state);
}

async function warningOnServer(): Promise<boolean | undefined> {
  return (JSON.parse((await loopback('/api/inbox/settings')).text) as { mark_read_warning?: { on: boolean } }).mark_read_warning?.on;
}

/** The person has the warning (as everyone does until they tick "Don't show this again"). */
async function warningOn(): Promise<void> {
  const answer = await loopback('/api/inbox/settings', 'POST', JSON.stringify({ mark_read_warning: { on: true } }));
  expect(answer.status).toBe(200);
}

const TESTS = 4;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-readwarn-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'news'], {
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
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  posted = [];
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
});

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash = '') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await settle();
  return host;
}

const warning = () => document.querySelector<HTMLElement>('[data-dialog="mark-read-warning"]');
const readPosts = (threadId: string) => posted.filter((p) => p.path === `/api/inbox/threads/${threadId}/read`);
/** Open the thread header's ⋯ and return its item `selector` (null when the menu has none). */
async function moreItem(el: HTMLElement, selector: string): Promise<HTMLElement | null> {
  const more = el.querySelector<HTMLElement>('section.ib-pane [data-thread-more]')!;
  await act(async () => {
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    more.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    more.click();
  });
  await until(() => !!document.querySelector('[data-thread-menu]'), 'the ⋯ menu');
  return document.querySelector<HTMLElement>(`[data-thread-menu] ${selector}`);
}

const rowAction = (el: HTMLElement, threadId: string) => el.querySelector<HTMLButtonElement>(`[data-row="${threadId}"] [data-row-mark-read]`);

test.skipIf(!hasDom)('Mark read on a thread with questions asks first: Cancel writes nothing; Enter goes on as Mark read did', async () => {
  await warningOn();
  const el = await renderApp(`#thread=${ids.stopped}`);
  await until(() => !!el.querySelector('section.ib-pane [data-thread-more]'), 'the header');

  const first = (await moreItem(el, '[data-thread-read-item]'))!;
  act(() => first.click());
  await until(() => warning() !== null, 'the warning');
  expect(warning()!.querySelector('h2')!.textContent).toBe('Set aside 2 open questions?');
  act(() => warning()!.querySelector<HTMLButtonElement>('[data-mark-read-warning-cancel]')!.click());
  await settle();
  expect(warning()).toBeNull();
  expect(readPosts(ids.stopped)).toEqual([]);
  expect(await questionStates(ids.stopped)).toEqual(['open', 'open']);
  // Cancelled: still Mark read, not marked read.
  const again = (await moreItem(el, '[data-thread-read-item]'))!;
  act(() => again.click());
  await until(() => warning() !== null, 'the warning again');
  act(() => {
    warning()!.querySelector('input[type="checkbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await until(() => readPosts(ids.stopped).length === 1, 'the Mark read');
  expect(warning()).toBeNull();
  expect(readPosts(ids.stopped).length).toBe(1);
  expect((await questionStates(ids.stopped)).every((s) => s === 'closed')).toBe(true);
  expect(document.querySelector('[data-inbox-toast] .ib-tlead')?.textContent).toBe('Marked read');
  // Not ticked: the warning stays on.
  expect(await warningOnServer()).toBe(true);
});

test.skipIf(!hasDom)('Mark read on a thread with no question never asks', async () => {
  await warningOn();
  const el = await renderApp();
  const news = ids.news[0]!;
  await until(() => rowAction(el, news) !== null, 'the row action');
  act(() => rowAction(el, news)!.click());
  await until(() => readPosts(news).length === 1, 'the Mark read');
  expect(warning()).toBeNull();
});

test.skipIf(!hasDom)('"Don\'t show this again" saves the switch off, and the next Mark read with questions goes without asking', async () => {
  await warningOn();
  const el = await renderApp();
  await until(() => rowAction(el, ids.waiting) !== null, 'the row action');
  act(() => rowAction(el, ids.waiting)!.click());
  await until(() => warning() !== null, 'the warning');
  expect(warning()!.querySelector('h2')!.textContent).toBe('Set aside 1 open question?');
  act(() => warning()!.querySelector<HTMLInputElement>('[data-mark-read-warning-never] input')!.click());
  act(() => warning()!.querySelector<HTMLButtonElement>('[data-mark-read-warning-go]')!.click());
  await until(() => readPosts(ids.waiting).length === 1, 'the Mark read');
  await until(async () => (await warningOnServer()) === false, 'the switch saved off');
  expect(posted.some((p) => p.path === '/api/inbox/settings' && JSON.stringify(p.body.mark_read_warning) === '{"on":false}')).toBe(true);

  await until(() => rowAction(el, ids.stopped) !== null, 'the other row action');
  act(() => rowAction(el, ids.stopped)!.click());
  await until(() => readPosts(ids.stopped).length === 1, 'the second Mark read');
  expect(warning()).toBeNull();
});

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

test.skipIf(!hasDom)('Mark all as read asks once for the batch; Cancel sends no batch, going on sends it', async () => {
  await warningOn();
  await renderApp();
  const projectRow = () => document.querySelector<HTMLElement>(`.ib-projrow[data-project="${ids.project}"]`);
  const menu = () => document.querySelector<HTMLElement>(`[data-project-menu="${ids.project}"]`);
  const chooseRead = async () => {
    await until(() => !!projectRow(), 'the project row');
    await press(projectRow()!.querySelector<HTMLElement>('.ib-pmore')!);
    await until(() => !!menu(), 'the menu');
    await act(async () => {
      menu()!.querySelector<HTMLElement>('[data-project-action="read"]')!.click();
    });
  };
  const batches = () => posted.filter((p) => p.path === `/api/inbox/projects/${ids.project}/read`);

  await chooseRead();
  await until(() => warning() !== null, 'the warning');
  expect(warning()!.querySelector('h2')!.textContent).toStartWith('Set aside ');
  expect(warning()!.querySelector('[data-mark-read-warning-go]')!.textContent).toBe('Mark all as read');
  act(() => warning()!.querySelector<HTMLButtonElement>('[data-mark-read-warning-cancel]')!.click());
  await settle();
  expect(batches()).toEqual([]);
  expect(await questionStates(ids.stopped)).toEqual(['open', 'open']);

  await chooseRead();
  await until(() => warning() !== null, 'the warning again');
  act(() => warning()!.querySelector<HTMLButtonElement>('[data-mark-read-warning-go]')!.click());
  await until(() => batches().length === 1, 'the batch');
  await until(async () => (await questionStates(ids.stopped)).every((s) => s === 'closed'), 'the questions closed');
});
