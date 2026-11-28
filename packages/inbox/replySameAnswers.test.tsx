/**
 * Another client (a second tab, a phone) saves the same answer between this
 * window's last save and its reply: the reply comes back "changed since you
 * read it", and the Send goes once more at the server's revision
 * (replySameAnswers.ts), so the person never sees the refusal and one reply is
 * written. A different answer saved meanwhile keeps the refusal.
 *
 * The window over a REAL Inbox (tests/helpers/inbox-dom-server.ts), its
 * fetches carried over loopback.
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
import type { InboxQuestion } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** Runs once before the next reply reaches the server: another client's save landing first. */
let beforeReply: (() => Promise<void>) | null = null;
const lines: string[] = [];

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

type ThreadModel = {
  thread: { messages: { id: string; seq?: number; author: { kind: string }; reply_to: string | null; body: string; questions?: InboxQuestion[] }[] };
};
const readThread = async (id: string) => JSON.parse((await loopback(`/api/inbox/threads/${id}`)).text) as ThreadModel;

const TESTS = 2;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-othersend-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let buffer = '';
  let first: string | null = null;
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) {
          if (first === null) first = line;
          else lines.push(line);
        }
        at = buffer.indexOf('\n');
      }
    }
  })();
  for (let i = 0; i < 400 && first === null; i++) await new Promise((r) => setTimeout(r, 25));
  if (first === null) throw new Error('the Inbox did not start');
  const started = JSON.parse(first) as { port: number; worlds: World[] };
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
    if (method === 'POST' && path.endsWith('/reply') && beforeReply) {
      const first = beforeReply;
      beforeReply = null;
      await first();
    }
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  posted = [];
  beforeReply = null;
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

async function renderApp(hash: string) {
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

const orama = (el: ParentNode) =>
  [...el.querySelectorAll<HTMLInputElement>('fieldset[data-question-key] input[type="radio"]')].find((r) => r.closest('label')?.textContent?.includes('Orama'))!;

test.skipIf(!hasDom)('another client saves the same answer between the save and the reply: Send goes again once, with its revision', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => orama(el).click());
  await until(async () => (await readThread(world.waiting)).thread.messages[0]!.questions![0]!.state === 'picked', 'the choice saved');
  await settle();
  posted = [];
  beforeReply = async () => {
    const q = (await readThread(world.waiting)).thread.messages[0]!.questions![0]!;
    const body = JSON.stringify({ questions: [{ key: q.key, revision: q.revision, answer: q.answer }] });
    const bumped = await loopback(`/api/inbox/messages/${encodeURIComponent(q.message_id)}/picks`, 'POST', body);
    if (bumped.status !== 200) throw new Error(`the other client's save failed: ${bumped.text}`);
  };
  act(() => button(el, 'Send').click());
  await until(async () => (el.textContent?.includes('changed since you read it') ?? false) || (await readThread(world.waiting)).thread.messages[0]!.questions![0]!.state === 'sent', 'the Send or its refusal');
  await settle();
  expect(beforeReply).toBeNull();
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(2);
  expect(el.textContent).not.toContain('changed since you read it');
  const q = (await readThread(world.waiting)).thread.messages[0]!.questions![0]!;
  expect(q.answer?.selected).toEqual(['Orama']);
  const sent = (await readThread(world.waiting)).thread.messages.filter((m) => m.author.kind === 'person');
  expect(sent).toHaveLength(1);
});


test.skipIf(!hasDom)('another client saves a DIFFERENT answer meanwhile: the refusal stands and nothing is sent', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => orama(el).click());
  await until(async () => (await readThread(world.waiting)).thread.messages[0]!.questions![0]!.state === 'picked', 'the choice saved');
  await settle();
  posted = [];
  beforeReply = async () => {
    const q = (await readThread(world.waiting)).thread.messages[0]!.questions![0]!;
    const body = JSON.stringify({ questions: [{ key: q.key, revision: q.revision, answer: { ...q.answer, selected: ['Pagefind'] } }] });
    const bumped = await loopback(`/api/inbox/messages/${encodeURIComponent(q.message_id)}/picks`, 'POST', body);
    if (bumped.status !== 200) throw new Error(`the other client's save failed: ${bumped.text}`);
  };
  act(() => button(el, 'Send').click());
  await until(() => el.textContent?.includes('changed since you read it') ?? false, 'the refusal');
  expect(posted.filter((p) => p.path.endsWith('/reply'))).toHaveLength(1);
  const model = await readThread(world.waiting);
  expect(model.thread.messages[0]!.questions![0]!.state).toBe('picked');
  expect(model.thread.messages.filter((m) => m.author.kind === 'person')).toHaveLength(0);
});
