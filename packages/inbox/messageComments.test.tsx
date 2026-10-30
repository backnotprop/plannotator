/**
 * Comments on the text of an agent's message (approval
 * "inbox-message-comments", 2026-10-19), as the window draws them: the whole
 * window (InboxApp) over a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts). What is proved: words selected in an
 * agent's message open the comment-only toolbar (Comment and 👍, no Delete,
 * no label picker); Comment opens the composer, Save stores the comment
 * (`POST /api/inbox/messages/:id/annotations`), the passage keeps its
 * highlight, and the reply box's chip counts and lists it; Send carries it,
 * and the agent's own `wait_for_reply` (through the Inbox's MCP) returns the
 * quote and the comment under "Feedback on your message from <time>". A
 * reload draws the saved highlight again; removing it from the chip takes the
 * highlight away. The person's own message and a question card's words open
 * no toolbar.
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
import type { InboxAnnotationRecord, InboxMessageWire } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let buffered = '';
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let sessions = 0;

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

/** The next line the server prints. */
async function nextLine(): Promise<string> {
  while (!buffered.includes('\n')) {
    const { value, done } = await reader!.read();
    if (done) throw new Error('the Inbox stopped');
    buffered += new TextDecoder().decode(value);
  }
  const at = buffered.indexOf('\n');
  const line = buffered.slice(0, at);
  buffered = buffered.slice(at + 1);
  return line;
}

/** A command on the server's stdin, and its answer. */
async function command<T>(value: unknown): Promise<T> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify(value)}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return JSON.parse(await nextLine()) as T;
}

const BODY = [
  'I moved the retry loop into the client.',
  '',
  'The backoff is now two, four and eight seconds, and a 429 waits for its Retry-After header.',
].join('\n');

/** An agent writes a new thread (its own session); returns the message id (also the thread id) and the session. */
async function agentWrites(body = BODY, replyTo?: string): Promise<{ id: string; session: string }> {
  sessions += 1;
  const session = `ses_comments_${sessions}`;
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session, body, ...(replyTo ? { reply_to: replyTo } : {}) } });
  return { id: sent, session };
}

const TESTS = 5;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-message-comments-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await nextLine()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
});

