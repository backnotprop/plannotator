import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection, InboxQuestion } from '@plannotator/core/inbox-types';
import { resetListGroupsForTests } from './listGroups';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

/** The real Inbox, in its own process: happy-dom's Response cannot be served from this one. */
const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
/** One seeded project per test: the window keeps the first server session it saw, so every test shares one server. */
type World = { project: string; stopped: string; waiting: string; news: string[] };
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

type ThreadModel = { thread: { messages: { author: { kind: string }; questions?: InboxQuestion[] }[] } };
const threadOf = async (id: string) => JSON.parse((await loopback(`/api/inbox/threads/${id}`)).text) as ThreadModel;

async function serverSection(threadId: string): Promise<string | undefined> {
  const model = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] };
  return model.sections.find((s) => s.threads.some((t) => t.thread_id === threadId))?.id;
}

const TESTS = 7;

function agentWrites(send: { project: string; session: string; body: string; reply_to: string }) {
  const stdin = child!.stdin as { write(data: string): number; flush(): void };
  stdin.write(`${JSON.stringify({ send })}\n`);
  stdin.flush();
}

const QUESTION = [':::question', 'Which index should the blog use?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-markunread-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'news'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
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

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!document.querySelector('section.ib-pane .ib-phead'), 'the thread header');
  await until(() => posted.some((p) => p.path.endsWith('/seen')), 'the look');
}

async function renderList(firstRow: string) {
  window.location.hash = `#project=${ids.project}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!rowButton(firstRow), 'the list');
}

async function openQuiet() {
  const band = document.querySelector<HTMLButtonElement>('[data-section-id="quiet"] button.ib-band')!;
  if (band.getAttribute('aria-expanded') === 'true') return;
  await act(async () => {
    band.click();
  });
}

const rowAction = (threadId: string, kind: 'read' | 'unread') => document.querySelector<HTMLButtonElement>(`.ib-lbody [data-row="${threadId}"] [data-row-mark-${kind}]`);

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

const head = () => document.querySelector<HTMLElement>('section.ib-pane .ib-phead');
const toast = () => document.querySelector<HTMLElement>('[data-inbox-toast]');
const rowButton = (id: string) => document.querySelector<HTMLElement>(`.ib-listcol [data-thread-id="${id}"]`);
const sectionOfRow = (id: string) => document.querySelector(`.ib-listcol [data-row="${id}"]`)?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null;

async function moreUnreadItem(): Promise<HTMLElement | null> {
  await press(head()!.querySelector<HTMLElement>('[data-thread-more]')!);
  await until(() => !!document.querySelector('[data-thread-menu]'), 'the ⋯ menu');
  return document.querySelector<HTMLElement>('[data-thread-menu] [data-thread-unread-item]');
}

const moreReadItem = () => document.querySelector<HTMLElement>('[data-thread-menu] [data-thread-read-item]');

async function expectBackInNew(threadId: string, messagesBefore: number) {
  expect(posted.at(-1)!.path).toBe(`/api/inbox/threads/${threadId}/mark-unread`);
  await until(() => !window.location.hash.includes('thread='), 'the thread to close');
  await until(() => sectionOfRow(threadId) === 'new', 'the row drawn in New');
  expect(rowButton(threadId)!.classList.contains('ib-u')).toBe(true);
  expect(await serverSection(threadId)).toBe('new');
  expect(toast()?.querySelector('.ib-tlead')?.textContent).toBe('Marked unread');
  expect((await threadOf(threadId)).thread.messages.length).toBe(messagesBefore);
}

test.skipIf(!hasDom)("a thread read by opening it: ⋯ More offers Mark unread and no Mark read, E stays idle, and Undo reads it again", async () => {
  const id = ids.news[0]!;
  await loopback(`/api/inbox/threads/${id}/seen`, 'POST', '{}');
  expect(await serverSection(id)).toBe('quiet');
  await renderApp(`#thread=${id}`);
  await until(() => !!head()?.querySelector('[data-thread-more]'), 'the header');
  expect(await moreUnreadItem()).not.toBeNull();
  expect(moreReadItem()).toBeNull();
  await press(head()!.querySelector<HTMLElement>('[data-thread-more]')!);
  await until(() => !document.querySelector('[data-thread-menu]'), 'the ⋯ menu to close');
  const writes = posted.length;
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  });
  expect(posted.length).toBe(writes);

  const messages = (await threadOf(id)).thread.messages.length;
  const button = (await moreUnreadItem())!;
  await act(async () => button.click());
  await expectBackInNew(id, messages);
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(async () => (await serverSection(id)) === 'quiet', 'the thread read again');
  expect(posted.at(-1)!.path).toBe(`/api/inbox/threads/${id}/seen`);
  expect(typeof posted.at(-1)!.body.through_seq).toBe('number');
});

