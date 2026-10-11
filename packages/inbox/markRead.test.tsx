/**
 * Mark read and the Send that skips, as the window draws them (design record
 * "inbox-mark-read", approved 2026-10-11): the whole window (InboxApp) over a
 * REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts), the window's fetches carried to it over
 * loopback. What is proved: the reply box's skip chip and Keep open, the
 * header's Mark read button and its pressed "Read" state, `E` and `Z`, the
 * Undo toast, the warning (with Reply) when an agent is stopped on the
 * thread, the row's hover action, and that the person's own action never
 * reorders the list while the thread stays open.
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
import type { InboxListSection, InboxQuestion } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

/** The real Inbox, in its own process: happy-dom's Response cannot be served from this one. */
const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
/** One seeded project per test: the window keeps the first server session it saw, so every test shares one server. */
let worlds: { project: string; stopped: string; waiting: string }[] = [];
let ids = { project: '', stopped: '', waiting: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];

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

async function api<T>(path: string): Promise<T> {
  return JSON.parse((await loopback(path)).text) as T;
}

async function questionStates(threadId: string): Promise<{ state: string; answer: InboxQuestion['answer'] }[]> {
  const model = await api<{ thread: { messages: { questions?: InboxQuestion[] }[] } }>(`/api/inbox/threads/${threadId}`);
  return model.thread.messages.flatMap((m) => m.questions ?? []).map((q) => ({ state: q.state, answer: q.answer }));
}

async function serverSection(threadId: string): Promise<string | undefined> {
  const model = await api<{ sections: InboxListSection[] }>('/api/inbox/threads');
  return model.sections.find((s) => s.threads.some((t) => t.thread_id === threadId))?.id;
}

const TESTS = 6;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-markread-dom-')));
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
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  // The event stream is not needed: every action reads the list again itself.
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

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

const sectionOfRow = (el: HTMLElement, threadId: string) =>
  el.querySelector(`.ib-listcol [data-row="${threadId}"]`)?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null;

