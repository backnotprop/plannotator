/**
 * 👍 Looks good, as the window draws it (design record "inbox-acknowledge",
 * approved 2026-10-15, amended 2026-10-16: it is sent through to the agent):
 * the whole window (InboxApp) over a REAL Inbox in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts with its plain agent news, and
 * an Undo window of a few seconds). What is proved: the thread's foot is
 * Reply and Looks good side by side, with no New message button; Looks good
 * is hidden while a question waits; a click presses the button, draws the
 * pill under the message ("goes to … in a few seconds"), shows the one toast
 * with Undo, and the row reads "👍 Looks good" in place of "Read" once the
 * list settles; Z takes it back. Once the window passes the line says it is
 * saved for the agent, and once its session took it, "👍 Looks good ·
 * Delivered to Claude Code, <time>". The line's other states on their own.
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
import type { InboxListSection, InboxMessageWire } from '@plannotator/core/inbox-types';
import type { RecipientConnection } from './deliveryLine';
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { AckPill } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; news: string[]; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', news: [], waiting: '' };
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

async function api<T>(path: string): Promise<T> {
  return JSON.parse((await loopback(path)).text) as T;
}

async function serverMessages(threadId: string): Promise<InboxMessageWire[]> {
  return (await api<{ thread: { messages: InboxMessageWire[] } }>(`/api/inbox/threads/${threadId}`)).thread.messages;
}

async function serverRow(threadId: string) {
  const model = await api<{ sections: InboxListSection[] }>('/api/inbox/threads');
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

const TESTS = 7;
/** The Undo window this file's Inbox runs with: long enough for a test's clicks, short enough to wait out. */
const UNDO_WINDOW_MS = 2_500;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-ack-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'news'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, INBOX_DOM_SET_ASIDE_MS: String(UNDO_WINDOW_MS) },
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
  world = worlds.shift()!;
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

const footButtons = (el: HTMLElement) =>
  [...el.querySelectorAll('section.ib-pane .ib-pfoot > .ib-acts button')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
const ackButton = (el: HTMLElement) => el.querySelector('section.ib-pane [data-ack]') as HTMLButtonElement | null;
const press = (key: string) =>
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

test.skipIf(!hasDom)('the foot is Reply and Looks good side by side; there is no New message button', async () => {
  const thread = world.news[0]!;
  const el = await renderApp(`#thread=${thread}`);
  await until(() => ackButton(el) !== null, 'the Looks good button');
  expect(footButtons(el)).toEqual(['Reply', '👍Looks good']);
  expect(el.querySelector('[data-new-message]')).toBeNull();
  expect(ackButton(el)!.getAttribute('aria-pressed')).toBe('false');
  // Its explanation is the component tooltip, not a native title.
  expect(ackButton(el)!.hasAttribute('title')).toBe(false);
  expect(await tooltipOf(ackButton(el)!)).toContain('Tells Claude Code you read it');
});

test.skipIf(!hasDom)('hidden while a question waits: the foot is Reply and the open question (Re-ask is in its list)', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelector('section.ib-pane .ib-pfoot') !== null, 'the thread');
  await settle();
  expect(ackButton(el)).toBeNull();
  expect(footButtons(el)).toEqual(['Reply', '1 open question']);
});

