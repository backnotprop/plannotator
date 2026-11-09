/**
 * Pull down to refresh the list on a phone (the owner: "it's a natural
 * behavior we should support, same way clicking title works"): the whole
 * window (InboxApp) over a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts with its plain agent news), with touch
 * events dispatched on the list's scroll box. What is proved: on a phone, one
 * finger pulled down from the list's top past the threshold reads the list
 * once (the agent message held behind "1 new · Show" comes in, the live region
 * says "Inbox refreshed", as the title's tap does), and only that pull's moves
 * are cancelled; a short pull, a sideways move, a second finger, a start with
 * the list scrolled, and a desktop window read nothing and cancel nothing.
 *
 * The motion itself (real touch, mid-pull, ready, the spin) is proved in real
 * browsers by tests/e2e/inbox-pull-refresh.spec.ts.
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
import { PHONE_QUERY } from './phone';
import { PULL_LOST_MS, PULL_READY_PX, dampPull } from './pullRefresh';

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
/** The window's reads of the list (GET /api/inbox/threads?…). */
let listReads = 0;
/** While set, the window's list reads wait for it (a refresh held in flight). */
let listGate: Promise<void> | null = null;

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

const TESTS = 15;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-pull-dom-')));
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
  listReads = 0;
  listGate = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET' && String(input).startsWith('/api/inbox/threads?')) {
      listReads += 1;
      if (listGate) await listGate;
    }
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






const live = () => document.querySelector('[data-inbox-live]')?.textContent ?? '';
const notice = (el: HTMLElement) => el.querySelector('[data-inbox-notice]');
const list = (el: HTMLElement) => el.querySelector<HTMLElement>('.ib-listcol .ib-lbody')!;
const indicator = (el: HTMLElement) => el.querySelector<HTMLElement>('.ib-listcol [data-pull-indicator]');

/** An agent's message lands while the list is held: the list on screen does not take it, "1 new · Show" says so. */
async function heldArrival(el: HTMLElement): Promise<string> {
  const late = await agentSends('A late note from the agent.');
  act(() => pokeStream!());
  await until(() => notice(el)?.textContent?.includes('1 new') === true, 'the "1 new" notice');
  return late;
}

type Point = { x: number; y: number };

/** One touch event on the list, as a phone sends it; returns whether the page cancelled it. */
function touch(target: HTMLElement, type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', fingers: Point[], changed: Point[] = fingers): boolean {
  const point = (p: Point, i: number) => ({ identifier: i, clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y, target });
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: fingers.map(point) });
  Object.defineProperty(event, 'changedTouches', { value: changed.map(point) });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** One finger from `from` moved by (dx, dy) in eight steps, then lifted (unless `lift` is false). Returns whether any move was cancelled. */
function drag(target: HTMLElement, from: Point, dx: number, dy: number, lift = true): boolean {
  touch(target, 'touchstart', [from]);
  let cancelled = false;
  for (let i = 1; i <= 8; i++) {
    const at = { x: from.x + (dx * i) / 8, y: from.y + (dy * i) / 8 };
    cancelled = touch(target, 'touchmove', [at]) || cancelled;
  }
  if (lift) touch(target, 'touchend', [], [{ x: from.x + dx, y: from.y + dy }]);
  return cancelled;
}

/** The finger travel whose damped travel is `px` (plus the slop a pull starts after). */
function rawFor(px: number): number {
  let raw = 0;
  while (dampPull(raw) < px) raw += 1;
  return raw + 4;
}

const PAST = rawFor(PULL_READY_PX + 12);
const SHORT = rawFor(PULL_READY_PX - 20);

test.skipIf(!hasDom)('a phone: one finger pulled down from the top past the threshold reads the list once, as the title does', async () => {
  media.phone = true;
  const el = await renderApp('');
  const late = await heldArrival(el);
  expect(indicator(el)).not.toBeNull();
  expect(indicator(el)!.getAttribute('aria-hidden')).toBe('true');
  const body = list(el);
  const reads = listReads;
  // The pull's own moves are cancelled (the list does not scroll or bounce under it), and past the threshold it is ready.
  expect(drag(body, { x: 180, y: 200 }, 1, PAST, false)).toBe(true);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  expect(body.style.transform).toContain('translate3d(0');
  touch(body, 'touchend', [], [{ x: 181, y: 200 + PAST }]);
  expect(indicator(el)!.getAttribute('data-state')).toBe('refreshing');
  await until(() => rowOf(el, late) !== null && notice(el) === null, 'the refresh');
  await until(() => live() === 'Inbox refreshed', 'the announcement');
  expect(listReads - reads).toBe(1);
  // The read landed: the ↻ settles away and the list is back in place.
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the settle');
  expect(body.style.transform).toBe('');
  // Nothing was recorded: the pull is a read only.
  expect(posted.filter((path) => path.includes('/seen'))).toEqual([]);
}, 30_000);