test.skipIf(!hasDom)("a plain update opened from New, its row held in New: ⋯ More's Mark unread (the owner, 2026-11-02) closes it and leaves it unread", async () => {
  const id = ids.news[0]!;
  expect(await serverSection(id)).toBe('new');
  // Opened from the list: opened by address, the list's first read could land after the look and draw the row in Quiet (flaky).
  await renderList(id);
  await until(() => sectionOfRow(id) === 'new', 'the row in New');
  await act(async () => rowButton(id)!.click());
  await until(() => !!head(), 'the thread header');
  await until(() => posted.some((p) => p.path.endsWith('/seen')), 'the look sent');
  await until(async () => (await serverSection(id)) === 'quiet', 'the look');
  await until(() => sectionOfRow(id) === 'new', 'the row held in New');
  const messages = (await threadOf(id)).thread.messages.length;
  const item = await moreUnreadItem();
  expect(item === null).toBe(false);
  await act(async () => item!.click());
  await expectBackInNew(id, messages);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  expect(await serverSection(id)).toBe('new');
  expect(posted.filter((p) => p.path === `/api/inbox/threads/${id}/seen`).length).toBe(1);
}, 15_000);

test.skipIf(!hasDom)("the row's hover action toggles: Mark read on a row that waits, Mark unread on a read row, bold in place, in New after a tidy", async () => {
  const id = ids.news[0]!;
  await loopback(`/api/inbox/threads/${id}/seen`, 'POST', '{}');
  await renderList(ids.waiting);
  expect(rowAction(ids.waiting, 'read')).not.toBeNull();
  expect(rowAction(ids.waiting, 'unread')).toBeNull();
  await openQuiet();
  await until(() => sectionOfRow(id) === 'quiet', 'the read row in Quiet');
  expect(rowAction(id, 'read')).toBeNull();
  const button = rowAction(id, 'unread')!;

  const messages = (await threadOf(id)).thread.messages.length;
  await act(async () => button.click());
  expect(window.location.hash).toBe(`#project=${ids.project}`);
  expect(posted.at(-1)!.path).toBe(`/api/inbox/threads/${id}/mark-unread`);
  await until(() => rowButton(id)?.classList.contains('ib-u') === true, 'the row bold in place');
  expect(sectionOfRow(id)).toBe('quiet');
  expect(toast()?.querySelector('.ib-tlead')?.textContent).toBe('Marked unread');
  expect(toast()?.textContent).not.toContain('back in New');
  expect((await threadOf(id)).thread.messages.length).toBe(messages);
  await until(() => rowAction(id, 'read') !== null && rowAction(id, 'unread') === null, 'Mark read on the row again');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-list-refresh]')!.click());
  await until(() => sectionOfRow(id) === 'new', 'the row back in New');
  expect(rowButton(id)!.classList.contains('ib-u')).toBe(true);
});

