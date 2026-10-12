/**
 * Light and dark in the Inbox (owner's request, 2026-10-12): a toggle at the
 * far right of the sidebar's Settings row flips what is shown, the rest of the
 * row still opens Settings, and Settings' Theme row goes back to matching the
 * system. The whole window (InboxApp) over a REAL Inbox server in a temp data
 * dir (tests/helpers/inbox-dom-server.ts), so the choice is proved where it is
 * kept: the `plannotator-theme` cookie and config.json `theme`, the value plan
 * review reads.
 *
 * The root's mode is the `light` class on <html> (ThemeProvider's
 * applyThemeClasses); dark is its absence.
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

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { readThemePairCookies } = (hasDom ? await import('@plannotator/ui/config/settings') : {}) as typeof import('@plannotator/ui/config/settings');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
/** What this computer prefers, as the stubbed `matchMedia` answers it. */
let osLight = false;
let reducedMotion = false;

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

/** config.json `theme`, as the Inbox serves it (the file plan review reads). */
async function savedTheme(): Promise<Record<string, unknown> | null> {
  return (JSON.parse((await loopback('/api/inbox/settings')).text) as { theme: Record<string, unknown> | null }).theme;
}

beforeAll(async () => {
  if (!hasDom) return;
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-theme-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
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
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query.includes('prefers-color-scheme: light') ? osLight : query.includes('prefers-reduced-motion: reduce') ? reducedMotion : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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
  window.matchMedia = savedMatchMedia;
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

/** A reload: the window torn down and drawn again from what was kept. */
async function reload(hash = '') {
  act(() => root?.unmount());
  host?.remove();
  return renderApp(hash);
}

const shownLight = () => document.documentElement.classList.contains('light');
const toggle = (el: ParentNode) => el.querySelector('.ib-setrow .ib-theme-tg') as HTMLButtonElement;
const settingsRow = (el: ParentNode) => el.querySelector('.ib-setrow .ib-nav') as HTMLButtonElement;

// First, before anything in this page chose: config.json is read once, on the first settings read.
test.skipIf(!hasDom)('a theme chosen in plan review (config.json) is the one the Inbox opens on', async () => {
  osLight = false;
  await loopback('/api/inbox/settings', 'POST', JSON.stringify({ theme: { mode: 'light' } }));
  const el = await renderApp();
  await until(shownLight, 'the light theme from config.json');
  expect(toggle(el).getAttribute('aria-label')).toBe('Switch to dark mode');
});

test.skipIf(!hasDom)('the toggle flips light and dark, keeps the choice across a reload and never opens Settings; the row does', async () => {
  osLight = false;
  reducedMotion = true;
  const el = await renderApp();
  // From the previous test: light. One click to dark.
  expect(shownLight()).toBe(true);
  act(() => toggle(el).click());
  expect(shownLight()).toBe(false);
  // Under reduced motion the switch lands without the colour crossfade.
  expect(document.documentElement.classList.contains('ib-theme-instant')).toBe(true);
  expect(toggle(el).getAttribute('aria-label')).toBe('Switch to light mode');
  expect(window.location.hash).toBe('');
  expect(el.querySelector('[aria-label="Settings"]')).toBeNull();

  act(() => toggle(el).click());
  expect(shownLight()).toBe(true);
  expect(window.location.hash).toBe('');
  // Kept where plan review reads it: the cookie at once, config.json after the store's write-back.
  expect(readThemePairCookies()?.mode).toBe('light');
  await until(async () => (await savedTheme())?.mode === 'light', 'config.json to say light');

  const again = await reload();
  await settle();
  expect(shownLight()).toBe(true);
  expect(toggle(again).getAttribute('aria-label')).toBe('Switch to dark mode');

  act(() => settingsRow(again).click());
  await until(() => window.location.hash === '#settings', 'the Settings page');
  expect(again.querySelector('[aria-label="Settings"]')).not.toBeNull();
  reducedMotion = false;
});

test.skipIf(!hasDom)("Settings' Match system goes back to following this computer", async () => {
  osLight = true;
  const el = await renderApp('#settings');
  await until(() => el.querySelector('[data-settings-theme]') !== null, 'the Appearance block');
  // An explicit dark, from the toggle.
  if (shownLight()) act(() => toggle(el).click());
  expect(shownLight()).toBe(false);
  expect(el.querySelector('[data-settings-theme]')?.getAttribute('data-settings-theme')).toBe('dark');

  const system = [...el.querySelectorAll<HTMLInputElement>('[data-settings-theme] input[type="radio"]')].find((r) => r.value === 'system')!;
  act(() => system.click());
  // This computer prefers light, so light it is, and the choice is "system", not light.
  expect(shownLight()).toBe(true);
  expect(el.querySelector('[data-settings-theme]')?.getAttribute('data-settings-theme')).toBe('system');
  expect(readThemePairCookies()?.mode).toBe('system');
  await until(async () => (await savedTheme())?.mode === 'system', 'config.json to say system');
});
