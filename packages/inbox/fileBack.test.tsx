/**
 * The way back to the list while a file is open beside the thread (design
 * record "inbox-file-back-to-list", variant 1, approved 2026-10-12): the
 * whole window (InboxApp) over a REAL Inbox server in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts). What is proved: `‹ Inbox` leads
 * the thread header only while a file hides the list on a desktop, and the
 * thread's own × goes while it shows; a click closes the file (through the
 * pane's unsaved-comment question, as the file's × does), brings the sidebar
 * and the list back with the thread still open, and puts focus on the
 * thread's row; it names the project when the list is filtered; with no file
 * open the header is as before. The compiled-binary proof is
 * tests/e2e/inbox-attachments.spec.ts.
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
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

/** The real Inbox, in its own process: happy-dom's Response cannot be served from this one. */
const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
/** One seeded project per test: the window keeps the first server session it saw, so every test shares one server. */
type World = {
  project: string;
  stopped: string;
  waiting: string;
  mixed: string;
  update: string;
  same: string;
  sameUpdate: string;
  picked: string;
  pickedUpdate: string;
  filed: string;
  attachment: string;
};
let worlds: World[] = [];
let ids: World = { project: '', stopped: '', waiting: '', mixed: '', update: '', same: '', sameUpdate: '', picked: '', pickedUpdate: '', filed: '', attachment: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

/** One request to the real Inbox over loopback (happy-dom's own fetch would resolve against its page). */
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

const TESTS = 4;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-fileback-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
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
  const started = JSON.parse(line.trim()) as { port: number; worlds: typeof worlds };
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
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  // The event stream is not needed: every action reads the list again itself.
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

/** Act until `check` holds (the window's reads go to another process), or fail after 5 s. */
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

const back = (el: ParentNode) => el.querySelector<HTMLButtonElement>('section.ib-pane .ib-phead [data-file-back]');
const closeThread = (el: ParentNode) => el.querySelector('section.ib-pane .ib-phead button[aria-label="Close the thread"]');
const sidebarState = (el: ParentNode) => el.querySelector('.ib-sb')?.getAttribute('data-state') ?? null;
const listRow = (el: ParentNode, threadId: string) => el.querySelector<HTMLElement>(`.ib-listcol .ib-lbody [data-thread-id="${threadId}"]`);

test.skipIf(!hasDom)('with a file open beside the thread, ‹ Inbox leads the header and brings the list back', async () => {
  const el = await renderApp(`#thread=${ids.filed}&file=${ids.attachment}`);
  await until(() => el.querySelector('.ib-view') !== null && back(el) !== null, 'the file beside the thread');
  // The list and the sidebar are hidden by the file; the way back leads, then Mark read; Archive and ⋯ More end the header, and the thread's × is gone.
  expect(el.querySelector('.ib-listcol')).toBeNull();
  expect(sidebarState(el)).toBe('collapsed');
  const head = el.querySelector('section.ib-pane .ib-phead')!;
  expect(head.firstElementChild).toBe(back(el));
  // Mark read follows the way back (after its divider), and Archive then ⋯ More end the header, where the × was.
  const buttons = [...head.querySelectorAll('button')];
  expect(buttons[0]).toBe(back(el)!);
  const markRead = head.querySelector<HTMLButtonElement>('[data-mark-read]');
  expect(markRead).not.toBeNull();
  expect(buttons[1]).toBe(markRead!);
  // ⋯ More (the copy menu, design record "inbox-copy-message") ends it, right after Archive.
  expect(head.lastElementChild).toBe(head.querySelector('[data-thread-more]'));
  expect(head.lastElementChild!.previousElementSibling).toBe(head.querySelector('[data-archive]'));
  expect(back(el)!.getAttribute('aria-label')).toBe('Back to Inbox');
  expect(back(el)!.textContent?.trim()).toBe('Inbox');
  expect(await tooltipOf(back(el)!)).toBe('Close notes.md and show the list');
  expect(closeThread(el)).toBeNull();
  expect(el.querySelector('[data-stack-back]')).toBeNull();

  await act(async () => back(el)!.click());
  await until(() => el.querySelector('.ib-view') === null && listRow(el, ids.filed) !== null, 'the list back beside the thread');
  // The file closed; the thread is still open beside the list, the sidebar back to the saved choice (open).
  expect(window.location.hash).toContain(`thread=${ids.filed}`);
  expect(window.location.hash).not.toContain('file=');
  expect(el.querySelector(`section.ib-pane[data-thread-id="${ids.filed}"]`)).not.toBeNull();
  expect(sidebarState(el)).toBe('expanded');
  // The header is as it is with no file: no way back, the thread's × again.
  expect(back(el)).toBeNull();
  expect(closeThread(el)).not.toBeNull();
  // Focus on this thread's row in the list, and one line for a screen reader.
  await until(() => document.activeElement === listRow(el, ids.filed), 'focus on the thread row');
  await until(() => el.querySelector('[data-inbox-live]')?.textContent === 'Inbox list shown. notes.md closed.', 'the live region');
});

test.skipIf(!hasDom)('with the list filtered to a project, the way back names the project', async () => {
  const el = await renderApp(`#project=${ids.project}&thread=${ids.filed}&file=${ids.attachment}`);
  await until(() => back(el) !== null, 'the way back');
  const name = back(el)!.textContent?.trim() ?? '';
  expect(name).toMatch(/^billing-\d+$/);
  expect(back(el)!.getAttribute('aria-label')).toBe(`Back to ${name}`);
  await act(async () => back(el)!.click());
  await until(() => listRow(el, ids.filed) !== null, 'the project list back');
  expect(window.location.hash).toContain(`project=${ids.project}`);
  await until(() => document.activeElement === listRow(el, ids.filed), 'focus on the thread row');
});

test.skipIf(!hasDom)('a typed comment in the open file asks first, as the file close does; Keep writing stays', async () => {
  const el = await renderApp(`#thread=${ids.filed}&file=${ids.attachment}`);
  await until(() => el.querySelector('.ib-view') !== null && back(el) !== null, 'the file beside the thread');
  // A comment composer with words in it (Plannotator's popover draws in a portal on the page).
  const popover = document.createElement('div');
  popover.setAttribute('data-comment-popover', '');
  const area = document.createElement('textarea');
  area.value = 'Not saved yet';
  popover.appendChild(area);
  document.body.appendChild(popover);
  try {
    await act(async () => back(el)!.click());
    await until(() => el.querySelector('[data-step-guard]') !== null, 'the question row');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-guard-keep]')!.click());
    await settle();
    expect(el.querySelector('.ib-view')).not.toBeNull();
    expect(window.location.hash).toContain('file=');
    // Discard goes on: the file closes and the list comes back.
    await act(async () => back(el)!.click());
    await until(() => el.querySelector('[data-step-guard]') !== null, 'the question row again');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-guard-discard]')!.click());
    await until(() => el.querySelector('.ib-view') === null && listRow(el, ids.filed) !== null, 'the list back');
  } finally {
    popover.remove();
  }
});

test.skipIf(!hasDom)('with no file open, the thread header is as before: no way back, the thread\'s ×', async () => {
  const el = await renderApp(`#thread=${ids.filed}`);
  await until(() => el.querySelector(`section.ib-pane[data-thread-id="${ids.filed}"]`) !== null && listRow(el, ids.filed) !== null, 'the thread beside the list');
  expect(back(el)).toBeNull();
  expect(el.querySelector('[data-stack-back]')).toBeNull();
  expect(closeThread(el)).not.toBeNull();
  expect(sidebarState(el)).toBe('expanded');
});