afterAll(async () => {
  if (!hasDom) return;
  reader?.releaseLock();
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
  for (const el of document.querySelectorAll('.annotation-toolbar, [data-comment-popover]')) el.remove();
  window.getSelection()?.removeAllRanges();
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

/** Open the reply box: Reply, or "Edit draft" while comments wait for a Send. */
function openReply(el: ParentNode) {
  const open = [...el.querySelectorAll('button')].find((b) => /^(Reply|Edit draft)$/.test(b.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  if (!open) throw new Error('no Reply');
  act(() => open.click());
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

const messageBody = (id: string) => host!.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
const toolbarButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].map((b) => b.getAttribute('aria-label') ?? b.title ?? b.textContent?.trim());
const popoverBox = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');

/** Select `phrase` inside `scope` the way a drag does, and let the viewer hear the pointer go up. */
async function select(scope: HTMLElement, phrase: string) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  if (!node) throw new Error(`"${phrase}" is not in the message`);
  const at = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const article = node.parentElement!.closest('article') ?? scope;
  await act(async () => {
    article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function type(area: HTMLTextAreaElement, words: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, words);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Select `phrase` in the message, press Comment, write `words`, save. */
async function commentOn(messageId: string, phrase: string, words: string) {
  await select(messageBody(messageId)!, phrase);
  const comment = [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].find((b) => (b.getAttribute('aria-label') ?? b.title) === 'Comment');
  if (!comment) throw new Error(`no Comment on the toolbar: ${toolbarButtons().join(' | ')}`);
  await act(async () => comment.click());
  await until(() => popoverBox() !== null, 'the composer');
  await type(popoverBox()!, words);
  const save = [...document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')].find((b) => /^(Save|Add comment|Comment)$/.test(b.textContent?.trim() ?? ''));
  if (save) await act(async () => save.click());
  else await act(async () => popoverBox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true })));
  await settle();
}

async function pending(threadId: string): Promise<InboxAnnotationRecord[]> {
  return (await api<{ annotations: InboxAnnotationRecord[] }>(`/api/inbox/threads/${threadId}/attachments`)).annotations;
}

test.skipIf(!hasDom)("words selected in an agent's message: the comment-only toolbar, the composer, the highlight, the chip, Send; the agent reads the quote and the comment", async () => {
  const message = await agentWrites();
  const el = await renderApp(`#thread=${message.id}`);
  await until(() => messageBody(message.id)?.textContent?.includes('Retry-After') === true, 'the message');

  // The toolbar a file's comments use on these surfaces: Comment and 👍, no Delete, no label picker.
  await select(messageBody(message.id)!, 'two, four and eight seconds');
  const names = toolbarButtons();
  expect(names).toContain('Comment');
  expect(names).toContain('Looks good');
  expect(names).not.toContain('Delete');
  expect(names).not.toContain('Quick label');
  // Escape closes the toolbar, not the thread.
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
  expect(toolbarButtons()).toEqual([]);
  expect(messageBody(message.id)).not.toBeNull();

  await commentOn(message.id, 'two, four and eight seconds', 'Cap the total wait too.');
  await until(() => posted.some((p) => p.path === `/api/inbox/messages/${message.id}/annotations`), 'the save');
  const records = await pending(message.id);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ message_id: message.id, attachment_id: '', path: message.id, message: { at: expect.any(String) } });
  expect(records[0]!.annotation).toMatchObject({ type: 'COMMENT', originalText: 'two, four and eight seconds', text: 'Cap the total wait too.' });
  // The passage keeps its light highlight.
  const mark = messageBody(message.id)!.querySelector(`mark.annotation-highlight`);
  expect(mark?.textContent).toBe('two, four and eight seconds');

  // The reply box's chip counts it and lists it under the message.
  openReply(el);
  await settle();
  await until(() => el.querySelector('[data-annotations-chip]')?.textContent === '1 annotation', 'the chip');
  act(() => (el.querySelector('[data-annotations-chip]') as HTMLButtonElement).click());
  const row = el.querySelector(`[data-annotation-row="${records[0]!.id}"]`) as HTMLElement;
  expect(row.textContent).toContain("Claude Code's message, ");
  expect(row.textContent).toContain('"two, four and eight seconds"');
  expect(row.textContent).toContain('Cap the total wait too.');
  act(() => (el.querySelector('.ib-annpop [aria-label="Close the list"]') as HTMLButtonElement).click());

  // Send: the comment rides it, marked sent with the reply.
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  const reply = posted.find((p) => p.path.endsWith('/reply'))!;
  expect(reply.body.annotation_ids).toEqual([records[0]!.id]);
  await until(async () => (await pending(message.id)).length === 0, 'the comment sent');

  // The agent that wrote the message reads it through the Inbox's MCP.
  const { waited } = await command<{ waited: { status: string; reply: { body: string } } }>({ wait: { thread: message.id, session: message.session } });
  expect(waited.status).toBe('replied');
  const body = waited.reply.body;
  expect(body).toContain('# Feedback on your messages');
  expect(body).toMatch(new RegExp(`## Feedback on your message from .+ \\(${message.id}\\)`));
  expect(body).toContain('Feedback on: "two, four and eight seconds"');
  expect(body).toContain('> Cap the total wait too.');
}, 30_000);

test.skipIf(!hasDom)('👍 on selected words is a comment too; a reload draws the saved highlight again, and Remove in the chip takes it away', async () => {
  const message = await agentWrites();
  await renderApp(`#thread=${message.id}`);
  await until(() => messageBody(message.id)?.textContent?.includes('Retry-After') === true, 'the message');
  await select(messageBody(message.id)!, 'Retry-After header');
  const good = [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].find((b) => (b.getAttribute('aria-label') ?? b.title) === 'Looks good')!;
  await act(async () => good.click());
  await until(async () => (await pending(message.id)).length === 1, 'the 👍 saved');
  const [record] = await pending(message.id);
  expect(record!.annotation).toMatchObject({ type: 'COMMENT', isQuickLabel: true, originalText: 'Retry-After header' });

  // Reload: drawn again from the store, by its words.
  act(() => root?.unmount());
  host?.remove();
  const el = await renderApp(`#thread=${message.id}`);
  await until(() => messageBody(message.id)?.querySelector('mark.annotation-highlight')?.textContent === 'Retry-After header', 'the highlight drawn again');

  // Removed from the reply box's list: gone from the store and from the text.
  openReply(el);
  await until(() => el.querySelector('[data-annotations-chip]')?.textContent === '1 annotation', 'the chip');
  act(() => (el.querySelector('[data-annotations-chip]') as HTMLButtonElement).click());
  await act(async () => button(el.querySelector(`[data-annotation-row="${record!.id}"]`)!, 'Remove').click());
  await until(async () => (await pending(message.id)).length === 0, 'the removal');
  await until(() => messageBody(message.id)?.querySelector('mark.annotation-highlight') === null, 'the highlight removed');
}, 30_000);

test.skipIf(!hasDom)("the person's own message and a question card's words open no toolbar", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelector('[data-question-key]') !== null, 'the question card');
  // A question card's prompt: no toolbar.
  const prompt = el.querySelector<HTMLElement>('[data-question-key] [data-question-part="prompt"]')!;
  await select(prompt, prompt.textContent!.trim().split(' ').slice(0, 2).join(' '));
  expect(toolbarButtons()).toEqual([]);
  // The agent's words around it still take comments.
  expect(messageBody(world.waiting)!.hasAttribute('data-text-comments')).toBe(true);

  // The person's own reply: no toolbar.
  act(() => button(el, 'Reply').click());
  await settle();
  const area = el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement;
  await type(area, 'Holding this one for now.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelectorAll('[data-author="person"] [data-message-id]').length === 1 || el.querySelectorAll('article[data-author="person"]').length === 1, 'my reply drawn');
  const mine = el.querySelector<HTMLElement>('article[data-author="person"] [data-message-id]')!;
  expect(mine.hasAttribute('data-text-comments')).toBe(false);
  await select(mine, 'Holding this one');
  expect(toolbarButtons()).toEqual([]);
}, 30_000);

test.skipIf(!hasDom)('a refused save takes its highlight away and says why', async () => {
  const message = await agentWrites();
  const el = await renderApp(`#thread=${message.id}`);
  await until(() => messageBody(message.id)?.textContent?.includes('Retry-After') === true, 'the message');
  // The thread is archived behind the window's back: the save is refused.
  await loopback(`/api/inbox/messages/${message.id}/resolve`, 'POST', JSON.stringify({ resolved: true }));
  await commentOn(message.id, 'retry loop', 'Name the file.');
  await until(() => posted.some((p) => p.path === `/api/inbox/messages/${message.id}/annotations`), 'the save');
  await until(() => messageBody(message.id)?.querySelector('mark.annotation-highlight') === null, 'the highlight taken away');
  expect(el.textContent).toContain('resolved');
  expect(await pending(message.id)).toHaveLength(0);
  const thread = await api<{ thread: { messages: InboxMessageWire[] } }>(`/api/inbox/threads/${message.id}`);
  expect(thread.thread.messages).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)("two sessions wrote: a comment on A's message reaches A, not B, whose reply carries the words", async () => {
  const a = await agentWrites();
  const b = await agentWrites('Also: I added jitter to the backoff.', a.id);
  const el = await renderApp(`#thread=${a.id}`);
  await until(() => messageBody(a.id)?.textContent?.includes('Retry-After') === true, "A's message");
  await commentOn(a.id, 'two, four and eight seconds', 'Cap the total wait too.');
  await until(async () => (await pending(a.id)).length === 1, 'the comment saved');
  openReply(el);
  await settle();
  await type(el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement, 'Jitter is fine.');
  act(() => button(el, 'Send').click());
  await until(async () => (await pending(a.id)).length === 0, 'the Send');
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies.map((p) => p.path)).toEqual([`/api/inbox/messages/${a.id}/reply`, `/api/inbox/messages/${b.id}/reply`]);
  expect(replies[0]!.body).toMatchObject({ words: '' });
  expect(replies[1]!.body).toMatchObject({ words: 'Jitter is fine.' });
  expect(replies[1]!.body.annotation_ids).toBeUndefined();

  // Each session's connection is handed only the replies to its own messages (the bridge's pendingReplies).
  const bodyOf = async (id: string) => (await api<{ thread: { messages: InboxMessageWire[] } }>(`/api/inbox/threads/${a.id}`)).thread.messages.find((m) => m.id === id)!.body;
  const { delivered: toA } = await command<{ delivered: string[] }>({ deliver: { session: a.session } });
  expect(toA).toHaveLength(1);
  const bodyA = await bodyOf(toA[0]!);
  expect(bodyA).toContain('Feedback on: "two, four and eight seconds"');
  expect(bodyA).toContain('> Cap the total wait too.');
  expect(bodyA).not.toContain('Jitter is fine.');
  const { delivered: toB } = await command<{ delivered: string[] }>({ deliver: { session: b.session } });
  expect(toB).toHaveLength(1);
  const bodyB = await bodyOf(toB[0]!);
  expect(bodyB).toContain('Jitter is fine.');
  expect(bodyB).not.toContain('Feedback on your messages');
}, 30_000);