test.skipIf(!hasDom)('a click presses the button, the pill and the toast show, the row says Looks good; Z takes it back', async () => {
  const thread = world.news[1]!;
  const el = await renderApp(`#thread=${thread}`);
  await until(() => ackButton(el) !== null, 'the Looks good button');
  const before = (await serverMessages(thread)).length;
  act(() => ackButton(el)!.click());
  await until(() => ackButton(el)?.getAttribute('aria-pressed') === 'true', 'the pressed button');
  expect(posted.filter((p) => p.path.endsWith('/ack'))).toEqual([{ path: `/api/inbox/messages/${thread}/ack`, body: expect.objectContaining({ ack: true }) }]);
  // The thread holds the same messages, the last one acknowledged; inside the Undo window it is not sent yet.
  const messages = await serverMessages(thread);
  expect(messages).toHaveLength(before);
  expect(messages.at(-1)!.ack).toMatchObject({ label: 'Looks good', settled_seq: null });
  const pill = el.querySelector('[data-ack-pill]') as HTMLElement;
  expect(pill.getAttribute('data-ack-pill')).toBe('pending');
  expect(pill.textContent).toContain('goes to Claude Code in a few seconds');
  const toast = el.querySelector('.ib-toast') as HTMLElement;
  expect(toast.textContent).toContain('Looks good');
  expect(toast.textContent).toContain('Goes to Claude Code in 10 s · Moves to Quiet');
  expect((await serverRow(thread)).section).toBe('quiet');

  // Leave the thread: the row settles in Quiet and says Looks good in place of Read.
  act(() => (el.querySelector('.ib-phead [aria-label="Close the thread"]') as HTMLButtonElement).click());
  await until(() => el.querySelector('[data-section-id="quiet"] .ib-band') !== null, 'the Quiet band');
  // Quiet is folded: open it.
  act(() => (el.querySelector('[data-section-id="quiet"] .ib-band') as HTMLButtonElement).click());
  await until(() => el.querySelector(`[data-section-id="quiet"] [data-row="${thread}"]`) !== null, 'the row in Quiet');
  expect(el.querySelector(`.ib-listcol [data-row="${thread}"]`)?.textContent).toContain('👍 Looks good');

  // Z while the toast is up: the ack and its Mark read are gone.
  press('z');
  await until(async () => (await serverMessages(thread)).at(-1)!.ack === null, 'the Undo');
  expect((await serverRow(thread)).read_at ?? null).toBeNull();
  expect(posted.filter((p) => p.path.endsWith('/ack')).at(-1)!.body).toMatchObject({ ack: false });
}, 30_000);

