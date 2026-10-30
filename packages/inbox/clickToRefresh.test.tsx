/**
 * Click Inbox to refresh (the owner, 2026-10-20: "Just click inbox, it
 * refreshes. That way I don't have to refresh the page"): the whole window
 * (InboxApp) over a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts with its plain agent news). What is
 * proved: on the list it shows, a click on the project folder, on Inbox, or on
 * the list's title reads the list again and adopts it as Show does (the agent
 * message held behind "1 new · Show" comes in and lights up, the notice goes);
 * with a thread open, Inbox in the sidebar still closes it and refreshes, while
 * the title refreshes beside the open thread; focus stays on what was pressed;
 * a click with nothing new still gives the signal (the icon's turn and "Inbox
 * refreshed" in the live region); and no look is recorded (the rows' New and
 * the tab's count stay as the server says).
 *
 * The turn itself, the hover icon and the tooltip are proved in a real browser
 * by tests/e2e/inbox-refresh.spec.ts.
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
import { PHONE_QUERY } from './phone';
import { SHOW_LIT_AFTER_SLIDE_MS } from './settle';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; news: string[] };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', news: [] };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
/** The window's event stream, which the test fires by hand (the stream itself is not needed). */
let pokeStream: (() => void) | null = null;
let posted: string[] = [];
/** The JSON bodies the window posted, with their paths. */
let postedBodies: { path: string; body: Record<string, unknown> }[] = [];

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

async function serverSection(threadId: string): Promise<string | undefined> {
  const model = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] };
  return model.sections.find((s) => s.threads.some((t) => t.thread_id === threadId))?.id;
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

/** An agent writes while the person reads (the server's stdin). */
async function agentSends(body: string, reply_to?: string): Promise<string> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_late', body, ...(reply_to ? { reply_to } : {}) } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

