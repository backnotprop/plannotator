import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { resetInboxThemeForTests } = (hasDom ? await import('./theme') : {}) as typeof import('./theme');
const { readThemePairCookies } = (hasDom ? await import('@plannotator/ui/config/settings') : {}) as typeof import('@plannotator/ui/config/settings');
const { configStore } = (hasDom ? await import('@plannotator/ui/config') : {}) as typeof import('@plannotator/ui/config');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type Theme = { mode?: 'light' | 'dark' | 'system'; light?: string; dark?: string };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let osLight = false;
let settingsGate: Promise<void> | null = null;

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

const configPath = () => join(dir!, 'data', 'config.json');

function themeOnDisk(): Theme | undefined {
  if (!existsSync(configPath())) return undefined;
  return (JSON.parse(readFileSync(configPath(), 'utf8')) as { theme?: Theme }).theme;
}

function writeThemeOnDisk(theme: Theme | undefined) {
  const current = existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>) : {};
  if (theme) current.theme = theme;
  else delete current.theme;
  writeFileSync(configPath(), JSON.stringify(current, null, 2));
}

function startPage(mode: 'light' | 'dark' | 'system') {
  resetInboxThemeForTests();
  configStore.init({ theme: { mode, light: 'plannotator', dark: 'plannotator' } });
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
  osLight = false;
  settingsGate = null;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    // The route without its query: the window reads `/api/inbox/settings?store=0`.
    if (path.split('?')[0] === '/api/inbox/settings' && method === 'GET' && settingsGate) await settingsGate;
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
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
    matches: query.includes('prefers-color-scheme: light') ? osLight : false,
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

async function reload(hash = '') {
  act(() => root?.unmount());
  host?.remove();
  return renderApp(hash);
}

const shownLight = () => document.documentElement.classList.contains('light');
const landingInstantly = () => document.documentElement.classList.contains('pn-theme-switching');
const toggle = (el: ParentNode) => el.querySelector('.ib-setrow .ib-theme-tg') as HTMLButtonElement;
const settingsRow = (el: ParentNode) => el.querySelector('.ib-setrow .ib-nav') as HTMLButtonElement;

test.skipIf(!hasDom)('a theme chosen in plan review (config.json) is the one the Inbox opens on', async () => {
  startPage('system');
  writeThemeOnDisk({ mode: 'light' });
  const el = await renderApp();
  await until(shownLight, 'the light theme from config.json');
  expect(toggle(el).getAttribute('aria-label')).toBe('Switch to dark mode');
});

test.skipIf(!hasDom)('the toggle flips light and dark, keeps the choice across a reload and never opens Settings; the row does', async () => {
  startPage('dark');
  writeThemeOnDisk(undefined);
  const el = await renderApp();
  expect(shownLight()).toBe(false);
  expect(toggle(el).getAttribute('aria-label')).toBe('Switch to light mode');

  act(() => toggle(el).click());
  expect(shownLight()).toBe(true);
  expect(landingInstantly()).toBe(true);
  await until(() => !landingInstantly(), 'the instant-switch hold to go');
  expect(toggle(el).getAttribute('aria-label')).toBe('Switch to dark mode');
  expect(window.location.hash).toBe('');
  expect(el.querySelector('[aria-label="Settings"]')).toBeNull();
  expect(readThemePairCookies()?.mode).toBe('light');
  await until(() => themeOnDisk()?.mode === 'light', 'config.json to say light');

  const again = await reload();
  expect(shownLight()).toBe(true);
  act(() => toggle(again).click());
  expect(shownLight()).toBe(false);
  expect(window.location.hash).toBe('');
  await until(() => themeOnDisk()?.mode === 'dark', 'config.json to say dark');

  act(() => settingsRow(again).click());
  await until(() => window.location.hash === '#settings', 'the Settings page');
  expect(again.querySelector('[aria-label="Settings"]')).not.toBeNull();
});

test.skipIf(!hasDom)("Settings' Match system goes back to following this computer", async () => {
  startPage('dark');
  writeThemeOnDisk({ mode: 'dark' });
  osLight = true;
  const el = await renderApp('#settings');
  await until(() => el.querySelector('[data-settings-theme="dark"]') !== null, 'the Appearance block on Dark');
  expect(shownLight()).toBe(false);

  const system = [...el.querySelectorAll<HTMLInputElement>('[data-settings-theme] input[type="radio"]')].find((r) => r.value === 'system')!;
  act(() => system.click());
  expect(shownLight()).toBe(true);
  expect(landingInstantly()).toBe(true);
  expect(el.querySelector('[data-settings-theme]')?.getAttribute('data-settings-theme')).toBe('system');
  expect(readThemePairCookies()?.mode).toBe('system');
  await until(() => themeOnDisk()?.mode === 'system', 'config.json to say system');
});

test.skipIf(!hasDom)('a tab opened before a palette changed in plan review flips the mode only, never writing its old palettes back', async () => {
  startPage('dark');
  writeThemeOnDisk({ mode: 'dark', light: 'plannotator', dark: 'plannotator' });
  const el = await renderApp();
  await settle();
  expect(shownLight()).toBe(false);
  writeThemeOnDisk({ mode: 'dark', light: 'adwaita', dark: 'tokyo-night' });

  act(() => toggle(el).click());
  expect(shownLight()).toBe(true);
  await until(() => themeOnDisk()?.mode === 'light', 'config.json to say light');
  expect(themeOnDisk()).toEqual({ mode: 'light', light: 'adwaita', dark: 'tokyo-night' });
});

test.skipIf(!hasDom)('a click before the first settings read wins over config.json', async () => {
  startPage('light');
  writeThemeOnDisk({ mode: 'light', light: 'adwaita', dark: 'tokyo-night' });
  let release = () => {};
  settingsGate = new Promise<void>((done) => (release = done));
  const el = await renderApp();
  expect(shownLight()).toBe(true);

  act(() => toggle(el).click());
  expect(shownLight()).toBe(false);
  release();
  await settle();
  expect(shownLight()).toBe(false);
  await until(() => themeOnDisk()?.mode === 'dark', 'config.json to say dark');
  expect(themeOnDisk()).toEqual({ mode: 'dark', light: 'adwaita', dark: 'tokyo-night' });
  expect(shownLight()).toBe(false);
});