test.skipIf(!hasDom)('after the person replies, Looks good is gone: the reply is the answer', async () => {
  const thread = world.news[0]!;
  const el = await renderApp(`#thread=${thread}`);
  await until(() => ackButton(el) !== null, 'the Looks good button');
  const reply = [...el.querySelectorAll('section.ib-pane .ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement;
  act(() => reply.click());
  await settle();
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, 'Thanks, carry on.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = [...el.querySelectorAll('section.ib-pane .ib-pfoot button')].find((b) => b.textContent?.trim() === 'Send') as HTMLButtonElement;
  act(() => send.click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await settle();
  expect(ackButton(el)).toBeNull();
  expect(footButtons(el)).toEqual(['Reply']);
  expect((await serverRow(thread)).section).toBe('sent');
}, 30_000);

test.skipIf(!hasDom)('Move back withdraws the 👍: the button releases and the pill goes', async () => {
  const thread = world.news[1]!;
  const el = await renderApp(`#thread=${thread}`);
  await until(() => ackButton(el) !== null, 'the Looks good button');
  act(() => ackButton(el)!.click());
  await until(() => ackButton(el)?.getAttribute('aria-pressed') === 'true', 'the pressed button');
  act(() => (el.querySelector('[data-move-back]') as HTMLButtonElement).click());
  await until(() => ackButton(el)?.getAttribute('aria-pressed') === 'false', 'the button released');
  expect(el.querySelector('[data-ack-pill]')).toBeNull();
  expect((await serverMessages(thread)).at(-1)!.ack).toBeNull();
  expect((await serverRow(thread)).read_at ?? null).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('the pressed button takes it back; the line says each state on its way to the agent', async () => {
  const thread = world.news[2]!;
  const el = await renderApp(`#thread=${thread}`);
  await until(() => ackButton(el) !== null, 'the Looks good button');
  act(() => ackButton(el)!.click());
  await until(() => ackButton(el)?.getAttribute('aria-pressed') === 'true', 'the pressed button');
  act(() => ackButton(el)!.click());
  await until(() => ackButton(el)?.getAttribute('aria-pressed') === 'false', 'the button released');
  expect(el.querySelector('[data-ack-pill]')).toBeNull();

  const at = '2026-10-15T10:59:00.000Z';
  const base = { label: 'Looks good', at, read_seq: 4 };
  const lineOf = (ack: NonNullable<InboxMessageWire['ack']>, wakes: boolean, connection?: RecipientConnection | null) => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    const pillRoot = createRoot(box);
    act(() => pillRoot.render(<AckPill ack={ack} agent="Claude Code" wakes={wakes} connection={connection} />));
    const pill = box.querySelector('[data-ack-pill]')!;
    // A 👍 asks nothing of the agent: never a Send now beside it.
    expect(box.querySelector('button')).toBeNull();
    const out = { state: pill.getAttribute('data-ack-pill'), text: pill.textContent ?? '' };
    act(() => pillRoot.unmount());
    box.remove();
    return out;
  };
  expect(lineOf({ ...base, settled_seq: null }, true)).toMatchObject({ state: 'pending', text: expect.stringContaining('goes to Claude Code in a few seconds') });
  expect(lineOf({ ...base, settled_seq: 5, note_id: 'msg_note' }, true)).toMatchObject({ state: 'queued', text: expect.stringContaining('Queued for Claude Code; it gets this as its next turn.') });
  // The same honest words as a reply's line, from the session's connection now (deliveryLine).
  const sent = { ...base, settled_seq: 5, note_id: 'msg_note' };
  expect(lineOf(sent, true, { busy: true, idle_since: null, send_now: true })).toMatchObject({ state: 'queued', text: expect.stringContaining('Queued · Claude Code is working; it gets this when its turn ends.') });
  expect(lineOf(sent, true, { busy: false, idle_since: at, send_now: true })).toMatchObject({ state: 'sending', text: expect.stringContaining('Sending to Claude Code…') });
  expect(lineOf(sent, true, null)).toMatchObject({ state: 'queued', text: expect.stringContaining('Queued for Claude Code; it gets this when its session is back.') });
  expect(lineOf({ ...base, settled_seq: 5, note_id: 'msg_note' }, false)).toMatchObject({ state: 'saved', text: expect.stringContaining('Saved for Claude Code. It sees it when it next reads this thread.') });
  // Settled before it was sent through (an older Inbox): no wake will take it.
  expect(lineOf({ ...base, settled_seq: 5 }, true).state).toBe('saved');
  // The window ended after the thread moved on: not sent, and says why.
  expect(lineOf({ ...base, settled_seq: 5, note_id: null, not_sent: 'replied' }, true)).toEqual({ state: 'not-sent', text: '👍 Looks goodnot sent: you replied' });
  expect(lineOf({ ...base, settled_seq: 5, note_id: null, not_sent: 'wrote_again' }, true)).toEqual({ state: 'not-sent', text: '👍 Looks goodnot sent: Claude Code wrote again' });
  const delivered = lineOf({ ...base, settled_seq: 5, note_id: 'msg_note', delivered_at: '2026-10-15T11:04:00.000Z' }, true);
  expect(delivered.state).toBe('delivered');
  expect(delivered.text).toMatch(/^👍 Looks goodDelivered to Claude Code, /);
  expect(delivered.text).not.toContain('not sent');
}, 30_000);

test.skipIf(!hasDom)('after the Undo window the 👍 is sent: saved for the agent, then "Delivered to Claude Code" once its session took it', async () => {
  const thread = world.news[0]!;
  const el = await renderApp(`#thread=${thread}`);
  await until(() => ackButton(el) !== null, 'the Looks good button');
  act(() => ackButton(el)!.click());
  await until(() => el.querySelector('[data-ack-pill]')?.getAttribute('data-ack-pill') === 'pending', 'the pending line');
  await until(async () => (await serverMessages(thread)).at(-1)!.ack?.settled_seq != null, 'the Undo window to pass');
  // The window reads the thread again (this test's EventSource is a stand-in): the 👍 waits for the agent.
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp(`#thread=${thread}`);
  await until(() => again.querySelector('[data-ack-pill]')?.getAttribute('data-ack-pill') === 'saved', 'the saved line');
  // Its session's connection takes it, as the bridge's `delivered` records.
  const session = (await serverMessages(thread)).at(-1)!.author as { session: string };
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ deliver: { session: session.session } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  await until(async () => (await serverMessages(thread)).at(-1)!.ack?.delivered_at != null, 'the delivery');
  act(() => root?.unmount());
  host?.remove();
  const last = await renderApp(`#thread=${thread}`);
  await until(() => last.querySelector('[data-ack-pill]')?.getAttribute('data-ack-pill') === 'delivered', 'the delivered line');
  expect(last.querySelector('[data-ack-pill]')!.textContent).toMatch(/^👍 Looks goodDelivered to Claude Code, \d/);
  // The note that carried it is not drawn as a message of the thread.
  expect(last.querySelectorAll('section.ib-pane [data-message-id]').length).toBe((await serverMessages(thread)).length);
}, 30_000);
