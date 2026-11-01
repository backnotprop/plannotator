/**
 * What's new over the tailnet: a page the owner opened through the tailnet
 * (`via: 'tailnet'` in the settings read) is offered What's new (the
 * sidebar's quiet link after an update, and Settings → About) and nothing
 * that needs the local-only update routes (Update, Check now, the update
 * switches); another allowed login's page is offered neither.
 *
 * The whole window (InboxApp) over a REAL Inbox server in a temp data dir
 * (tests/helpers/inbox-dom-server.ts `whats-new` mode: this Inbox is 0.28.19,
 * the release API a fake on loopback). The page's fetch goes to that server,
 * with two changes that stand for the tailnet: the settings answer names
 * `via: 'tailnet'` and `guest`, and any /api/inbox/update* request answers
 * 403 local_only (and is counted: the window must make none).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
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
let guest = false;
let updateCalls: string[] = [];
/** What the window asked the update routes to DO (it also reads GET /api/inbox/update when Settings opens; that is refused and harmless). */
const updateActions = () => updateCalls.filter((call) => !call.startsWith('GET '));

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-whatsnew-tailnet-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'whats-new'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PLANNOTATOR_UPDATE_CHECK: '' },
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
  updateCalls = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const route = path.split('?')[0]!;
    if (route === '/api/inbox/update' || route.startsWith('/api/inbox/update/')) {
      updateCalls.push(`${init?.method ?? 'GET'} ${path}`);
      return new Response(JSON.stringify({ error: 'This answers only on this computer, not over the tailnet.', code: 'local_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = await loopback(path, init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    let text = answer.text;
    if (route === '/api/inbox/settings' && answer.status === 200) text = JSON.stringify({ ...JSON.parse(text), via: 'tailnet', guest });
    return new Response(text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
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

const buttonsNamed = (el: HTMLElement, pattern: RegExp) => [...el.querySelectorAll('button')].filter((b) => pattern.test(b.textContent ?? '') || pattern.test(b.getAttribute('aria-label') ?? ''));

test.skipIf(!hasDom)("the owner over the tailnet: the sidebar link and Settings → About open What's new, with no update control anywhere", async () => {
  guest = false;
  const el = renderApp();
  await until(() => !!el.querySelector('[data-whats-new-link="0.28.19"]'), "the sidebar's What's new link");
  expect(el.querySelector('.ib-upd')).toBeNull();

  // Settings → About: the version and the link, none of what needs the update routes.
  act(() => {
    window.location.hash = '#settings/about';
  });
  await until(() => !!el.querySelector('[data-settings-about]'), 'Settings → About');
  expect(el.querySelector('[data-settings-about]')?.getAttribute('data-settings-about')).toBe('tailnet');
  const aboutLink = el.querySelector('[data-about-whats-new="0.28.19"]') as HTMLButtonElement;
  expect(aboutLink.textContent).toContain("What's new in 0.28.19");
  expect(el.querySelector('[data-settings-about] [role="switch"]')).toBeNull();
  expect(buttonsNamed(el, /Check now|Update/)).toEqual([]);
  expect(el.querySelector('[data-about-update], [data-general-update], [data-general-check]')).toBeNull();

  // It opens the notes the server read for that release; no Update button on the page.
  act(() => aboutLink.click());
  await until(() => el.querySelector('[data-whats-new-page="0.28.19"]')?.textContent?.includes('What 0.28.19 brings to the Inbox.') ?? false, 'the notes');
  expect(el.querySelector('.ib-error')).toBeNull();
  expect(el.querySelector('[data-whats-new-update]')).toBeNull();
  act(() => (el.querySelector('[data-whats-new-back]') as HTMLButtonElement).click());
  await until(() => !el.querySelector('[data-whats-new-page]'), 'the window again');

  // The sidebar's link opens them too.
  act(() => (el.querySelector('[data-whats-new-link="0.28.19"]') as HTMLButtonElement).click());
  await until(() => !!el.querySelector('[data-whats-new-page="0.28.19"]'), 'the notes from the sidebar link');

  expect(updateActions()).toEqual([]);
});

test.skipIf(!hasDom)("another allowed login over the tailnet: no What's new link, in the sidebar or in Settings → About", async () => {
  guest = true;
  const el = renderApp();
  await until(() => !!el.querySelector('.ib-listcol, [data-section-id], .pn-inbox'), 'the window');
  await settle();
  expect(el.querySelector('[data-whats-new-link]')).toBeNull();
  act(() => {
    window.location.hash = '#settings/about';
  });
  await until(() => !!el.querySelector('[data-settings-about]'), 'Settings → About');
  await settle();
  expect(el.querySelector('[data-about-whats-new]')).toBeNull();
  expect(el.querySelector('[data-settings-about] [role="switch"]')).toBeNull();
  expect(buttonsNamed(el, /Check now|Update|What's new/)).toEqual([]);
  expect(updateActions()).toEqual([]);
});
