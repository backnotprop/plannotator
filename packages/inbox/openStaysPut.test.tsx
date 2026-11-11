import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { MARK_READ_LOOK_WAIT_MS } from './markRead';
import { PHONE_QUERY } from './phone';
import { rowInSlot, SETTLE_BEAT_MS, SHOW_LIT_AFTER_SLIDE_MS, SHOW_LIT_MS } from './settle';
import { resetListGroupsForTests } from './listGroups';

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
let pokeStream: (() => void) | null = null;
let posted: string[] = [];
let postedBodies: { path: string; body: Record<string, unknown> }[] = [];
let seenGate: Promise<void> | null = null;

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

async function agentSends(body: string, reply_to?: string): Promise<string> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_late', body, ...(reply_to ? { reply_to } : {}) } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

const TESTS = 21;

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

let media = { phone: false, reduce: false };

beforeEach(() => {
  if (!hasDom) return;
  world = worlds.shift()!;
  media = { phone: false, reduce: false };
  savedFetch = globalThis.fetch;
  posted = [];
  postedBodies = [];
  seenGate = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      posted.push(String(input));
      postedBodies.push({ path: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      if (seenGate && String(input).endsWith('/seen')) await seenGate;
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
  resetListGroupsForTests();
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
const order = (el: HTMLElement) => [...el.querySelectorAll('.ib-listcol .ib-lbody [data-thread-id]')].map((r) => r.getAttribute('data-thread-id')!);

async function openRow(el: HTMLElement, id: string, looked: 'quiet' | null = 'quiet') {
  const row = rowOf(el, id)!;
  act(() => {
    row.focus();
    row.click();
  });
  await until(() => el.querySelector('section.ib-pane') !== null && window.location.hash.includes(id), `the thread ${id}`);
  if (looked) await until(async () => (await serverSection(id)) === looked, 'the look on the server');
  await wait(120);
}

function closeThread() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

function pointerDown(target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
}

function mouseClick(el: HTMLElement) {
  pointerDown(el);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
}

test.skipIf(!hasDom)('opening a New row unbolds it where it is, keeps it selected and keeps focus on it', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  expect(sectionOfRow(el, first)).toBe('new');
  expect(rowOf(el, first)!.classList.contains('ib-u')).toBe(true);
  const before = order(el);
  await openRow(el, first);
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
  await wait(20);
  expect(el.querySelector('section.ib-pane')).toBeNull();
  expect(order(el)).toEqual(before);
  expect(document.activeElement).toBe(rowOf(el, second!));
  await wait(SETTLE_BEAT_MS + 60);
  await until(() => rowOf(el, first!) === null && rowOf(el, second!) === null, 'the settle');
  expect(el.querySelector('[data-section-id="quiet"] .ib-n')?.textContent).toBe('2');
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
  expect(rowOf(el, late)).toBeNull();
  expect(el.querySelector('[data-inbox-notice]')!.textContent).toContain('1 new in');

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

test.skipIf(!hasDom)('Show lights exactly the rows it brought in, after they slid into place, and the light comes off', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  const moved = world.news[2]!;
  await openRow(el, first);
  const late = await agentSends('A late note from the agent.');
  const reply = await agentSends('One more thing on this one.', moved);
  expect(reply).toBeTruthy();
  act(() => pokeStream!());
  await until(() => el.querySelector('[data-inbox-notice]')?.textContent?.includes('2 new in') === true, 'the "2 new" notice');
  const lit = () => [...el.querySelectorAll('.ib-listcol [data-thread-id][data-lit]')].map((r) => r.getAttribute('data-thread-id')!).sort();

  closeThread();
  await wait(SETTLE_BEAT_MS + 60);
  await until(() => rowOf(el, first) === null, 'the settle');
  await wait(SHOW_LIT_AFTER_SLIDE_MS + 60);
  expect(lit()).toEqual([]);

  const before = order(el);
  mouseClick(el.querySelector('[data-inbox-notice]') as HTMLButtonElement);
  await until(() => rowOf(el, late) !== null, 'Show');
  expect(lit()).toEqual([]);
  await wait(SHOW_LIT_AFTER_SLIDE_MS + 60);
  expect(lit()).toEqual([late, moved].sort());
  expect(order(el).filter((id) => before.includes(id) && id !== moved).every((id) => !lit().includes(id))).toBe(true);
  await wait(SHOW_LIT_MS);
  expect(lit()).toEqual([]);
// Its own time: the test waits out the light (about 5 s), right at the default 5 s limit; over it, the runner killed the Inbox this file shares.
}, 15_000);

test.skipIf(!hasDom)('the look sent on open covers the newest agent message the window read, and an arrival after it stays unseen', async () => {
  const first = world.news[0]!;
  await agentSends('A follow-up before you looked.', first);
  const read = JSON.parse((await loopback(`/api/inbox/threads/${first}`)).text) as { thread: { messages: { seq: number; author: { kind: string } }[] } };
  const newest = Math.max(...read.thread.messages.filter((m) => m.author.kind === 'agent').map((m) => m.seq));
  const el = await renderApp(`#project=${world.project}`);
  await openRow(el, first);
  const looks = postedBodies.filter((p) => p.path.startsWith(`/api/inbox/threads/${first}/seen`));
  expect(looks.length).toBe(1);
  expect(looks[0]!.body.through_seq).toBe(newest);

  // Not shown long enough to count (happy-dom lays nothing out), so the store keeps it unseen.
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
  closeThread();
  await until(() => el.querySelector('section.ib-pane') === null, 'Back');
  await wait(SETTLE_BEAT_MS + 60);
  expect(order(el)).toEqual(before);
  expect(rowOf(el, first!)!.classList.contains('ib-u')).toBe(false);
  expect(document.activeElement).toBe(rowOf(el, first!));
  act(() => (document.activeElement as HTMLElement).blur());

  await openRow(el, second!);
  expect(rowOf(el, first!)).toBeNull();
  expect(sectionOfRow(el, second!)).toBe('new');
  // A real phone hides the list under the thread, which takes focus off the row opened; happy-dom does not.
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
  const asked = await agentSends('One question:\n\n:::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::');
  act(() => pokeStream!());
  await until(() => el.querySelector('[data-inbox-notice]') !== null, 'the "1 new" notice');
  act(() => (el.querySelector('[data-inbox-notice]') as HTMLButtonElement).click());
  await until(() => rowOf(el, asked) !== null, 'Show');
  await openRow(el, asked, null);
  await until(async () => (await headerReads(el)).includes('Mark read'), 'Mark read');
  const markRead = (await moreMenu(el)).querySelector<HTMLElement>('[data-thread-read-item]')!;
  act(() => markRead.click());
  await until(() => document.querySelector('[data-inbox-toast]') !== null, 'the toast');
  expect(document.querySelector('[data-inbox-toast]')!.textContent).toContain('Moves to Quiet');
  expect(posted).toContain(`/api/inbox/threads/${asked}/read`);
  expect(sectionOfRow(el, asked)).toBe('waiting');
  closeThread();
  await wait(SETTLE_BEAT_MS + 60);
  await until(() => rowOf(el, asked) === null, 'the settle');
});

const hoverAction = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`.ib-lbody [data-row="${id}"] [data-row-mark-read]`);
const hoverUnread = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`.ib-lbody [data-row="${id}"] [data-row-mark-unread]`);
const hoverLabel = (el: HTMLElement, id: string) => el.querySelector(`.ib-lbody [data-row="${id}"] > .ib-ract`)?.textContent?.trim() ?? null;
const isBold = (el: HTMLElement, id: string) => rowOf(el, id)?.classList.contains('ib-u') ?? null;
async function moreMenu(el: HTMLElement): Promise<HTMLElement> {
  const more = el.querySelector<HTMLElement>('section.ib-pane [data-thread-more]')!;
  await act(async () => {
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    more.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    more.click();
  });
  await until(() => document.querySelector('[data-thread-menu]') !== null, 'the ⋯ menu');
  return document.querySelector<HTMLElement>('[data-thread-menu]')!;
}
async function headerReads(el: HTMLElement): Promise<string[]> {
  if (!el.querySelector('section.ib-pane [data-thread-more]')) return [];
  const menu = await moreMenu(el);
  const labels = [...menu.querySelectorAll('[data-thread-read-item], [data-thread-move-back-item], [data-thread-unread-item]')].map((item) => item.textContent?.trim() ?? '');
  await act(async () => el.querySelector<HTMLElement>('section.ib-pane [data-thread-more]')!.click());
  await until(() => document.querySelector('[data-thread-menu]') === null, 'the ⋯ menu shut');
  return labels;
}
const quietCount = (el: HTMLElement) => el.querySelector('[data-section-id="quiet"] .ib-n')?.textContent ?? '0';
const toastEl = () => document.querySelector<HTMLElement>('[data-inbox-toast]');
const pressKey = (key: string) =>
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
async function rowMenu(el: HTMLElement, id: string) {
  await act(async () => {
    rowOf(el, id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => document.querySelector('[data-row-menu]')?.getAttribute('data-row-menu') === id, 'the row menu');
  return [...document.querySelectorAll<HTMLElement>('[data-row-menu] [data-row-action]')].map((item) => item.getAttribute('data-row-action'));
}
async function closeMenu() {
  pressKey('Escape');
  await until(() => document.querySelector('[data-row-menu]') === null, 'the menu closed');
}
async function movedNow(el: HTMLElement, id: string, how: string) {
  await until(() => rowOf(el, id) === null, `${how}: the row moved to Quiet`);
  expect(quietCount(el)).toBe('1');
  expect(toastEl()?.textContent).toContain('Moved to Quiet');
  expect(toastEl()?.querySelector('[data-toast-undo]')).not.toBeNull();
}

test.skipIf(!hasDom)('a seen update held in New keeps Mark read in the row menu and E, each moving the row to Quiet now; its hover action and the header are Mark unread', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  const before = order(el);
  await openRow(el, first);
  expect(sectionOfRow(el, first)).toBe('new');
  expect(quietCount(el)).toBe('0');

  expect(await headerReads(el)).toContain('Mark unread');

  pressKey('e');
  await movedNow(el, first, 'E');
  pressKey('z');
  await until(() => sectionOfRow(el, first) === 'new', 'Z');
  expect(order(el)).toEqual(before);

  expect(hoverLabel(el, first)).toBe('Mark unread');

  const actions = await rowMenu(el, first);
  expect(actions).toContain('read');
  expect(actions).toContain('mark-unread');
  await act(async () => {
    document.querySelector<HTMLElement>('[data-row-menu] [data-row-action="read"]')!.click();
  });
  await movedNow(el, first, 'the row menu');

  expect(posted.filter((path) => path.endsWith('/read') || path.endsWith('/unread'))).toEqual([]);
  expect(await serverSection(first)).toBe('quiet');
  closeThread();
  await wait(SETTLE_BEAT_MS + 60);
  expect(rowOf(el, first)).toBeNull();
  expect(quietCount(el)).toBe('1');
});

test.skipIf(!hasDom)("the toast's Undo puts a held row back between the same neighbours, with another thread open", async () => {
  const el = await renderApp(`#project=${world.project}`);
  const [first, second] = world.news;
  const before = order(el);
  await openRow(el, first!);
  await openRow(el, second!);
  expect(sectionOfRow(el, first!)).toBe('new');
  expect(hoverLabel(el, first!)).toBe('Mark unread');
  expect(await rowMenu(el, first!)).toContain('read');
  await act(async () => {
    document.querySelector<HTMLElement>('[data-row-menu] [data-row-action="read"]')!.click();
  });
  await movedNow(el, first!, 'the row menu');
  expect(sectionOfRow(el, second!)).toBe('new');
  act(() => toastEl()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click());
  await until(() => sectionOfRow(el, first!) === 'new', 'Undo');
  expect(order(el)).toEqual(before);
  expect(toastEl()).toBeNull();
  await until(() => document.querySelector('[data-inbox-live]')?.textContent === 'Moved back.', 'the live region');
  expect(quietCount(el)).toBe('0');
  expect(hoverLabel(el, first!)).toBe('Mark unread');
});

test.skipIf(!hasDom)("the owner's report (2026-11-02): the open row and the row just left offer Mark unread on hover, from the moment the look goes out, and it sticks", async () => {
  const el = await renderApp(`#project=${world.project}`);
  const [first, second] = world.news;
  let release: () => void = () => {};
  seenGate = new Promise<void>((done) => (release = done));
  await openRow(el, first!, null);
  await until(() => posted.some((path) => path.endsWith(`/threads/${first}/seen`)), 'the look sent');
  expect(await serverSection(first!)).toBe('new');
  await until(() => hoverLabel(el, first!) === 'Mark unread', 'Mark unread on the open row');
  expect(hoverLabel(el, first!)).toBe('Mark unread');
  expect(isBold(el, first!)).toBe(false);
  expect(await headerReads(el)).toContain('Mark unread');
  release();
  seenGate = null;
  await until(async () => (await serverSection(first!)) === 'quiet', 'the look on the server');
  await wait(120);
  expect(sectionOfRow(el, first!)).toBe('new');
  expect(hoverLabel(el, first!)).toBe('Mark unread');
  expect(await headerReads(el)).toContain('Mark unread');

  await openRow(el, second!);
  expect(sectionOfRow(el, first!)).toBe('new');
  expect(hoverLabel(el, first!)).toBe('Mark unread');
  act(() => hoverUnread(el, first!)!.click());
  await until(() => posted.includes(`/api/inbox/threads/${first}/mark-unread`), 'the Mark unread write');
  await until(() => rowOf(el, first!)?.classList.contains('ib-u') === true, 'the row bold again');
  expect(await serverSection(first!)).toBe('new');
  expect(window.location.hash).toContain(second!);
  expect(hoverLabel(el, first!)).toBe('Mark read');
  closeThread();
  await wait(SETTLE_BEAT_MS + 120);
  expect(sectionOfRow(el, first!)).toBe('new');
  expect(isBold(el, first!)).toBe(true);
  expect(await serverSection(first!)).toBe('new');
}, 15_000);

test.skipIf(!hasDom)('Mark unread on the open row before its look lands waits for the look, so the look cannot read the thread again; the thread closes and stays unread', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  let release: () => void = () => {};
  seenGate = new Promise<void>((done) => (release = done));
  await openRow(el, first, null);
  await until(() => posted.some((path) => path.endsWith(`/threads/${first}/seen`)), 'the look sent');
  await until(() => hoverLabel(el, first) === 'Mark unread', 'Mark unread on the open row');
  act(() => hoverUnread(el, first)!.click());
  await wait(150);
  expect(posted).not.toContain(`/api/inbox/threads/${first}/mark-unread`);
  release();
  seenGate = null;
  await until(() => posted.includes(`/api/inbox/threads/${first}/mark-unread`), 'the Mark unread write');
  await until(() => !window.location.hash.includes('thread='), 'the thread to close');
  await until(() => toastEl()?.textContent?.includes('Marked unread') === true, 'the toast');
  await wait(SETTLE_BEAT_MS + 300);
  expect(await serverSection(first)).toBe('new');
  expect(sectionOfRow(el, first)).toBe('new');
  expect(isBold(el, first)).toBe(true);
  expect(posted.filter((path) => path.endsWith(`/threads/${first}/seen`)).length).toBe(1);
}, 15_000);

test.skipIf(!hasDom)('an agent writes to the row just left while another thread is open: its Mark unread finds it new already, and the row shows that (bold, Mark read), never a dead click', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const [first, second] = world.news;
  await openRow(el, first!);
  await openRow(el, second!);
  expect(hoverLabel(el, first!)).toBe('Mark unread');
  await agentSends('One more thing: the search index is rebuilt.', first!);
  act(() => pokeStream!());
  await until(() => el.querySelector('[data-inbox-notice]') !== null, 'the "1 new" notice');
  expect(await serverSection(first!)).toBe('new');
  expect(isBold(el, first!)).toBe(false);
  expect(hoverLabel(el, first!)).toBe('Mark unread');
  act(() => hoverUnread(el, first!)!.click());
  await until(() => posted.includes(`/api/inbox/threads/${first}/mark-unread`), 'the Mark unread write');
  await until(() => isBold(el, first!) === true && hoverLabel(el, first!) === 'Mark read', 'the row bold with Mark read');
  expect(toastEl()).toBeNull();
  expect(sectionOfRow(el, first!)).toBe('new');
  expect(window.location.hash).toContain(second!);
  act(() => hoverAction(el, first!)!.click());
  await until(() => posted.includes(`/api/inbox/threads/${first}/read`), 'the Mark read write');
  await until(() => toastEl()?.textContent?.includes('Marked read') === true, 'the Mark read toast');
}, 15_000);

test.skipIf(!hasDom)('a look slower than the wait: Mark unread tries once more when it lands, so the click is not lost', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  seenGate = new Promise<void>((done) => setTimeout(done, MARK_READ_LOOK_WAIT_MS + 1_000));
  await openRow(el, first, null);
  await until(() => posted.some((path) => path.endsWith(`/threads/${first}/seen`)), 'the look sent');
  await until(() => hoverLabel(el, first) === 'Mark unread', 'Mark unread on the open row');
  act(() => hoverUnread(el, first)!.click());
  await until(() => posted.filter((path) => path === `/api/inbox/threads/${first}/mark-unread`).length === 2, 'the second Mark unread');
  await until(() => !window.location.hash.includes('thread='), 'the thread to close');
  await until(() => toastEl()?.textContent?.includes('Marked unread') === true, 'the toast');
  expect(await serverSection(first)).toBe('new');
}, 15_000);

