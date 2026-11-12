import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const SESSION = 'ses_actions';

type World = { project: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let agentLines: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let saves: { body: Record<string, unknown>; status: number }[] = [];

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

async function agentAsks(task: string): Promise<string> {
  const stdin = child!.stdin as import('bun').FileSink;
  stdin.write(`${JSON.stringify({ send: { project: world.project, session: SESSION, body: `Release 4.2 is built.\n\n:::action\n${task}\nStopped: release 4.2 waits on it\n:::` } })}\n`);
  await stdin.flush();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await agentLines!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return (JSON.parse(line.trim()) as { sent: string }).sent;
}

async function actionOf(messageId: string): Promise<InboxQuestion> {
  const model = JSON.parse((await loopback(`/api/inbox/threads/${messageId}`)).text) as { thread: { messages: InboxMessageWire[] } };
  return model.thread.messages.find((m) => m.id === messageId)!.questions!.find((q) => q.kind === 'action')!;
}

async function sentElsewhere(messageId: string, key: string): Promise<void> {
  const answer = await loopback(`/api/inbox/messages/${messageId}/reply`, 'POST', JSON.stringify({ idempotency_key: `elsewhere-${key}`, words: '', questions: [], actions: [{ key }] }));
  expect(answer.status).toBe(200);
  expect((await actionOf(messageId)).state).toBe('sent');
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-action-note-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '2'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  agentLines = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await agentLines.read();
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
  world = worlds.shift()!;
  saves = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    const answer = await loopback(path, method, body);
    if (method === 'POST' && path.includes('/actions/')) saves.push({ body: body ? JSON.parse(body) : {}, status: answer.status });
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
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
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
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

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await wait(100);
  return host;
}

const card = (el: HTMLElement) => el.querySelector<HTMLElement>('section.ib-pane [data-action-card]');
const toasts = (el: HTMLElement) => [...el.querySelectorAll('.ib-toast')].map((t) => t.textContent ?? '');

async function markDone(el: HTMLElement) {
  await until(() => card(el)?.querySelector('[data-action-done]') != null, 'the action item');
  act(() => card(el)!.querySelector<HTMLButtonElement>('[data-action-done]')!.click());
  await until(() => card(el)?.querySelector('[data-action-draft-note]') != null, 'the Done in the draft');
}

test.skipIf(!hasDom)("a note saved after the item was sent from another window: the save is refused, and the window says nothing", async () => {
  const asked = await agentAsks('Approve the production deploy on Vercel');
  const el = await renderApp(`#thread=${asked}`);
  await markDone(el);
  const key = (await actionOf(asked)).key;
  const note = card(el)!.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Promoted from the CLI.');
    note.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sentElsewhere(asked, key);
  await until(() => saves.some((s) => s.body.note === 'Promoted from the CLI.'), 'the note save');
  await wait(200);
  expect(saves.find((s) => s.body.note === 'Promoted from the CLI.')!.status).toBe(409);
  expect(toasts(el)).toEqual([]);
  await until(() => card(el)?.getAttribute('data-action-state') === 'done', 'the item read as sent');
}, 30_000);

test.skipIf(!hasDom)("the person's own take-back of an item already sent elsewhere is refused, and the window says so", async () => {
  const asked = await agentAsks('Merge PR #1937 on GitHub');
  const el = await renderApp(`#thread=${asked}`);
  await markDone(el);
  const key = (await actionOf(asked)).key;
  await sentElsewhere(asked, key);
  expect(card(el)!.getAttribute('data-action-state')).toBe('pending');
  await wait(550);
  act(() => card(el)!.querySelector<HTMLButtonElement>('[data-action-tick]')!.click());
  await until(() => saves.some((s) => s.body.outcome === null), 'the take-back');
  expect(saves.find((s) => s.body.outcome === null)!.status).toBe(409);
  await until(() => toasts(el).length > 0, 'the error toast');
  expect(toasts(el).join(' ')).toContain('already sent');
}, 30_000);
