/**
 * The person's Priority as the window draws it: the whole window (InboxApp)
 * over a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts). What is proved: Add to Priority in the
 * row menu moves the row into a Priority group drawn first, with its toast and
 * live line, and Undo takes it out; Remove says where the row went back to,
 * and its Undo puts back the first time of the add; an archive drops the add
 * and Archive's Undo brings it back; an older Inbox (rows without a
 * `priority` key) shows no item and no group; a Stopped thread in Priority is
 * drawn once with its marks, the Stopped header no longer counts it and the
 * sidebar count does not change; and a project's page whose rows hold no
 * Priority row draws no Priority group.
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
import { resetListGroupsForTests } from './listGroups';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { resetListReads } = (hasDom ? await import('./api') : {}) as typeof import('./api');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; stopped: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
/** While set, list reads come back as an Inbox from before Priority answers them: no `priority` key on any row. */
let older = false;

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

interface ListModel {
  serverSession: string;
  sections: InboxListSection[];
}
const serverList = async () => JSON.parse((await loopback('/api/inbox/threads?archived=exclude')).text) as ListModel;
const serverRow = async (id: string) => (await serverList()).sections.flatMap((s) => s.threads).find((r) => r.thread_id === id) ?? null;
async function addOnServer(id: string) {
  const { serverSession } = await serverList();
  expect((await loopback(`/api/inbox/threads/${id}/priority`, 'POST', JSON.stringify({ serverSession, priority: true }))).status).toBe(200);
}

/** An older Inbox's answer: the same JSON with every row's `priority` key gone. */
function withoutPriority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPriority);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) if (key !== 'priority') out[key] = withoutPriority(inner);
  return out;
}

const TESTS = 7;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-priority-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
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
  older = false;
  // Each test reads the whole list first: a kept list would carry the rows of the test before (and their `priority`).
  resetListReads();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    const text = older && method === 'GET' && path.startsWith('/api/inbox/threads') ? JSON.stringify(withoutPriority(JSON.parse(answer.text))) : answer.text;
    return new Response(text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
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
  // Which groups are closed is kept for the page (listGroups.ts): each test starts as a first visit.
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

async function renderApp(hash = '', first = ids.waiting) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!rowButton(first), 'the list');
}

const rowButton = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`);
const drawnIn = (id: string) => rowButton(id)?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null;
const groups = () => [...document.querySelectorAll('.ib-lbody [data-section-id]')].map((g) => g.getAttribute('data-section-id'));
const header = (group: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-section-id="${group}"]`);
const menu = () => document.querySelector<HTMLElement>('[data-row-menu]');
const items = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((el) => el.textContent?.trim());
const toast = () => document.querySelector<HTMLElement>('[data-inbox-toast]');
const live = () => document.querySelector<HTMLElement>('[data-inbox-live]')?.textContent ?? '';

