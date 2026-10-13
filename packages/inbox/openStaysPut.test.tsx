/**
 * The row you open stays put (design record "inbox-open-stays-put", variant
 * B, approved 2026-10-12): the whole window (InboxApp) over a REAL Inbox in a
 * temp data dir (its own process, tests/helpers/inbox-dom-server.ts with its
 * plain agent news). What is proved: opening a "New since you looked" row
 * unbolds it where it is, with focus kept on it; opening a second row moves
 * nothing; closing the thread settles the list a beat later (at once under
 * reduced motion, with no animation), and focus goes to the row now in the
 * opened row's slot, never to the page; an agent's message that arrived while
 * reading stays behind "N new · Show" after the close until Show; and where
 * the thread covers the list (a phone), Back shows the list as it was left
 * and it settles while the next thread covers it.
 *
 * The slide itself (its frames) is proved in a real browser by
 * tests/e2e/inbox-open-stays-put.spec.ts; happy-dom lays nothing out.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
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
import { rowInSlot, SETTLE_BEAT_MS } from './settle';

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

const TESTS = 9;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-staysput-dom-')));
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

test.skipIf(!hasDom)('opening a New row unbolds it where it is, keeps it selected and keeps focus on it', async () => {
  const el = await renderApp(`#project=${world.project}`);
  // By id, never by position: rows written in the same millisecond order by id.
  const first = world.news[0]!;
  expect(sectionOfRow(el, first)).toBe('new');
  expect(rowOf(el, first)!.classList.contains('ib-u')).toBe(true);
  const before = order(el);
  await openRow(el, first);
  // On the server the look moved it to Quiet; on screen it has not moved.
  expect(sectionOfRow(el, first)).toBe('new');
  expect(order(el)).toEqual(before);
  const row = rowOf(el, first)!;
  expect(row.classList.contains('ib-u')).toBe(false);
  expect(row.getAttribute('aria-current')).toBe('true');
  expect(document.activeElement).toBe(row);
});

test.skipIf(!hasDom)('opening a second row while one is open moves nothing; closing settles both, and focus goes to the row now in the slot', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const [first, second] = world.news;
  const before = order(el);
  await openRow(el, first!);
  await openRow(el, second!);
  expect(order(el)).toEqual(before);
  expect(sectionOfRow(el, first!)).toBe('new');
  expect(rowOf(el, first!)!.classList.contains('ib-u')).toBe(false);

  closeThread();
  // The list widened; the rows wait out the beat, and focus is on the closed row.
  await wait(20);
  expect(el.querySelector('section.ib-pane')).toBeNull();
  expect(order(el)).toEqual(before);
  expect(document.activeElement).toBe(rowOf(el, second!));
  // Then they settle: both read rows leave for folded Quiet.
  await wait(SETTLE_BEAT_MS + 60);
  await until(() => rowOf(el, first!) === null && rowOf(el, second!) === null, 'the settle');
  expect(el.querySelector('[data-section-id="quiet"] .ib-n')?.textContent).toBe('2');
  // Focus is never dropped to the page: the row that now sits in the closed row's slot has it.
  // (The next row on screen, else the one before: which rows follow depends on ids when times tie.)
  const slot = rowInSlot(before, second!, (id) => rowOf(el, id) !== null)!;
  expect(slot).toBeTruthy();
  expect(document.activeElement).toBe(rowOf(el, slot));
});

test.skipIf(!hasDom)("an agent's message that arrives while reading stays behind Show after the close; Show brings it in", async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  const late = await agentSends('A late note from the agent.');
  act(() => pokeStream!());
  await until(() => el.querySelector('[data-inbox-notice]') !== null, 'the "1 new" notice');
  expect(el.querySelector('[data-inbox-notice]')!.textContent).toContain('1 new in');
  expect(rowOf(el, late)).toBeNull();

  closeThread();
  await wait(SETTLE_BEAT_MS + 60);
  await until(() => rowOf(el, first) === null, 'the settle');
  // Closing settled only the person's own read: the agent's message still waits.
  expect(rowOf(el, late)).toBeNull();
  expect(el.querySelector('[data-inbox-notice]')!.textContent).toContain('1 new in');

  // Show from the keyboard: its line goes away, and focus goes to the row it brought in, not to the page.
  const notice = el.querySelector('[data-inbox-notice]') as HTMLButtonElement;
  act(() => {
    notice.focus();
    notice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    notice.click();
  });
  await until(() => rowOf(el, late) !== null, 'Show');
  expect(sectionOfRow(el, late)).toBe('new');
  expect(el.querySelector('[data-inbox-notice]')).toBeNull();
  expect(document.activeElement).toBe(rowOf(el, late));
});

// The failure this guards (design record "inbox-new-in-open-thread", the
// /seen race): the look sent when a thread opens marked the thread seen up to
// whatever the server held when it took the look, so a message that landed
// between the window's read and the look was marked seen without being shown.
// The look now carries `through_seq`, the newest agent message of the read.
test.skipIf(!hasDom)('the look sent on open covers the newest agent message the window read, and an arrival after it stays unseen', async () => {
  const first = world.news[0]!;
  // The thread holds two agent messages before the person opens it.
  await agentSends('A follow-up before you looked.', first);
  const read = JSON.parse((await loopback(`/api/inbox/threads/${first}`)).text) as { thread: { messages: { seq: number; author: { kind: string } }[] } };
  const newest = Math.max(...read.thread.messages.filter((m) => m.author.kind === 'agent').map((m) => m.seq));
  const el = await renderApp(`#project=${world.project}`);
  await openRow(el, first);
  const looks = postedBodies.filter((p) => p.path.startsWith(`/api/inbox/threads/${first}/seen`));
  expect(looks.length).toBe(1);
  expect(looks[0]!.body.through_seq).toBe(newest);

  // An agent message lands in the open thread: drawn, but not shown long enough to count (happy-dom lays
  // nothing out), so the store keeps it unseen and the list's "N new" never names the open thread.
  const arrival = await agentSends('Arrived while you read.', first);
  act(() => pokeStream!());
  await until(() => el.querySelector(`[data-message-article="${arrival}"]`) !== null, 'the arrival in the thread');
  await wait(1300);
  expect(await serverSection(first)).toBe('new');
  expect(el.querySelector('[data-inbox-notice]')).toBeNull();
  expect(postedBodies.filter((p) => p.path.startsWith(`/api/inbox/threads/${first}/seen`)).length).toBe(1);
});

test.skipIf(!hasDom)('under reduced motion the close settles at once, with nothing animated', async () => {
  media.reduce = true;
  const animate = HTMLElement.prototype.animate;
  let animations = 0;
  HTMLElement.prototype.animate = function (...args: Parameters<typeof animate>) {
    animations += 1;
    return animate ? animate.apply(this, args) : ({ cancel() {} } as Animation);
  };
  try {
    const el = await renderApp(`#project=${world.project}`);
    const first = world.news[0]!;
    await openRow(el, first);
    closeThread();
    // No beat: the list is settled in the same commit as the close.
    expect(rowOf(el, first)).toBeNull();
    expect(document.activeElement && document.activeElement !== document.body).toBe(true);
    expect(animations).toBe(0);
  } finally {
    HTMLElement.prototype.animate = animate;
  }
});

test.skipIf(!hasDom)('a phone: Back shows the list as it was left, and it settles while the next thread covers it', async () => {
  media.phone = true;
  const el = await renderApp(`#project=${world.project}`);
  const [first, second] = world.news;
  const before = order(el);
  await openRow(el, first!);
  // Back from the keyboard (Escape).
  closeThread();
  await until(() => el.querySelector('section.ib-pane') === null, 'Back');
  await wait(SETTLE_BEAT_MS + 60);
  // As left: the row read is in place, no longer bold, with focus on it.
  expect(order(el)).toEqual(before);
  expect(rowOf(el, first!)!.classList.contains('ib-u')).toBe(false);
  expect(document.activeElement).toBe(rowOf(el, first!));
  act(() => (document.activeElement as HTMLElement).blur());

  await openRow(el, second!);
  // Behind the thread the list caught up: the first read row went to Quiet; the one opened kept its place.
  expect(rowOf(el, first!)).toBeNull();
  expect(sectionOfRow(el, second!)).toBe('new');
  // A tap on Back: the list as left, and no row is handed focus (nothing the person did not choose).
  // (A real phone hides the list under the thread, which takes focus off the row opened; happy-dom does not.)
  act(() => (document.activeElement as HTMLElement | null)?.blur?.());
  mouseClick(el.querySelector('section.ib-pane [data-phone-back]') as HTMLButtonElement);
  await until(() => el.querySelector('section.ib-pane') === null, 'Back');
  expect(sectionOfRow(el, second!)).toBe('new');
  expect(document.activeElement?.closest('[data-thread-id]') ?? null).toBeNull();
});

test.skipIf(!hasDom)('after a mouse close the window hands no row focus, and E marks nothing the person did not choose', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  // A row that waits on the person (a question), so Mark read would apply to it.
  const asked = await agentSends('One question:\n\n:::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::');
  act(() => pokeStream!());
  await until(() => el.querySelector('[data-inbox-notice]') !== null, 'the "1 new" notice');
  mouseClick(el.querySelector('[data-inbox-notice]') as HTMLButtonElement);
  await until(() => rowOf(el, asked) !== null, 'Show');
  mouseClick(el.querySelector('section.ib-pane [aria-label="Close the thread"]') as HTMLButtonElement);
  await wait(SETTLE_BEAT_MS + 120);
  await until(() => rowOf(el, first) === null, 'the settle');
  expect(document.activeElement?.closest('[data-thread-id]') ?? null).toBeNull();
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  });
  await wait(150);
  expect(posted.filter((path) => path.endsWith('/read'))).toEqual([]);
});

test.skipIf(!hasDom)('Mark read inside an open thread: the toast says the row will move, and it moves when the list settles', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  // A New row once looked at waits on nobody (Mark read is off): a question from an agent does.
  const asked = await agentSends('One question:\n\n:::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::');
  act(() => pokeStream!());
  await until(() => el.querySelector('[data-inbox-notice]') !== null, 'the "1 new" notice');
  act(() => (el.querySelector('[data-inbox-notice]') as HTMLButtonElement).click());
  await until(() => rowOf(el, asked) !== null, 'Show');
  await openRow(el, asked, null);
  await until(() => el.querySelector('[data-mark-read]') !== null && !(el.querySelector('[data-mark-read]') as HTMLButtonElement).disabled, 'Mark read');
  act(() => (el.querySelector('[data-mark-read]') as HTMLButtonElement).click());
  await until(() => document.querySelector('[data-inbox-toast]') !== null, 'the toast');
  expect(document.querySelector('[data-inbox-toast]')!.textContent).toContain('will move to Quiet');
  expect(sectionOfRow(el, asked)).toBe('waiting');
  closeThread();
  await wait(SETTLE_BEAT_MS + 60);
  await until(() => rowOf(el, asked) === null, 'the settle');
});

test.skipIf(!hasDom)('a screen reader closing the thread (a click with no pointer and no key before it) keeps focus on the row', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  // The person used a mouse earlier; then their screen reader presses Close, which is a click counting none.
  pointerDown();
  act(() => (document.activeElement as HTMLElement | null)?.blur?.());
  act(() => (el.querySelector('section.ib-pane [aria-label="Close the thread"]') as HTMLButtonElement).click());
  await until(() => el.querySelector('section.ib-pane') === null, 'the close');
  expect(document.activeElement).toBe(rowOf(el, first));
});