test.skipIf(!hasDom)('opening A then B before either look lands keeps both rows read on screen (no flash of A bold)', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const [first, second] = world.news;
  let release: () => void = () => {};
  seenGate = new Promise<void>((done) => (release = done));
  await openRow(el, first!, null);
  await until(() => posted.some((path) => path.endsWith(`/threads/${first}/seen`)), 'the first look sent');
  await openRow(el, second!, null);
  await until(() => posted.some((path) => path.endsWith(`/threads/${second}/seen`)), 'the second look sent');
  expect(isBold(el, first!)).toBe(false);
  expect(hoverLabel(el, first!)).toBe('Mark unread');
  expect(isBold(el, second!)).toBe(false);
  release();
  seenGate = null;
  await until(async () => (await serverSection(first!)) === 'quiet' && (await serverSection(second!)) === 'quiet', 'both looks on the server');
  await wait(150);
  expect(isBold(el, first!)).toBe(false);
  expect(hoverLabel(el, first!)).toBe('Mark unread');
}, 15_000);

test.skipIf(!hasDom)('E pressed before the look reaches the server takes the same way: it waits for the look, then moves the row now, writing nothing', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  let release: () => void = () => {};
  seenGate = new Promise<void>((done) => (release = done));
  await openRow(el, first, null);
  await until(() => posted.some((path) => path.endsWith(`/threads/${first}/seen`)), 'the look sent');
  expect(await serverSection(first)).toBe('new');
  expect(await headerReads(el)).toContain('Mark unread');
  pressKey('e');
  await wait(150);
  expect(posted.filter((path) => path.endsWith('/read'))).toEqual([]);
  expect(sectionOfRow(el, first)).toBe('new');
  release();
  seenGate = null;
  await movedNow(el, first, 'E after the look landed');
  expect(posted.filter((path) => path.endsWith('/read'))).toEqual([]);
  expect(await headerReads(el)).toEqual(['Mark unread']);
  expect(await serverSection(first)).toBe('quiet');
});

