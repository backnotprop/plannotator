/**
 * Ask, Add and Hand off from the reply box (approval "inbox-tag-handoff",
 * option A2), as the window draws them: the whole window (InboxApp) over a
 * REAL Inbox in a temp data dir (tests/helpers/inbox-dom-server.ts `tags`,
 * the tag world's live connections). What is proved: after a pick the one
 * line under the box says Send asks the agent, with "Add instead" and "Hand
 * off instead"; each switch reads back with "Ask instead", which restores the
 * Ask exactly; Send carries the mode on the tag; a hand-off shows the line in
 * the thread with Undo, who has the thread now and the toast with Undo, and
 * Undo turns it into an Ask; Add marks the session joined and says so; Hand
 * off is offered for one agent only, and neither switch for an agent that is
 * not woken.
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
import type { InboxMessageWire } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type Tags = { ids: { t1: string; t1msg: string; t2: string; r2: string; t3: string }; sessions: Record<string, string> };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let tags: Tags;
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

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-handoff-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'tags'], {
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
  const started = JSON.parse(line.trim()) as { port: number; tags: Tags };
  port = started.port;
  tags = started.tags;
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
  for (let i = 0; i < 120; i++) {
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

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
  await settle(10);
}

async function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await settle(10);
  return event;
}

const replyBox = (el: HTMLElement) => el.querySelector('section.ib-pane .ib-rbox textarea[aria-label^="Reply to"]') as HTMLTextAreaElement | null;
const picker = () => document.querySelector('[data-tag-picker]');

async function openReply(el: HTMLElement): Promise<HTMLTextAreaElement> {
  await until(() => el.querySelector('section.ib-pane .ib-pfoot') !== null, 'the thread');
  const reply = [...el.querySelectorAll('section.ib-pane .ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement;
  act(() => reply.click());
  await until(() => replyBox(el) !== null, 'the reply box');
  // The live sessions and the MCP agents are read once the box is open.
  await settle(60);
  return replyBox(el)!;
}

const modeLine = (el: HTMLElement) => el.querySelector('[data-tag-mode]');
const modeWords = (el: HTMLElement) => el.querySelector('[data-tag-mode-words]')?.textContent ?? null;
const modeLinks = (el: HTMLElement) => [...el.querySelectorAll('[data-tag-mode-to]')].map((b) => b.textContent);
const draftLabel = (el: HTMLElement) => el.querySelector('section.ib-pane .ib-pfoot')?.textContent ?? '';

async function tagPi(el: HTMLElement, words: string): Promise<HTMLTextAreaElement> {
  const box = await openReply(el);
  await type(box, `${words} @pi`);
  await until(() => picker() !== null, 'the picker');
  await press(box, 'ArrowDown');
  await press(box, 'Enter');
  await type(box, `${box.value}can you take this?`);
  await until(() => modeLine(el) !== null, 'the line');
  return box;
}

async function click(button: Element | null) {
  await act(async () => (button as HTMLButtonElement).click());
  await settle(10);
}

test.skipIf(!hasDom)('Hand off: the line switches and back, Send carries it, the thread says who has it with Undo, and Undo turns it into an Ask', async () => {
  const S = tags.sessions;
  const el = await renderApp(`#thread=${tags.ids.t1}`);
  const box = await tagPi(el, 'This is the queue side.');
  // Today's tag until a link is pressed.
  expect(modeLine(el)!.getAttribute('data-tag-mode')).toBe('ask');
  expect(modeWords(el)).toBe('Asks Pi');
  expect(modeLinks(el)).toEqual(['Add instead', 'Hand off instead']);
  (el.querySelector('[data-tag-mode-to="handoff"]') as HTMLButtonElement).focus();
  await click(el.querySelector('[data-tag-mode-to="handoff"]'));
  expect(modeWords(el)).toBe('Hands this thread to Pi');
  expect(modeLinks(el)).toEqual(['Ask instead']);
  expect(draftLabel(el)).toContain('Reply to Pi');
  // The pressed link is gone once the line switches: focus is back in the field, so Mod+Enter still sends.
  expect(document.activeElement).toBe(box);
  // Ask instead goes back to exactly the Ask.
  await click(el.querySelector('[data-tag-mode-to="ask"]'));
  expect(modeWords(el)).toBe('Asks Pi');
  expect(draftLabel(el)).not.toContain('Reply to Pi');
  await click(el.querySelector('[data-tag-mode-to="handoff"]'));
  // The reply box keeps its keys: Mod+Enter sends.
  await press(box, 'Enter', { metaKey: true });
  await until(async () => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  expect(posted.filter((p) => p.path.endsWith('/reply')).at(-1)!.body.tags).toEqual([{ host: 'pi', session: S.pi, label: 'Pi', mode: 'handoff' }]);
  const stored = (await serverMessages(tags.ids.t1)).at(-1)!;
  expect(stored.to).toEqual({ host: 'pi', session: S.pi });
  // After Send: the line in the thread with Undo, who has it now, the toast with Undo, and the box resets to an Ask.
  await until(() => el.querySelector('[data-thread-move="handoff"]') !== null, 'the hand-off line');
  const moved = el.querySelector('[data-thread-move="handoff"]')!;
  expect(moved.textContent).toContain('You handed this thread to Pi');
  expect(moved.querySelector('[data-handoff-undo]')).not.toBeNull();
  expect(el.querySelector('[data-thread-owner]')!.textContent).toContain('Now with Pi');
  await until(() => document.querySelector('[data-inbox-toast] .ib-tlead')?.textContent === 'Handed to Pi', 'the toast');
  // Undo from the toast.
  await click(document.querySelector('[data-inbox-toast] [data-toast-undo]'));
  await until(() => posted.some((p) => p.path.endsWith(`/messages/${stored.id}/handoff/undo`)), 'the Undo');
  await until(async () => !!(await serverMessages(tags.ids.t1)).at(-1)!.handoff?.undone_at, 'the hand-off taken back');
  const undone = (await serverMessages(tags.ids.t1)).at(-1)!;
  expect(undone.to).toBeUndefined();
  expect(undone.tags?.map((t) => t.session)).toEqual([S.pi]);
  await until(() => el.querySelector('[data-thread-move]') === null && el.querySelector('[data-thread-owner]') === null, 'the Ask look');
}, 30_000);

test.skipIf(!hasDom)('Add: Send carries it, the added session is marked, and the thread says it joined', async () => {
  const S = tags.sessions;
  const el = await renderApp(`#thread=${tags.ids.t3}`);
  const box = await tagPi(el, 'Keep an eye on this.');
  (el.querySelector('[data-tag-mode-to="add"]') as HTMLButtonElement).focus();
  await click(el.querySelector('[data-tag-mode-to="add"]'));
  expect(document.activeElement).toBe(box);
  expect(modeWords(el)).toBe('Adds Pi to this thread');
  // The Send button, clicked (the line's buttons are not the Send).
  await click(el.querySelector('section.ib-pane .ib-pfoot .ib-acts .ib-btn.ib-pri'));
  await until(async () => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  expect(posted.filter((p) => p.path.endsWith('/reply')).at(-1)!.body.tags).toEqual([{ host: 'pi', session: S.pi, label: 'Pi', mode: 'add' }]);
  expect((await serverMessages(tags.ids.t3)).at(-1)!.tags).toEqual([expect.objectContaining({ session: S.pi, joined: true })]);
  await until(() => el.querySelector('[data-thread-move="added"]') !== null, 'the added line');
  expect(el.querySelector('[data-thread-move="added"]')!.textContent).toContain('You added Pi to this thread');
  expect(el.querySelector('[data-thread-owner]')).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('two agents tagged: Add only, no Hand off; an agent that is not woken: no switch at all', async () => {
  const el = await renderApp(`#thread=${tags.ids.t1}`);
  const box = await tagPi(el, 'Two of you.');
  await type(box, `${box.value} @opencode`);
  await until(() => picker() !== null, 'the picker');
  await press(box, 'ArrowDown');
  await press(box, 'Enter');
  await until(() => modeWords(el) === 'Asks Pi and OpenCode', 'two names');
  expect(modeLinks(el)).toEqual(['Add instead']);
  await type(box, `${box.value} @codex`);
  await until(() => picker() !== null, 'the picker');
  while (document.querySelector('[data-tag-option][aria-selected="true"]')?.getAttribute('data-tag-option') !== tags.sessions.codex) await press(box, 'ArrowDown');
  await press(box, 'Enter');
  await until(() => modeLinks(el).length === 0, 'no switch');
}, 30_000);