const press = (key: string, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

function type(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('the reply box says what a Send skips; a words-only Send skips them, and the row moves only after the thread is left', async () => {
  const el = await renderApp(`#thread=${ids.stopped}`);
  act(() => button(el, 'Reply').click());
  await settle();
  const chip = el.querySelector('[data-skip-chip]') as HTMLElement;
  expect(chip.getAttribute('data-skip-chip')).toBe('skip');
  expect(chip.textContent).toContain('2 unanswered questions will be skipped');
  act(() => button(chip, 'Keep open').click());
  expect(el.querySelector('[data-skip-chip]')?.textContent).toContain('2 unanswered questions stay open');
  act(() => button(el.querySelector('[data-skip-chip]')!, 'Skip them').click());
  expect(el.querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('skip');

  type(el, 'Redo the design.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  const reply = posted.find((p) => p.path.endsWith('/reply'))!;
  expect(reply.body).toMatchObject({ words: 'Redo the design.', questions: [], skip_unanswered: true });
  const questions = await questionStates(ids.stopped);
  expect(questions.map((q) => q.state)).toEqual(['sent', 'sent']);
  expect(questions.every((q) => q.answer?.skipped && q.answer.by_reply)).toBe(true);
  expect(await serverSection(ids.stopped)).toBe('sent');
  // While the thread stays open the row keeps its place; it moves when the person leaves.
  expect(sectionOfRow(el, ids.stopped)).toBe('stopped');
  act(() => (el.querySelector('.ib-phead [aria-label="Close the thread"]') as HTMLButtonElement).click());
  await until(() => sectionOfRow(el, ids.stopped) === 'sent', 'the row in Sent');
  // Sent sits below New since you looked, just above Quiet.
  const order = [...el.querySelectorAll('[data-section-id]')].map((g) => g.getAttribute('data-section-id'));
  expect(order.indexOf('sent')).toBeGreaterThan(order.indexOf('waiting'));
});

test.skipIf(!hasDom)('Keep open: the Send leaves the questions open', async () => {
  const el = await renderApp(`#thread=${ids.stopped}`);
  act(() => button(el, 'Reply').click());
  await settle();
  act(() => button(el.querySelector('[data-skip-chip]')!, 'Keep open').click());
  type(el, 'Thinking about it.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  expect(posted.find((p) => p.path.endsWith('/reply'))!.body.skip_unanswered).toBe(false);
  expect((await questionStates(ids.stopped)).map((q) => q.state)).toEqual(['open', 'open']);
});

test.skipIf(!hasDom)('E marks the open thread read; a stopped thread warns with Reply; E is not taken while typing; Z undoes', async () => {
  const el = await renderApp(`#thread=${ids.stopped}`);
  const head = () => el.querySelector('[data-mark-read]') as HTMLButtonElement;
  expect(head().getAttribute('aria-pressed')).toBe('false');
  expect(head().disabled).toBe(false);
  expect(head().textContent).toContain('Mark read');

  press('e');
  await until(() => head().getAttribute('aria-pressed') === 'true', 'the pressed button');
  expect(posted.at(-1)!.path).toBe(`/api/inbox/threads/${ids.stopped}/read`);
  expect(head().getAttribute('aria-pressed')).toBe('true');
  expect(head().textContent).toContain('Read');
  expect(el.querySelector('[data-read-line]')?.textContent).toContain('2 questions were closed unanswered');
  const toast = document.querySelector('[data-inbox-toast]') as HTMLElement;
  expect(toast.textContent).toContain('moved to Quiet');
  expect(toast.textContent).toContain('Claude Code was stopped on it.');
  expect(toast.querySelector('[data-toast-reply]')).not.toBeNull();
  expect((await questionStates(ids.stopped)).map((q) => q.state)).toEqual(['closed', 'closed']);
  expect(await serverSection(ids.stopped)).toBe('quiet');
  // The row keeps its place while the thread is open.
  expect(sectionOfRow(el, ids.stopped)).toBe('stopped');

  act(() => button(el, 'Reply').click());
  await settle();
  const before = posted.length;
  press('e', el.querySelector('textarea')!);
  await settle();
  expect(posted.length).toBe(before);
  act(() => button(el, 'Cancel').click());

  press('z');
  await until(() => head().getAttribute('aria-pressed') === 'false', 'the button back up');
  expect(posted.at(-1)!.path).toBe(`/api/inbox/threads/${ids.stopped}/unread`);
  expect(head().getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('[data-inbox-toast]')).toBeNull();
  expect((await questionStates(ids.stopped)).map((q) => q.state)).toEqual(['open', 'open']);
});

test.skipIf(!hasDom)('the pressed button moves it back; the toast Undo does the same', async () => {
  const el = await renderApp(`#thread=${ids.stopped}`);
  const head = () => el.querySelector('[data-mark-read]') as HTMLButtonElement;
  act(() => head().click());
  await until(() => head().getAttribute('aria-pressed') === 'true', 'Read');
  act(() => head().click());
  await until(() => head().getAttribute('aria-pressed') === 'false', 'Mark read again');
  act(() => head().click());
  await until(() => document.querySelector('[data-toast-undo]') !== null && head().getAttribute('aria-pressed') === 'true', 'the toast');
  act(() => (document.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  await until(() => head().getAttribute('aria-pressed') === 'false', 'Undo');
  expect(await serverSection(ids.stopped)).toBe('stopped');
});

test.skipIf(!hasDom)('the row hover action marks read without opening the thread; the Quiet row says Read', async () => {
  const el = await renderApp(`#project=${ids.project}`);
  const action = el.querySelector(`[data-row="${ids.waiting}"] [data-row-mark-read]`) as HTMLButtonElement;
  expect(action.textContent).toContain('Mark read');
  act(() => action.click());
  await until(() => document.querySelector('[data-inbox-toast]') !== null, 'the toast');
  expect(window.location.hash).toBe(`#project=${ids.project}`);
  // The row left Waiting for Quiet, which is folded.
  expect(sectionOfRow(el, ids.waiting)).toBeNull();
  expect(el.querySelector('[data-section-id="quiet"] .ib-n')?.textContent).toBe('1');
  // A plain toast: no warning, no Reply.
  const toast = document.querySelector('[data-inbox-toast]') as HTMLElement;
  expect(toast.textContent).toContain('It comes back when Claude Code writes again.');
  expect(toast.querySelector('[data-toast-reply]')).toBeNull();
  // Quiet is folded: open it, and the row says why it is there, with no action of its own.
  act(() => (el.querySelector('[data-section-id="quiet"] .ib-band') as HTMLButtonElement).click());
  expect(el.querySelector(`[data-row="${ids.waiting}"] .ib-c`)?.textContent).toBe('Read');
  expect(el.querySelector(`[data-row="${ids.waiting}"] [data-row-mark-read]`)).toBeNull();
});

test.skipIf(!hasDom)("the warning toast's Reply moves the thread back and opens the reply box", async () => {
  const el = await renderApp(`#thread=${ids.stopped}`);
  const head = () => el.querySelector('[data-mark-read]') as HTMLButtonElement;
  act(() => head().click());
  await until(() => document.querySelector('[data-toast-reply]') !== null, 'the warning toast');
  act(() => (document.querySelector('[data-toast-reply]') as HTMLButtonElement).click());
  await until(() => el.querySelector('textarea') !== null && head().getAttribute('aria-pressed') === 'false', 'the reply box');
  expect(posted.at(-1)!.path).toBe(`/api/inbox/threads/${ids.stopped}/unread`);
  expect((await questionStates(ids.stopped)).map((q) => q.state)).toEqual(['open', 'open']);
});