test.skipIf(!hasDom)('a look that never lands holds Mark read back only so long: past the wait, E writes as usual', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  seenGate = new Promise<void>(() => {});
  await openRow(el, first, null);
  await until(() => posted.some((path) => path.endsWith(`/threads/${first}/seen`)), 'the look sent');
  pressKey('e');
  await wait(MARK_READ_LOOK_WAIT_MS / 2);
  expect(posted.filter((path) => path.endsWith('/read'))).toEqual([]);
  await until(() => posted.includes(`/api/inbox/threads/${first}/read`), 'the Mark read write');
  await until(() => toastEl()?.textContent?.includes('Marked read') === true, 'the toast');
  expect(toastEl()!.textContent).toContain('Moves to Quiet');
  expect(sectionOfRow(el, first)).toBe('new');
  await until(async () => (await headerReads(el)).includes('Move back to the top'), 'Move back in the header ⋯');
}, 15_000);

test.skipIf(!hasDom)('a row already in Quiet offers no Mark read: not in the header, on hover, in the menu, nor E', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  closeThread();
  await wait(SETTLE_BEAT_MS + 60);
  await until(() => rowOf(el, first) === null, 'the settle into Quiet');
  act(() => el.querySelector<HTMLButtonElement>('[data-section-id="quiet"] button.ib-band')!.click());
  await until(() => sectionOfRow(el, first) === 'quiet', 'Quiet unfolded');
  await openRow(el, first, null);
  expect(await headerReads(el)).toEqual(['Mark unread']);
  expect(hoverAction(el, first)).toBeNull();
  expect(await rowMenu(el, first)).not.toContain('read');
  await closeMenu();
  pressKey('e');
  await wait(150);
  expect(toastEl()).toBeNull();
  expect(sectionOfRow(el, first)).toBe('quiet');
  expect(posted.filter((path) => path.endsWith('/read'))).toEqual([]);
});

