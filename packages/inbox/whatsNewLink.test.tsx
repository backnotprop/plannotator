/**
 * The sidebar's "What's new in X" link after an update installed outside the
 * Inbox (the install script run by hand, so no notes were saved): the whole
 * window (InboxApp) over a REAL Inbox server in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts in `whats-new` mode: this Inbox
 * is 0.28.19, the one before it 0.28.18, the release API a fake on loopback).
 * What is proved: the link shows and opens the notes the server fetched by the
 * release's tag; with update checks off and no notes saved there is no link.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

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

/** One Inbox per test: the env decides whether update checks are on. */
async function startInbox(env: Record<string, string> = {}) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-whatsnew-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'whats-new'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PLANNOTATOR_UPDATE_CHECK: '', ...env },
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
  port = (JSON.parse(line.trim()) as { port: number }).port;
}

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  window.location.hash = '';
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

function renderApp() {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

test.skipIf(!hasDom)("the link shows after an update installed by hand, and opens the notes fetched for that version", async () => {
  await startInbox();
  const el = renderApp();
  await until(() => !!el.querySelector('[data-whats-new-link="0.28.19"]'), 'the What\'s new link');
  const link = el.querySelector('[data-whats-new-link="0.28.19"]') as HTMLButtonElement;
  expect(link.textContent).toContain("What's new in 0.28.19");
  act(() => link.click());
  await until(() => el.querySelector('[data-whats-new-page="0.28.19"]')?.textContent?.includes('What 0.28.19 brings to the Inbox.') ?? false, 'the notes');
  expect(el.querySelector('.ib-error')).toBeNull();
  // Opened from the Inbox, "‹ Inbox" is the browser's Back: it adds no history entry.
  const entries = window.history.length;
  act(() => (el.querySelector('[data-whats-new-back]') as HTMLButtonElement).click());
  await until(() => !el.querySelector('[data-whats-new-page]'), 'the Inbox again');
  expect(window.history.length).toBe(entries);
  expect(window.location.hash).toBe('');
});

test.skipIf(!hasDom)('update checks off and no notes saved: no link', async () => {
  await startInbox({ PLANNOTATOR_UPDATE_CHECK: '0' });
  const el = renderApp();
  await until(() => !!el.querySelector('.ib-listcol, [data-section-id], .pn-inbox'), 'the window');
  await settle();
  expect(el.querySelector('[data-whats-new-link]')).toBeNull();
  // The route has nothing to show either, and asked nobody.
  expect((await loopback('/api/inbox/whats-new?version=0.28.19')).status).toBe(404);
});