async function openMenu(id: string) {
  await act(async () => {
    rowButton(id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === id, 'the menu');
}

async function choose(action: string) {
  const el = menu()!.querySelector<HTMLElement>(`[data-row-action="${action}"]`)!;
  await act(async () => el.click());
}

async function undo() {
  const button = toast()!.querySelector<HTMLElement>('[data-toast-undo]')!;
  await act(async () => button.click());
}

test.skipIf(!hasDom)('Add to Priority moves the row into a Priority group drawn first, with its toast; Undo takes it out', async () => {
  await renderApp();
  const subject = (await serverRow(ids.waiting))!.subject;
  expect(groups()).not.toContain('priority');
  await openMenu(ids.waiting);
  expect(items().slice(0, 2)).toEqual(['Star thread', 'Add to Priority']);
  await choose('priority-add');

  await until(() => drawnIn(ids.waiting) === 'priority', 'the row in Priority');
  expect(groups()[0]).toBe('priority');
  expect(header('priority')!.getAttribute('aria-label')).toBe('Priority');
  expect(document.querySelectorAll(`.ib-lbody [data-thread-id="${ids.waiting}"]`)).toHaveLength(1);
  expect((await serverRow(ids.waiting))!.priority).toMatchObject({ person: true, ask: null });
  await until(() => toast()?.textContent?.includes('Added to Priority') === true, 'the toast');
  expect(toast()!.textContent).toContain(`“${subject}”`);
  await until(() => live().includes(`Added “${subject}” to Priority.`), 'the live line');

  await undo();
  await until(() => drawnIn(ids.waiting) === 'waiting', 'the row back in Waiting');
  expect(groups()).not.toContain('priority');
  expect((await serverRow(ids.waiting))!.priority).toBeNull();
  await until(() => live().includes('Removed from Priority again.'), 'the live line');
});

test.skipIf(!hasDom)('Remove from Priority says where the row went back to; its Undo puts back the first time of the add', async () => {
  await addOnServer(ids.waiting);
  const first = (await serverRow(ids.waiting))!.priority!.at;
  const subject = (await serverRow(ids.waiting))!.subject;
  await renderApp();
  expect(drawnIn(ids.waiting)).toBe('priority');
  await openMenu(ids.waiting);
  expect(items().slice(0, 2)).toEqual(['Star thread', 'Remove from Priority']);
  await choose('priority-remove');

  await until(() => drawnIn(ids.waiting) === 'waiting', 'the row back in Waiting');
  await until(() => toast()?.textContent?.includes('Removed from Priority') === true, 'the toast');
  expect(toast()!.textContent).toContain('Back in Waiting on you');
  await until(() => live().includes(`Removed “${subject}” from Priority. Back in Waiting on you.`), 'the live line');
  expect((await serverRow(ids.waiting))!.priority).toBeNull();

  await undo();
  await until(() => drawnIn(ids.waiting) === 'priority', 'the row back in Priority');
  expect((await serverRow(ids.waiting))!.priority).toEqual({ person: true, at: first, ask: null });
  await until(() => live().includes('Back in Priority.'), 'the live line');
});

test.skipIf(!hasDom)("an archive drops the add; Archive's Undo brings the row back into Priority with its first time", async () => {
  await addOnServer(ids.waiting);
  const first = (await serverRow(ids.waiting))!.priority!.at;
  await renderApp();
  await openMenu(ids.waiting);
  await choose('archive');
  await until(async () => (await serverRow(ids.waiting)) === null, 'the archive');
  await until(() => toast()?.querySelector('[data-toast-undo]') != null, "the archive's toast");

  await undo();
  await until(async () => (await serverRow(ids.waiting))?.priority?.at === first, 'the add back with its first time');
  await until(() => drawnIn(ids.waiting) === 'priority', 'the row back in Priority');
});

test.skipIf(!hasDom)('an older Inbox (no `priority` key on rows): no item and no group', async () => {
  // Added on this Inbox, read as an older one answers: nothing of it shows.
  await addOnServer(ids.waiting);
  older = true;
  await renderApp();
  expect(groups()).not.toContain('priority');
  expect(drawnIn(ids.waiting)).toBe('waiting');
  await openMenu(ids.waiting);
  expect(items()).not.toContain('Add to Priority');
  expect(items()).not.toContain('Remove from Priority');
  expect(menu()!.querySelector('[data-row-action^="priority-"]')).toBeNull();
});

test.skipIf(!hasDom)('a Stopped thread in Priority is drawn once with its marks; the Stopped header stops counting it, the sidebar count does not change', async () => {
  await renderApp();
  const marks = (id: string) => {
    const mark = rowButton(id)!.closest('[data-row]')!.querySelector('[data-wait-step]');
    return [mark?.getAttribute('data-wait-step'), mark?.getAttribute('data-open-count')];
  };
  const stoppedCount = () => header('stopped')?.querySelector('.ib-n')?.textContent ?? null;
  const sidebar = () => document.querySelector('[data-inbox-nav] .ib-n')?.textContent ?? null;
  expect(drawnIn(ids.stopped)).toBe('stopped');
  const before = { marks: marks(ids.stopped), stopped: Number(stoppedCount()), sidebar: sidebar() };
  expect(before.marks[0]).not.toBeNull();

  await openMenu(ids.stopped);
  await choose('priority-add');
  await until(() => drawnIn(ids.stopped) === 'priority', 'the row in Priority');
  expect(document.querySelectorAll(`.ib-lbody [data-thread-id="${ids.stopped}"]`)).toHaveLength(1);
  expect(marks(ids.stopped)).toEqual(before.marks);
  expect(stoppedCount()).toBe(before.stopped > 1 ? String(before.stopped - 1) : null);
  expect(sidebar()).toBe(before.sidebar);
});

test.skipIf(!hasDom)("a project's page whose rows hold no Priority row draws no Priority group; the project's own page does", async () => {
  const other = worlds.shift()!;
  await addOnServer(ids.waiting);
  await renderApp(`#project=${other.project}`, other.waiting);
  expect(groups()).not.toContain('priority');
  act(() => root!.unmount());
  host!.remove();
  await renderApp(`#project=${ids.project}`);
  expect(groups()[0]).toBe('priority');
  expect(drawnIn(ids.waiting)).toBe('priority');
});