test.skipIf(!hasDom)('a screen reader closing the thread (a click with no pointer and no key before it) keeps focus on the row', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  pointerDown();
  act(() => (document.activeElement as HTMLElement | null)?.blur?.());
  act(() => (el.querySelector('section.ib-pane [aria-label="Close the thread"]') as HTMLButtonElement).click());
  await until(() => el.querySelector('section.ib-pane') === null, 'the close');
  expect(document.activeElement).toBe(rowOf(el, first));
});

test.skipIf(!hasDom)('pinning the open thread leaves the held row order and the "N new" line unchanged', async () => {
  const el = await renderApp(`#project=${world.project}`);
  const first = world.news[0]!;
  await openRow(el, first);
  const late = await agentSends('A late note while the thread is open.');
  act(() => pokeStream!());
  await until(() => el.querySelector('[data-inbox-notice]') !== null, 'the "1 new" notice');
  const held = order(el);
  const notice = el.querySelector('[data-inbox-notice]')!.textContent;
  expect(notice).toContain('1 new in');
  const more = el.querySelector<HTMLElement>('[data-thread-more]')!;
  await act(async () => {
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    more.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    more.click();
  });
  await until(() => document.querySelector('[data-thread-pin-item]') !== null, 'the Star thread item');
  await act(async () => document.querySelector<HTMLElement>('[data-thread-pin-item]')!.click());
  await until(() => el.querySelector(`[data-pinned-row="${first}"]`) !== null, 'the pinned row');
  await wait(150);
  expect(order(el)).toEqual(held);
  expect(rowOf(el, late)).toBeNull();
  expect(el.querySelector('[data-inbox-notice]')!.textContent).toBe(notice);
});