test.skipIf(!hasDom)('a short pull springs back and reads nothing', async () => {
  media.phone = true;
  const el = await renderApp('');
  const late = await heldArrival(el);
  const reads = listReads;
  drag(list(el), { x: 180, y: 200 }, 0, SHORT, false);
  expect(indicator(el)!.getAttribute('data-state')).toBe('pull');
  touch(list(el), 'touchend', [], [{ x: 180, y: 200 + SHORT }]);
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the spring back');
  await wait(300);
  expect(listReads).toBe(reads);
  expect(rowOf(el, late)).toBeNull();
  expect(notice(el)).not.toBeNull();
}, 30_000);

test.skipIf(!hasDom)('a sideways move is not a pull: nothing cancelled, nothing read', async () => {
  media.phone = true;
  const el = await renderApp('');
  await heldArrival(el);
  const reads = listReads;
  expect(drag(list(el), { x: 60, y: 200 }, 220, 40)).toBe(false);
  expect(indicator(el)!.hasAttribute('data-state')).toBe(false);
  await wait(300);
  expect(listReads).toBe(reads);
}, 30_000);

test.skipIf(!hasDom)('a second finger lets the pull go, and two fingers from the start are no pull: nothing read', async () => {
  media.phone = true;
  const el = await renderApp('');
  await heldArrival(el);
  const body = list(el);
  const reads = listReads;
  drag(body, { x: 180, y: 200 }, 0, PAST, false);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  // A second finger lands, then both lift.
  touch(body, 'touchstart', [{ x: 180, y: 200 + PAST }, { x: 260, y: 300 }], [{ x: 260, y: 300 }]);
  touch(body, 'touchmove', [{ x: 180, y: 210 + PAST }, { x: 260, y: 320 }]);
  touch(body, 'touchend', [], [{ x: 180, y: 210 + PAST }, { x: 260, y: 320 }]);
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the spring back');
  await wait(300);
  expect(listReads).toBe(reads);
  touch(body, 'touchstart', [{ x: 120, y: 200 }, { x: 240, y: 200 }]);
  expect(touch(body, 'touchmove', [{ x: 120, y: 200 + PAST }, { x: 240, y: 200 + PAST }])).toBe(false);
  touch(body, 'touchend', [], [{ x: 120, y: 200 + PAST }, { x: 240, y: 200 + PAST }]);
  await wait(300);
  expect(listReads).toBe(reads);
  expect(indicator(el)!.hasAttribute('data-state')).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('a list scrolled away from its top scrolls: nothing cancelled, nothing read', async () => {
  media.phone = true;
  const el = await renderApp('');
  await heldArrival(el);
  const body = list(el);
  // Which touchmove listeners the list holds: scrolled away from the top, none that can block a scroll.
  const blocking = new Set<EventListenerOrEventListenerObject>();
  const add = body.addEventListener.bind(body);
  const remove = body.removeEventListener.bind(body);
  body.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    if (type === 'touchmove' && typeof opts === 'object' && opts.passive === false) blocking.add(fn);
    add(type, fn, opts);
  }) as typeof body.addEventListener;
  body.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
    if (type === 'touchmove') blocking.delete(fn);
    remove(type, fn, opts);
  }) as typeof body.removeEventListener;
  body.scrollTop = 400;
  expect(body.scrollTop).toBe(400);
  act(() => {
    body.dispatchEvent(new Event('scroll'));
  });
  expect(blocking.size).toBe(0);
  const reads = listReads;
  expect(drag(body, { x: 180, y: 200 }, 0, PAST)).toBe(false);
  expect(indicator(el)!.hasAttribute('data-state')).toBe(false);
  await wait(300);
  expect(listReads).toBe(reads);
  // Back at the top, the listener is there before the next finger lands (an engine decides at touchstart).
  body.scrollTop = 0;
  act(() => {
    body.dispatchEvent(new Event('scroll'));
  });
  expect(blocking.size).toBe(1);
}, 30_000);

test.skipIf(!hasDom)('reduced motion: the pull still refreshes; the ↻ does not turn and nothing springs', async () => {
  media.phone = true;
  media.reduce = true;
  const el = await renderApp('');
  const late = await heldArrival(el);
  const body = list(el);
  drag(body, { x: 180, y: 200 }, 0, PAST, false);
  expect(indicator(el)!.style.getPropertyValue('--ib-pull-turn')).toBe('0deg');
  expect(body.style.transition).toBe('');
  touch(body, 'touchend', [], [{ x: 180, y: 200 + PAST }]);
  expect(body.style.transition).toBe('');
  await until(() => rowOf(el, late) !== null, 'the refresh');
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the ↻ hidden');
  expect(body.style.transform).toBe('');
}, 30_000);

