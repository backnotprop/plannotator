/**
 * The Search tip in the whole window (InboxApp) over a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts), where `searchTip.test.tsx` drives the palette alone.
 *
 * What regresses: App not handing the palette the Inbox's `reveal.search_tip` (the `searchTip` prop left out or
 * miswired), so the tip never shows to anyone; the claim not reaching the Inbox, so it would show at every load.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
/** Long ago: the other tips and the one-time dialogs that could stand in the way are behind the person. */
const SETTLED = '2026-10-01T10:00:00.000Z';

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let settingsAnswered = 0;

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

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-search-tip-app-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  // The Search tip not yet shown (present, so the helper does not settle it), everything else that could be first settled.
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'config.json'),
    JSON.stringify({
      inboxSnoozeIntro: { firstUseAt: SETTLED, snoozedAt: SETTLED },
      inboxListIntro: { shownAt: SETTLED, version: 2 },
      inboxVoiceIntro: { shownAt: SETTLED },
      inboxReveals: { search_tip: {}, sidebar_tip: { shownAt: SETTLED }, launch_tip: { shownAt: SETTLED } },
    }),
  );
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_BROWSER: NO_BROWSER },
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
  settingsAnswered = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    if (method === 'GET' && path.split('?')[0] === '/api/inbox/settings') settingsAnswered += 1;
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

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const saved = () => JSON.parse(readFileSync(join(dir!, 'data', 'config.json'), 'utf8')) as { inboxReveals?: { search_tip?: { shownAt?: string } } };

test.skipIf(!hasDom)('the window hands the palette the Inbox\'s Search tip: the first open shows it and the Inbox stamps it', async () => {
  // The Inbox has it for this page.
  const settings = JSON.parse((await loopback('/api/inbox/settings')).text) as { reveal?: { search_tip?: boolean } };
  expect(settings.reveal?.search_tip).toBe(true);
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-sp-entry') !== null && settingsAnswered > 0, 'the window and its settings');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  act(() => (host!.querySelector('.ib-sp-entry') as HTMLButtonElement).click());
  await until(() => document.querySelector('dialog[data-search-palette]') !== null, 'the palette');
  await until(() => document.querySelector('dialog[data-search-palette] [data-search-tip]') !== null, 'the Search tip');
  await until(() => typeof saved().inboxReveals?.search_tip?.shownAt === 'string', 'config.json inboxReveals.search_tip stamped');
}, 30_000);