test.skipIf(!hasDom)('a thread marked read: ⋯ More offers Move back to the top and Mark unread, which marks it unread, its question still set aside', async () => {
  const id = ids.waiting;
  await loopback(`/api/inbox/threads/${id}/read`, 'POST', '{}');
  await renderApp(`#thread=${id}`);
  await until(() => !!head()?.querySelector('[data-thread-more]'), 'the header');
  const item = await moreUnreadItem();
  expect(document.querySelector('[data-thread-menu] [data-thread-move-back-item]')).not.toBeNull();
  expect(item).not.toBeNull();
  const messages = (await threadOf(id)).thread.messages.length;
  await act(async () => item!.click());
  await expectBackInNew(id, messages);
  expect((await threadOf(id)).thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.state))).toEqual(['closed']);
});

test.skipIf(!hasDom)("Undo after a question arrives during the toast: it never closes that question, and the new message stays new", async () => {
  const id = ids.waiting;
  await loopback(`/api/inbox/threads/${id}/read`, 'POST', '{}');
  await renderList(ids.stopped);
  await openQuiet();
  await until(() => !!rowAction(id, 'unread'), 'Mark unread on the read row');
  await act(async () => rowAction(id, 'unread')!.click());
  await until(() => toast()?.querySelector('.ib-tlead')?.textContent === 'Marked unread', 'the toast');

  agentWrites({ project: ids.project, session: 'ses_late', body: QUESTION, reply_to: id });
  await until(async () => (await threadOf(id)).thread.messages.length === 2, 'the agent to write');

  const reads = posted.filter((p) => p.path.endsWith(`/${id}/read`)).length;
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(() => posted.at(-1)!.path === `/api/inbox/threads/${id}/seen`, 'the Undo');
  await until(() => !toast(), 'the toast to go');
  expect(posted.filter((p) => p.path.endsWith(`/${id}/read`)).length).toBe(reads);
  const states = (await threadOf(id)).thread.messages.map((m) => (m.questions ?? []).map((q) => q.state));
  expect(states).toEqual([['closed'], ['open']]);
  const list = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] };
  expect(list.sections.flatMap((s) => s.threads).find((t) => t.thread_id === id)).toMatchObject({ section: 'waiting', unseen: 1, unread: true });
});

test.skipIf(!hasDom)('a stale row: when the thread is new already the server writes nothing, so no toast says "Marked unread"', async () => {
  const id = ids.news[0]!;
  await loopback(`/api/inbox/threads/${id}/seen`, 'POST', '{}');
  await renderList(ids.waiting);
  await openQuiet();
  await until(() => !!rowAction(id, 'unread'), 'Mark unread on the read row');
  agentWrites({ project: ids.project, session: 'ses_late2', body: 'Update: one more page indexed.', reply_to: id });
  await until(async () => (await serverSection(id)) === 'new', 'the agent to write');
  await act(async () => rowAction(id, 'unread')!.click());
  await until(() => posted.at(-1)!.path === `/api/inbox/threads/${id}/mark-unread`, 'the write');
  await until(() => rowButton(id)?.classList.contains('ib-u') === true && rowAction(id, 'read') !== null, 'the row refreshed in place');
  expect(sectionOfRow(id)).toBe('quiet');
  expect(toast()).toBeNull();
});

test.skipIf(!hasDom)('Mark read on a row whose Mark read stands gives the look back; its Undo is Mark unread again, never a Move back', async () => {
  const id = ids.waiting;
  await loopback(`/api/inbox/threads/${id}/read`, 'POST', '{}');
  await loopback(`/api/inbox/threads/${id}/mark-unread`, 'POST', '{}');
  await renderList(id);
  await until(() => !!rowAction(id, 'read'), 'Mark read on the row');
  await act(async () => rowAction(id, 'read')!.click());
  await until(async () => (await serverSection(id)) === 'quiet', 'the row back in Quiet');
  await until(() => !!toast(), 'the toast');
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(async () => (await serverSection(id)) === 'new', 'the row back in New');
  expect(posted.at(-1)!.path).toBe(`/api/inbox/threads/${id}/mark-unread`);
  expect(posted.some((p) => p.path === `/api/inbox/threads/${id}/unread`)).toBe(false);
  expect((await threadOf(id)).thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.state))).toEqual(['closed']);
});