test.skipIf(!hasDom)('a desktop window has no pull: no indicator, and a touch drag from the top reads nothing', async () => {
  media.phone = false;
  const el = await renderApp('');
  await heldArrival(el);
  expect(indicator(el)).toBeNull();
  const reads = listReads;
  expect(drag(list(el), { x: 400, y: 200 }, 0, PAST)).toBe(false);
  await wait(300);
  expect(listReads).toBe(reads);
  expect(notice(el)).not.toBeNull();
}, 30_000);

/** The pointer event a browser sends when a touch lifts (pointer events reach the element under the finger). */
function pointer(target: EventTarget, type: 'pointerdown' | 'pointerup' | 'pointercancel', pointerId = 1, isPrimary = true) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'isPrimary', { value: isPrimary });
  act(() => {
    target.dispatchEvent(event);
  });
}

/**
 * The row the finger is on leaves the list mid-pull: the agent asks a question in that thread, so its row
 * moves from "New since you looked" to "Waiting on you", and React draws it anew there (the old row element
 * leaves the document). Taken in by Show, as a second finger could.
 */
async function rowLeaves(el: HTMLElement, id: string, row: HTMLElement) {
  await agentSends(':::question\nShip it today?\n- Yes\n- No\n:::', id);
  act(() => pokeStream!());
  await until(() => notice(el) !== null, 'the "1 new" notice');
  act(() => (notice(el) as HTMLElement).click());
  await until(() => !row.isConnected, 'the row element to leave the document');
}

test.skipIf(!hasDom)('touchcancel mid-pull springs back and reads nothing', async () => {
  media.phone = true;
  const el = await renderApp('');
  const body = list(el);
  const reads = listReads;
  drag(body, { x: 180, y: 200 }, 0, PAST, false);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  touch(body, 'touchcancel', [], [{ x: 180, y: 200 + PAST }]);
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the spring back');
  expect(body.style.transform).toBe('');
  await wait(300);
  expect(listReads).toBe(reads);
}, 30_000);

test.skipIf(!hasDom)('the row under the finger leaves the list mid-pull: the lift still ends the pull, and nothing is left stuck', async () => {
  media.phone = true;
  const el = await renderApp('');
  const body = list(el);
  // The pull starts on a row (touch events keep going to it, even once it is gone).
  const id = world.news[0]!;
  const row = rowOf(el, id)!;
  pointer(row, 'pointerdown', 7);
  drag(row, { x: 180, y: 200 }, 0, PAST, false);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  await rowLeaves(el, id, row);
  expect(row.isConnected).toBe(false);
  // Its touchend goes to the detached row and reaches nothing; the touch pointer's end reaches the document.
  touch(row, 'touchend', [], [{ x: 180, y: 200 + PAST }]);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  const reads = listReads;
  pointer(document.body, 'pointerup', 7);
  expect(indicator(el)!.getAttribute('data-state')).toBe('refreshing');
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the settle');
  expect(body.style.transform).toBe('');
  expect(listReads - reads).toBe(1);
}, 30_000);

test.skipIf(!hasDom)('a pull whose lift never came is let go by the next touch on the list', async () => {
  media.phone = true;
  const el = await renderApp('');
  const body = list(el);
  const id = world.news[0]!;
  const row = rowOf(el, id)!;
  pointer(row, 'pointerdown', 7);
  drag(row, { x: 180, y: 200 }, 0, PAST, false);
  await rowLeaves(el, id, row);
  // Neither the touchend nor a pointer end arrives anywhere: the list is held down, ready.
  touch(row, 'touchend', [], [{ x: 180, y: 200 + PAST }]);
  expect(body.style.transform).toContain('translate3d(0');
  const reads = listReads;
  // A later tap on the list lets the stuck pull go (and is a tap, not a refresh).
  touch(body, 'touchstart', [{ x: 180, y: 300 }]);
  touch(body, 'touchend', [], [{ x: 180, y: 300 }]);
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the settle');
  expect(body.style.transform).toBe('');
  await wait(300);
  expect(listReads).toBe(reads);
}, 30_000);

test.skipIf(!hasDom)('a thread opening during a pull takes the list off screen: the pull is let go, nothing refreshes', async () => {
  media.phone = true;
  const el = await renderApp('');
  const body = list(el);
  drag(body, { x: 180, y: 200 }, 0, PAST, false);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  // A thread opens (a notification's click, a link): the list goes under it.
  act(() => {
    window.location.hash = `#thread=${world.news[1]}`;
  });
  await until(() => el.querySelector('section.ib-pane') !== null, 'the thread');
  expect(body.style.transform).toBe('');
  expect(indicator(el)!.hasAttribute('data-state')).toBe(false);
  // The lift that follows does nothing.
  touch(body, 'touchend', [], [{ x: 180, y: 200 + PAST }]);
  await wait(300);
  expect(indicator(el)!.hasAttribute('data-state')).toBe(false);
  expect(live()).not.toBe('Inbox refreshed');
}, 30_000);