const TESTS = 7;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-refresh-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'news'], {
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

/** What the window's media queries answer in this test. */
let media = { phone: false, reduce: false };

beforeEach(() => {
  if (!hasDom) return;
  world = worlds.shift()!;
  media = { phone: false, reduce: false };
  savedFetch = globalThis.fetch;
  posted = [];
  postedBodies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      posted.push(String(input));
      postedBodies.push({ path: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    }
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') pokeStream = () => listener({ data: '' } as MessageEvent<string>);
    }
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === PHONE_QUERY ? media.phone : query.includes('prefers-reduced-motion: reduce') ? media.reduce : false,
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
  pokeStream = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
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
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash: string): Promise<HTMLElement> {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-lbody [data-thread-id]') !== null, 'the list');
  return host;
}

const rowOf = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
const sectionOfRow = (el: HTMLElement, id: string) => rowOf(el, id)?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null;
/** The thread ids in the order the list shows them. */
const order = (el: HTMLElement) => [...el.querySelectorAll('.ib-listcol .ib-lbody [data-thread-id]')].map((r) => r.getAttribute('data-thread-id')!);

/** Open a row the way a keyboard does: focus it, then press it. */
async function openRow(el: HTMLElement, id: string, looked: 'quiet' | null = 'quiet') {
  const row = rowOf(el, id)!;
  act(() => {
    row.focus();
    row.click();
  });
  await until(() => el.querySelector('section.ib-pane') !== null && window.location.hash.includes(id), `the thread ${id}`);
  // The look is recorded and the list read again.
  if (looked) await until(async () => (await serverSection(id)) === looked, 'the look on the server');
  await wait(120);
}

/** Close the thread with the keyboard (Escape). */
function closeThread() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

/** A mouse or a finger lands (the window's last way of acting becomes a pointer). */
function pointerDown(target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
}

/**
 * A mouse click: a pointer down, then a click that counts one click. (`el.click()` counts none,
 * which is how a screen reader presses a control.)
 */
function mouseClick(el: HTMLElement) {
  pointerDown(el);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
}


const live = () => document.querySelector('[data-inbox-live]')?.textContent ?? '';
const notice = (el: HTMLElement) => el.querySelector('[data-inbox-notice]');
const projectRow = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(`.ib-side [data-project="${world.project}"] .ib-proj`)!;
const inboxNav = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ib-side [data-inbox-nav]')!;
const lit = (el: HTMLElement) => [...el.querySelectorAll('.ib-listcol [data-thread-id][data-lit]')].map((r) => r.getAttribute('data-thread-id')!);

/** An agent's message lands while the list is held: the list on screen does not take it, "1 new · Show" says so. */
async function heldArrival(el: HTMLElement, reply_to?: string): Promise<string> {
  const late = await agentSends('A late note from the agent.', reply_to);
  act(() => pokeStream!());
  await until(() => notice(el)?.textContent?.includes('1 new') === true, 'the "1 new" notice');
  return late;
}

test.skipIf(!hasDom)('clicking the project the list shows adopts the read: the held message comes in, lit, and "1 new" goes', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const before = order(el);
  const late = await heldArrival(el);
  expect(rowOf(el, late)).toBeNull();
  expect(order(el)).toEqual(before);

  const row = projectRow(el);
  act(() => row.focus());
  mouseClick(row);
  await until(() => rowOf(el, late) !== null, 'the refresh');
  expect(sectionOfRow(el, late)).toBe('new');
  expect(notice(el)).toBeNull();
  // Still on the same list (no navigation), focus where the person pressed.
  expect(window.location.hash).toBe(`#project=${world.project}`);
  // DOM nodes compared as a boolean: a failing toBe on two elements has bun print both whole trees, which never ends.
  expect(document.activeElement === row).toBe(true);
  await until(() => live().includes('refreshed'), 'the announcement');
  // The row it brought in lights up after the slide, as Show's do.
  await wait(SHOW_LIT_AFTER_SLIDE_MS + 60);
  expect(lit(el)).toEqual([late]);
  // No look was recorded: the refresh is a read only.
  expect(posted.filter((path) => path.includes('/seen'))).toEqual([]);
  expect(rowOf(el, late)!.classList.contains('ib-u')).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('with a thread open, Inbox in the sidebar closes it as before and refreshes; the list adopts without waiting to settle', async () => {
  const el = await renderApp('');
  const first = world.news[0]!;
  await openRow(el, first);
  // With a thread open Inbox does not offer the refresh icon (its click closes the thread first).
  expect(inboxNav(el).hasAttribute('data-refreshes')).toBe(false);
  const late = await heldArrival(el);
  const nav = inboxNav(el);
  act(() => nav.focus());
  mouseClick(nav);
  await until(() => el.querySelector('section.ib-pane') === null, 'the thread closed');
  await until(() => rowOf(el, late) !== null && notice(el) === null, 'the refresh');
  // The person's own read settled too (the opened row left New for folded Quiet), in the same adopt.
  expect(rowOf(el, first)).toBeNull();
  expect(sectionOfRow(el, late)).toBe('new');
  expect(window.location.hash).toBe('');
  await until(() => live() === 'Inbox refreshed', 'the announcement');
  // Focus stays on Inbox; now on the list, it offers the refresh.
  expect(document.activeElement === nav).toBe(true);
  expect(nav.hasAttribute('data-refreshes')).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('the list title refreshes beside an open thread: the thread stays open and selected, the held message comes in', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  const late = await heldArrival(el);
  const title = el.querySelector<HTMLButtonElement>('.ib-lhead [data-list-refresh]')!;
  // The heading reads only the project's name: the button's description sits outside it (CI, #2027).
  expect(el.querySelector('.ib-lhead h1')!.textContent).toBe(projectRow(el).querySelector('.ib-name')!.textContent);
  act(() => title.focus());
  mouseClick(title);
  await until(() => rowOf(el, late) !== null && notice(el) === null, 'the refresh');
  expect(el.querySelector('section.ib-pane')).not.toBeNull();
  expect(window.location.hash).toContain(first);
  expect(rowOf(el, first)!.getAttribute('aria-current')).toBe('true');
  expect(document.activeElement === title).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('nothing new: a click still gives the signal (the icon turns, the live region says it) and moves nothing', async () => {
  const el = await renderApp('');
  const before = order(el);
  const nav = inboxNav(el);
  expect(nav.hasAttribute('data-refreshes')).toBe(true);
  expect(nav.getAttribute('aria-current')).toBe('page');
  mouseClick(nav);
  expect(nav.hasAttribute('data-refreshing')).toBe(true);
  await until(() => live() === 'Inbox refreshed', 'the announcement');
  expect(order(el)).toEqual(before);
  expect(window.location.hash).toBe('');
  // The turn ends by itself.
  await until(() => !nav.hasAttribute('data-refreshing'), 'the turn to end');
  // A second click says it again (the live region reads a new line each time).
  mouseClick(nav);
  await until(() => nav.hasAttribute('data-refreshing') && live() === 'Inbox refreshed', 'the second signal');
}, 30_000);

test.skipIf(!hasDom)('a stale row on screen (an agent replied in a thread the list holds as it was) takes its new state on refresh', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  closeThread();
  await until(() => rowOf(el, first) === null, 'the settle');
  // The agent writes again in the thread the person read: held behind "1 new" in folded Quiet.
  await heldArrival(el, first);
  expect(rowOf(el, first)).toBeNull();
  mouseClick(projectRow(el));
  await until(() => rowOf(el, first) !== null && notice(el) === null, 'the refresh');
  expect(sectionOfRow(el, first)).toBe('new');
  expect(rowOf(el, first)!.classList.contains('ib-u')).toBe(true);
}, 30_000);

// Review of #2027: a second read took the list the first click had already adopted as its
// "before", brought nothing in, and still cleared the light the first click had put on.
test.skipIf(!hasDom)('a second click keeps the light the first one put on: back to back, and once the first was adopted', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const late = await heldArrival(el);
  const row = projectRow(el);
  // Back to back: the second click comes while the first read is in flight, and is ignored.
  mouseClick(row);
  mouseClick(row);
  await until(() => rowOf(el, late) !== null && notice(el) === null, 'the refresh');
  await wait(SHOW_LIT_AFTER_SLIDE_MS + 60);
  expect(lit(el)).toEqual([late]);
  // Once adopted, another click reads again and brings nothing in: the light stays on.
  mouseClick(row);
  await until(() => live().includes('refreshed') && !row.hasAttribute('data-refreshing'), 'the second refresh');
  expect(lit(el)).toEqual([late]);
}, 30_000);

test.skipIf(!hasDom)('the project the list shows offers the refresh as Inbox does (↻ on the row), and only while no thread is open', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const row = projectRow(el);
  expect(row.hasAttribute('data-refreshes')).toBe(true);
  expect(row.querySelector('svg.ib-ic-refresh')).not.toBeNull();
  // Inbox does not refresh this list (a press goes to every project), so it does not offer it.
  expect(inboxNav(el).hasAttribute('data-refreshes')).toBe(false);
  mouseClick(row);
  expect(row.hasAttribute('data-refreshing')).toBe(true);
  await until(() => live().includes('refreshed'), 'the announcement');
  await openRow(el, world.news[0]!);
  expect(projectRow(el).hasAttribute('data-refreshes')).toBe(false);
}, 30_000);
