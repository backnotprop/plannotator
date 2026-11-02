/**
 * What's new over the tailnet: a page the owner opened through the tailnet
 * (`via: 'tailnet'`, `guest: false` in the settings read) is offered What's
 * new (the sidebar's quiet link after an update, and Settings → About) and,
 * as on the computer, the update control (approval "inbox-tailnet-owner");
 * another allowed login's page is offered neither.
 *
 * The whole window (InboxApp) over a REAL Inbox server in a temp data dir
 * (tests/helpers/inbox-dom-server.ts `whats-new` mode: this Inbox is 0.28.19,
 * the release API a fake on loopback). The page's fetch goes to that server,
 * with what stands for the tailnet: the settings answer names `via: 'tailnet'`
 * and `guest`, and for a guest any /api/inbox/update* request answers 403
 * local_only. Those requests are counted: the window must make none that acts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { writeReleaseNotes } from '../shared/update-check';
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
/** False: the list says no update, so the sidebar shows the quiet What's new link in the Update button's place, as on the computer. */
let offered = true;
let updateCalls: string[] = [];
/** What the window asked the update routes to DO (it also reads GET /api/inbox/update when Settings opens). */
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
  // A newer release (0.28.25) is already known, so this Inbox offers an update (state "available") next to the notes
  // of the version it runs; the notes of both are saved and checks are off, so nothing asks GitHub.
  for (const version of ['0.28.19', '0.28.25']) writeReleaseNotes({ version, notes: `What ${version} brings to the Inbox.`, highlights: [] }, join(dir, 'data'));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'whats-new'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PLANNOTATOR_UPDATE_CHECK: '0', WHATS_NEW_LATEST: '0.28.25' },
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
  offered = true;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const route = path.split('?')[0]!;
    if (route === '/api/inbox/update' || route.startsWith('/api/inbox/update/')) {
      updateCalls.push(`${init?.method ?? 'GET'} ${path}`);
      if (guest) return new Response(JSON.stringify({ error: 'This answers only on this computer, not over the tailnet.', code: 'local_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = await loopback(path, init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    let text = answer.text;
    if (route === '/api/inbox/settings' && answer.status === 200) text = JSON.stringify({ ...JSON.parse(text), via: 'tailnet', guest });
    if (route === '/api/inbox/threads' && !offered && answer.status === 200) text = JSON.stringify({ ...JSON.parse(text), update: null });
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

test.skipIf(!hasDom)("the owner over the tailnet: the sidebar link and Settings → About open What's new", async () => {
  guest = false;
  offered = false;
  const el = renderApp();
  await until(() => !!el.querySelector('[data-whats-new-link="0.28.19"]'), "the sidebar's What's new link");
  expect(el.querySelector('.ib-upd')).toBeNull();

  // Settings → About: the computer's block, with the link to the release this Inbox runs.
  act(() => {
    window.location.hash = '#settings/about';
  });
  await until(() => !!el.querySelector('[data-settings-about]'), 'Settings → About');
  expect(el.querySelector('[data-settings-about]')?.getAttribute('data-settings-about')).toBe('');
  const aboutLink = el.querySelector('[data-about-whats-new="0.28.19"]') as HTMLButtonElement;
  expect(aboutLink.textContent).toContain("What's new in 0.28.19");

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

test.skipIf(!hasDom)("the owner over the tailnet with a release to install: the update control is offered in the sidebar, in About and on that release's What's new page", async () => {
  guest = false;
  const el = renderApp();
  await until(() => !!el.querySelector('.ib-upd'), "the sidebar's Update button");
  expect(JSON.parse((await loopback('/api/inbox/threads')).text).update).toMatchObject({ state: 'available', version: '0.28.25' });

  act(() => {
    window.location.hash = '#settings/about';
  });
  await until(() => !!el.querySelector('[data-about-update]'), "About's Update now");
  expect(el.querySelector('[data-settings-about] [role="switch"]')).not.toBeNull();
  // The running release's link stays beside the one on offer.
  expect(el.querySelector('[data-about-whats-new="0.28.19"]')).not.toBeNull();

  act(() => {
    window.location.hash = '#whats-new=0.28.25';
  });
  await until(() => !!el.querySelector('[data-whats-new-page="0.28.25"]') && !!el.querySelector('.ib-wn-hero'), 'the offered release notes');
  await until(() => !!el.querySelector('[data-whats-new-update]'), "the page's Update button");

  expect(updateActions()).toEqual([]);
});

test.skipIf(!hasDom)("another allowed login over the tailnet: no What's new link and no update control, in the sidebar or in Settings → About", async () => {
  guest = true;
  const el = renderApp();
  await until(() => !!el.querySelector('.ib-listcol, [data-section-id], .pn-inbox'), 'the window');
  await settle();
  expect(el.querySelector('[data-whats-new-link]')).toBeNull();
  // The fixture really offers an update (a page on this computer would show the Update button), and this page shows none of it.
  expect(JSON.parse((await loopback('/api/inbox/threads')).text).update).toMatchObject({ state: 'available', version: '0.28.25' });
  expect(el.querySelector('.ib-upd')).toBeNull();
  expect(buttonsNamed(el, /Update/)).toEqual([]);
  act(() => {
    window.location.hash = '#settings/about';
  });
  await until(() => !!el.querySelector('[data-settings-about]'), 'Settings → About');
  await settle();
  expect(el.querySelector('[data-settings-about]')?.getAttribute('data-settings-about')).toBe('tailnet');
  expect(el.querySelector('[data-about-whats-new]')).toBeNull();
  expect(el.querySelector('[data-settings-about] [role="switch"]')).toBeNull();
  expect(buttonsNamed(el, /Check now|Update|What's new/)).toEqual([]);
  expect(el.querySelector('[data-about-update], [data-general-update], [data-general-check]')).toBeNull();
  expect(updateActions()).toEqual([]);
});