test.skipIf(!hasDom)('a refresh already in flight (the title was tapped): a pull adds no second read and does not stay stuck', async () => {
  media.phone = true;
  const el = await renderApp('');
  const late = await heldArrival(el);
  const body = list(el);
  let open: () => void = () => {};
  listGate = new Promise<void>((done) => (open = done));
  const reads = listReads;
  act(() => el.querySelector<HTMLButtonElement>('.ib-lhead [data-list-refresh]')!.click());
  await until(() => listReads - reads === 1, 'the title read in flight');
  drag(body, { x: 180, y: 200 }, 0, PAST);
  // The pull finds the refresh running: its ↻ goes away without waiting on it, and no second read starts.
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the settle');
  expect(body.style.transform).toBe('');
  expect(listReads - reads).toBe(1);
  listGate = null;
  open();
  await until(() => rowOf(el, late) !== null && notice(el) === null, 'the refresh');
  await until(() => live() === 'Inbox refreshed', 'the announcement');
  expect(listReads - reads).toBe(1);
}, 30_000);

test.skipIf(!hasDom)('a list at a fractional top (0.5 px) still pulls', async () => {
  media.phone = true;
  const el = await renderApp('');
  const body = list(el);
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => 0.5 });
  act(() => {
    body.dispatchEvent(new Event('scroll'));
  });
  expect(drag(body, { x: 180, y: 200 }, 0, PAST, false)).toBe(true);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  touch(body, 'touchcancel', [], [{ x: 180, y: 200 + PAST }]);
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the spring back');
}, 30_000);

test.skipIf(!hasDom)('a second finger lifting never ends the pull: only the finger that started it does', async () => {
  media.phone = true;
  const el = await renderApp('');
  const id = world.news[0]!;
  const row = rowOf(el, id)!;
  pointer(row, 'pointerdown', 7);
  drag(row, { x: 180, y: 200 }, 0, PAST, false);
  await rowLeaves(el, id, row);
  const reads = listReads;
  // Another finger (not the primary pointer, another id) lifts: the pull holds.
  pointer(document.body, 'pointerup', 9, false);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  // A primary pointer with another id is not the finger that started it either.
  pointer(document.body, 'pointerup', 8, true);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  // The starting finger's lift ends it.
  pointer(document.body, 'pointerup', 7);
  expect(indicator(el)!.getAttribute('data-state')).toBe('refreshing');
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the settle');
  expect(listReads - reads).toBe(1);
}, 30_000);

test.skipIf(!hasDom)('a pull whose lift was lost is let go by a touch anywhere (the header), or by itself after a while', async () => {
  media.phone = true;
  const el = await renderApp('');
  const body = list(el);
  const id = world.news[0]!;
  const row = rowOf(el, id)!;
  pointer(row, 'pointerdown', 7);
  drag(row, { x: 180, y: 200 }, 0, PAST, false);
  await rowLeaves(el, id, row);
  // iOS sends the lift (touch and pointer) to the detached row: nothing hears it.
  touch(row, 'touchend', [], [{ x: 180, y: 200 + PAST }]);
  pointer(row, 'pointerup', 7);
  expect(body.style.transform).toContain('translate3d(0');
  let reads = listReads;
  // A tap on the header, outside the list, lets it go (and refreshes nothing).
  const header = el.querySelector<HTMLElement>('.ib-lhead')!;
  touch(header, 'touchstart', [{ x: 120, y: 30 }]);
  touch(header, 'touchend', [], [{ x: 120, y: 30 }]);
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the settle');
  expect(body.style.transform).toBe('');
  await wait(200);
  expect(listReads).toBe(reads);

  // Lost again, and no touch comes at all: it is let go by itself after PULL_LOST_MS.
  const id2 = world.news[1]!;
  const row2 = rowOf(el, id2)!;
  pointer(row2, 'pointerdown', 11);
  drag(row2, { x: 180, y: 300 }, 0, PAST, false);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  await rowLeaves(el, id2, row2);
  touch(row2, 'touchend', [], [{ x: 180, y: 300 + PAST }]);
  reads = listReads;
  await wait(PULL_LOST_MS / 2);
  expect(indicator(el)!.getAttribute('data-state')).toBe('ready');
  await until(() => !indicator(el)!.hasAttribute('data-state'), 'the lost pull let go');
  expect(body.style.transform).toBe('');
  expect(listReads).toBe(reads);
}, 30_000);
