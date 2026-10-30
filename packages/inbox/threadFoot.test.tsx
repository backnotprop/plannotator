/**
 * The thread's foot with the reply box closed (approval "thread-foot-status-right",
 * option A): the buttons first, in today's order, then the draft status and the
 * skip chip (drawn at the row's right end, or on their own line above the buttons
 * where the row is narrow: CSS, proved in tests/e2e/inbox-mark-read.spec.ts).
 * Send and Edit draft are described by the status. The error after a failed Send
 * sits above the button row, not under it.
 *
 * The window over a REAL Inbox (tests/helpers/inbox-dom-server.ts), its fetches
 * carried over loopback; the failed Send is a reply POST answered with a 500.
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

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; stopped: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', stopped: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** When set, a reply POST answers this error instead of reaching the Inbox (a failed Send). */
let failReplies = false;
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


const TESTS = 2;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-threadfoot-dom-')));
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
    if (failReplies && method === 'POST' && path.endsWith('/reply')) {
      return new Response(JSON.stringify({ error: 'The Inbox could not save the reply.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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
  failReplies = false;
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


const foot = (el: ParentNode) => el.querySelector('.ib-pfoot [data-foot-row]') as HTMLElement;
const labels = (row: HTMLElement) => [...row.querySelectorAll('button')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim());

async function pickFirst(el: HTMLElement) {
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 2, 'both questions');
  const card = el.querySelector('fieldset[data-question-key]') as HTMLElement;
  act(() => (card.querySelector('[data-question-option] input') as HTMLInputElement).click());
  await until(() => !!el.querySelector('[data-foot-status] [data-draft-foot]'), 'the draft status');
}

test.skipIf(!hasDom)('the draft status and the skip chip come after the buttons, and describe Send and Edit draft', async () => {
  const el = await renderApp(`#thread=${world.stopped}`);
  await until(() => !!foot(el), 'the foot');
  // Before a pick: the buttons alone, no status.
  expect(foot(el).querySelector('[data-foot-status]')).toBeNull();
  expect(labels(foot(el))).toEqual(['Reply', '2 open questions']);

  await pickFirst(el);
  const row = foot(el);
  const [buttons, status] = [...row.children] as HTMLElement[];
  // The order a screen reader reads: the buttons in today's order, then the status.
  expect(buttons!.matches('[data-foot-buttons]')).toBe(true);
  expect(status!.matches('[data-foot-status]')).toBe(true);
  expect(labels(buttons!)).toEqual(['Send', 'Edit draft', '2 open questions']);
  expect(status!.querySelector('[data-draft-foot]')!.textContent).toContain('1 pick');
  expect(status!.querySelector('[data-skip-chip="keep"]')).not.toBeNull();

  // Send and Edit draft name the status as their description: the draft note and the skip sentence.
  for (const name of ['Send', 'Edit draft']) {
    const ids = button(buttons!, name).getAttribute('aria-describedby')!.split(' ');
    const text = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(ids).toHaveLength(2);
    expect(text).toContain('1 pick');
    expect(text).toContain('1 question stays open');
  }
});

test.skipIf(!hasDom)('the error after a failed Send renders above the button row', async () => {
  const el = await renderApp(`#thread=${world.stopped}`);
  await pickFirst(el);
  failReplies = true;
  act(() => button(foot(el), 'Send').click());
  await until(() => !!el.querySelector('.ib-pfoot .ib-error'), 'the error');
  const error = el.querySelector('.ib-pfoot .ib-error') as HTMLElement;
  expect(error.getAttribute('role')).toBe('alert');
  expect(error.getAttribute('data-foot-error')).toBe('above');
  // Before the row in the foot, never after it.
  expect(error.compareDocumentPosition(foot(el)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(error.nextElementSibling).toBe(foot(el));
  // Nothing was sent; the pick is still waiting.
  expect(foot(el).querySelector('[data-draft-foot]')).not.toBeNull();
});
