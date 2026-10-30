/**
 * Palettes in the Inbox (owner's request, 2026-10-24: "we need to support
 * multiple themes within plannotator inbox"): Settings → General → Appearance
 * → Colors picks the light-half and dark-half palettes, plan review's Theme
 * tab choices. The whole window (InboxApp) over a REAL Inbox server in a temp
 * data dir (tests/helpers/inbox-dom-server.ts), so a pick is proved where it
 * is kept: the `plannotator-theme` cookie and config.json `theme`, and that
 * only the half the person changed is posted (a tab's other half can be
 * stale).
 *
 * The harness is themeToggle.test.tsx's.
 *
 * Every test sets its own start: the cookie and the store (configStore.init,
 * which never writes to the server), config.json on disk (the server reads it
 * on every request), the OS preference, and the Inbox's once-per-page
 * adoption of config.json (resetInboxThemeForTests). No test depends on
 * another's end state.
 *
 * The root's mode is the `light` class on <html> (ThemeProvider's
 * applyThemeClasses); dark is its absence.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
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
/** What this computer prefers, as the stubbed `matchMedia` answers it. */
let osLight = false;
/** Whether the window is a phone, as the stubbed `matchMedia` answers PHONE_QUERY. */
let phone = false;
/** While set, the window's settings read waits for it (a page whose first read has not answered yet). */
let settingsGate: Promise<void> | null = null;
/** Every POST /api/inbox/settings body the window sent. */
let posted: Record<string, unknown>[] = [];

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

/** config.json `theme` on disk, the value plan review reads. */
function themeOnDisk(): Theme | undefined {
  if (!existsSync(configPath())) return undefined;
  return (JSON.parse(readFileSync(configPath(), 'utf8')) as { theme?: Theme }).theme;
}

/** Put config.json `theme` on disk as another Plannotator window would, keeping the file's other keys. */
function writeThemeOnDisk(theme: Theme | undefined) {
  const current = existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>) : {};
  if (theme) current.theme = theme;
  else delete current.theme;
  writeFileSync(configPath(), JSON.stringify(current, null, 2));
}

/**
 * The page's own start: the cookie and the store say `mode` with the default
 * palettes (written through init, which never posts to the server), and the
 * Inbox has not read its settings yet.
 */
function startPage(mode: 'light' | 'dark' | 'system', light = 'plannotator', dark = 'plannotator') {
  resetInboxThemeForTests();
  configStore.init({ theme: { mode, light, dark } });
}

beforeAll(async () => {
  if (!hasDom) return;
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-palette-dom-')));
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
  phone = false;
  settingsGate = null;
  posted = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path === '/api/inbox/settings' && method === 'GET' && settingsGate) await settingsGate;
    if (path === '/api/inbox/settings' && method === 'POST' && init?.body) posted.push(JSON.parse(String(init.body)));
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
    matches: query.includes('max-width: 767px') ? phone : query.includes('prefers-color-scheme: light') ? osLight : false,
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
const shownPalette = () => [...document.documentElement.classList].find((c) => c.startsWith('theme-'))?.slice('theme-'.length);
const tile = (el: ParentNode, id: string) => el.querySelector(`.ib-pals [data-palette="${id}"] input`) as HTMLInputElement | null;
const half = (el: ParentNode, id: 'light' | 'dark') => el.querySelector(`[data-settings-palettes] [role="tab"][data-half="${id}"]`) as HTMLButtonElement;
const tileList = (el: ParentNode) => el.querySelector('.ib-pals') as HTMLElement;
const checkedTile = (el: ParentNode) => (el.querySelector('.ib-pals input:checked') as HTMLInputElement | null)?.value;
function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}
const themePosts = () => posted.filter((body) => 'theme' in body).map((body) => body.theme);

async function openColors(hash = '#settings') {
  const el = await renderApp(hash);
  await until(() => el.querySelector('[data-settings-palettes]') !== null, 'the Colors row');
  return el;
}

test.skipIf(!hasDom)('picking a dark palette applies at once, posts only the dark half, and a reload keeps it', async () => {
  startPage('dark');
  // config.json holds a light palette this tab never heard of (picked in plan review after it loaded).
  writeThemeOnDisk({ mode: 'dark', light: 'plannotator', dark: 'plannotator' });
  const el = await openColors();
  writeThemeOnDisk({ mode: 'dark', light: 'adwaita', dark: 'plannotator' });
  // The half follows the mode on screen.
  expect(el.querySelector('[data-settings-palettes]')?.getAttribute('data-settings-palettes')).toBe('dark');
  expect(tile(el, 'plannotator')?.checked).toBe(true);
  // Dark-only palettes are offered on the dark half.
  expect(tile(el, 'dracula')).not.toBeNull();

  act(() => tile(el, 'tokyo-night')!.click());
  expect(shownPalette()).toBe('tokyo-night');
  expect(shownLight()).toBe(false);
  expect(tile(el, 'tokyo-night')!.checked).toBe(true);
  expect(el.querySelector('[data-palette-summary]')?.textContent).toContain('Dark: Tokyo Night');
  expect(readThemePairCookies()?.dark).toBe('tokyo-night');

  await until(() => themeOnDisk()?.dark === 'tokyo-night', 'config.json to say tokyo-night');
  // Only the half the person changed went to the server; the light palette from plan review stands.
  expect(themePosts()).toEqual([{ dark: 'tokyo-night' }]);
  expect(themeOnDisk()).toEqual({ mode: 'dark', light: 'adwaita', dark: 'tokyo-night' });

  // A fresh page: it adopts config.json again on its first settings read.
  resetInboxThemeForTests();
  const again = await reload('#settings');
  await until(() => again.querySelector('[data-palette-summary]')?.textContent?.includes('Light: Adwaita') === true, 'the Colors row after a reload');
  expect(shownPalette()).toBe('tokyo-night');
  expect(tile(again, 'tokyo-night')?.checked).toBe(true);
});

test.skipIf(!hasDom)("plan review's cookie is what the Inbox shows; switching to the light half and picking posts only that half", async () => {
  // As plan review left it: the cookie (and the store) hold the pair, config.json has nothing yet.
  startPage('dark', 'adwaita', 'catppuccin');
  writeThemeOnDisk(undefined);
  const el = await openColors();
  expect(shownPalette()).toBe('catppuccin');
  expect(el.querySelector('[data-palette-summary]')?.textContent).toContain('Light: Adwaita · Dark: Catppuccin');

  act(() => half(el, 'light').click());
  expect(el.querySelector('[data-settings-palettes]')?.getAttribute('data-settings-palettes')).toBe('light');
  expect(tile(el, 'adwaita')?.checked).toBe(true);
  // A dark-only palette cannot draw the light half, so it is not offered there.
  expect(tile(el, 'dracula')).toBeNull();
  // Assigning the light half while dark is on screen changes nothing on screen.
  act(() => tile(el, 'tokyo-night')!.click());
  expect(shownPalette()).toBe('catppuccin');
  expect(readThemePairCookies()).toMatchObject({ mode: 'dark', light: 'tokyo-night', dark: 'catppuccin' });
  await until(() => themeOnDisk()?.light === 'tokyo-night', 'config.json to say tokyo-night');
  expect(themePosts()).toEqual([{ light: 'tokyo-night' }]);
  expect(themeOnDisk()).toEqual({ light: 'tokyo-night' });

  // Then the mode, from the Theme row: only the mode goes.
  posted = [];
  const lightMode = [...el.querySelectorAll<HTMLInputElement>('[data-settings-theme] input[name="ib-theme"]')].find((r) => r.value === 'light')!;
  act(() => lightMode.click());
  expect(shownLight()).toBe(true);
  expect(shownPalette()).toBe('tokyo-night');
  await until(() => themeOnDisk()?.mode === 'light', 'config.json to say light');
  expect(themePosts()).toEqual([{ mode: 'light' }]);
  expect(themeOnDisk()).toEqual({ light: 'tokyo-night', mode: 'light' });
});

test.skipIf(!hasDom)('a palette picked in plan review (config.json) is the one the Inbox opens on', async () => {
  startPage('light');
  writeThemeOnDisk({ mode: 'light', light: 'catppuccin', dark: 'plannotator' });
  const el = await openColors();
  await until(() => shownPalette() === 'catppuccin', 'the catppuccin palette from config.json');
  expect(tile(el, 'catppuccin')?.checked).toBe(true);
  expect(themePosts()).toEqual([]);
});

test.skipIf(!hasDom)("a phone's list of sections says the mode and, once one is picked, the palette on screen", async () => {
  phone = true;
  startPage('dark');
  writeThemeOnDisk(undefined);
  const el = await renderApp('#settings');
  const general = () => el.querySelector('[data-settings-link="general"] .ib-v')?.textContent;
  await until(() => general() === 'Dark', 'the General row to say Dark');
  act(() => configStore.set('themePair', { mode: 'dark', light: 'plannotator', dark: 'tokyo-night' }));
  await until(() => general() === 'Dark · Tokyo Night', 'the General row to name the palette');
});

test.skipIf(!hasDom)('the controls have names of their own: Colors, Light half / Dark half, and the palettes of the half shown', async () => {
  startPage('dark');
  writeThemeOnDisk(undefined);
  const el = await openColors();
  const tabs = el.querySelector('[data-settings-palettes] [role="tablist"]')!;
  expect(tabs.getAttribute('aria-labelledby')).toBe('ib-colors-label');
  expect(el.querySelector('#ib-colors-label')?.textContent).toBe('Colors');
  expect(half(el, 'light').getAttribute('aria-label')).toBe('Light half');
  expect(half(el, 'dark').getAttribute('aria-label')).toBe('Dark half');
  expect(half(el, 'dark').getAttribute('aria-selected')).toBe('true');
  expect(half(el, 'light').getAttribute('aria-selected')).toBe('false');
  // One tab stop, and each tab controls the tile list.
  expect(half(el, 'dark').tabIndex).toBe(0);
  expect(half(el, 'light').tabIndex).toBe(-1);
  const list = tileList(el);
  expect(half(el, 'light').getAttribute('aria-controls')).toBe(list.id);
  expect(half(el, 'dark').getAttribute('aria-controls')).toBe(list.id);
  expect(list.getAttribute('role')).toBe('radiogroup');
  expect(list.getAttribute('aria-label')).toBe('Palettes for the dark half');
  act(() => half(el, 'light').click());
  expect(tileList(el).getAttribute('aria-label')).toBe('Palettes for the light half');

  // No two named controls on the Appearance card share a name (the Theme row's own Light / Dark included).
  const card = el.querySelector('[data-settings-theme] .ib-card')!;
  const nameOf = (node: Element) => {
    const label = node.getAttribute('aria-label');
    if (label) return label;
    const by = node.getAttribute('aria-labelledby');
    if (by) return by.split(' ').map((id) => el.querySelector(`#${id}`)?.textContent ?? '').join(' ');
    return (node.closest('label')?.textContent ?? node.textContent ?? '').trim();
  };
  const named = [...card.querySelectorAll('[role="radiogroup"], [role="tablist"], [role="tab"], input[name="ib-theme"]')].map(nameOf);
  expect(new Set(named).size).toBe(named.length);
});

test.skipIf(!hasDom)('the arrows move between the halves and between the tiles, each step a pick', async () => {
  startPage('dark');
  writeThemeOnDisk(undefined);
  const el = await openColors();
  // The tabs: Right / Left / Home / End select and focus.
  press(half(el, 'dark'), 'ArrowRight');
  expect(half(el, 'light').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(half(el, 'light'));
  expect(tileList(el).getAttribute('data-palette-half')).toBe('light');
  press(half(el, 'light'), 'End');
  expect(half(el, 'dark').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(half(el, 'dark'));

  // The tiles, in the list's order.
  const ids = [...tileList(el).querySelectorAll<HTMLInputElement>('input')].map((input) => input.value);
  expect(checkedTile(el)).toBe('plannotator');
  const start = ids.indexOf('plannotator');
  press(tile(el, 'plannotator')!, 'ArrowDown');
  expect(checkedTile(el)).toBe(ids[start + 1]);
  expect(document.activeElement).toBe(tile(el, ids[start + 1]!));
  expect(shownPalette()).toBe(ids[start + 1]);
  press(tile(el, ids[start + 1]!)!, 'ArrowLeft');
  expect(checkedTile(el)).toBe('plannotator');
  press(tile(el, 'plannotator')!, 'End');
  expect(checkedTile(el)).toBe(ids[ids.length - 1]);
  // Past the end it wraps to the first, as native radios do.
  press(tile(el, ids[ids.length - 1]!)!, 'ArrowRight');
  expect(checkedTile(el)).toBe(ids[0]);
  press(tile(el, ids[0]!)!, 'Home');
  expect(checkedTile(el)).toBe(ids[0]);
  // A chord is not a step.
  act(() => {
    tile(el, ids[0]!)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true, bubbles: true, cancelable: true }));
  });
  expect(checkedTile(el)).toBe(ids[0]);
  await until(() => themeOnDisk()?.dark === ids[0], 'config.json to hold the last pick');
});

test.skipIf(!hasDom)('the tile box scrolls to the chosen tile, never the page', async () => {
  startPage('dark');
  writeThemeOnDisk(undefined);
  const el = await openColors();
  const list = tileList(el);
  // happy-dom lays nothing out: give the box and its tiles a desktop's geometry (a 120 px box, 40 px a tile).
  let scrollTop = 0;
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 120 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 40 * list.children.length });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
  const proto = HTMLElement.prototype;
  const savedTop = Object.getOwnPropertyDescriptor(proto, 'offsetTop')!;
  const savedHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')!;
  const indexIn = (node: HTMLElement) => [...(node.parentElement?.children ?? [])].indexOf(node);
  Object.defineProperty(proto, 'offsetTop', { configurable: true, get(this: HTMLElement) { return this.classList.contains('ib-pal') ? indexIn(this) * 40 : savedTop.get!.call(this); } });
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('ib-pal') ? 38 : savedHeight.get!.call(this); } });
  try {
    const ids = [...list.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value);
    const far = ids[ids.length - 1]!;
    act(() => tile(el, far)!.click());
    const top = (ids.length - 1) * 40;
    // The chosen tile is inside the box's view, centred where it can be.
    expect(scrollTop).toBeGreaterThan(0);
    expect(top).toBeGreaterThanOrEqual(scrollTop);
    expect(top + 38).toBeLessThanOrEqual(scrollTop + 120);
    // A tile already in view moves nothing.
    const before = scrollTop;
    act(() => tile(el, ids[ids.length - 2]!)!.click());
    expect(scrollTop).toBe(before);
    // Back to the first: the box goes to its top.
    act(() => tile(el, ids[0]!)!.click());
    expect(scrollTop).toBe(0);
  } finally {
    Object.defineProperty(proto, 'offsetTop', savedTop);
    Object.defineProperty(proto, 'offsetHeight', savedHeight);
  }
});

test.skipIf(!hasDom)('two picks within the 300 ms debounce are one POST of that half', async () => {
  startPage('dark');
  writeThemeOnDisk({ mode: 'dark', light: 'adwaita', dark: 'plannotator' });
  const el = await openColors();
  await until(() => el.querySelector('[data-palette-summary]')?.textContent?.includes('Light: Adwaita') === true, 'config.json adopted');
  posted = [];
  act(() => tile(el, 'tokyo-night')!.click());
  act(() => tile(el, 'catppuccin')!.click());
  await until(() => themeOnDisk()?.dark === 'catppuccin', 'config.json to say catppuccin');
  await settle();
  expect(themePosts()).toEqual([{ dark: 'catppuccin' }]);
  expect(themeOnDisk()).toEqual({ mode: 'dark', light: 'adwaita', dark: 'catppuccin' });
});

test.skipIf(!hasDom)('a light pick and a mode change within 300 ms are one POST of { light, mode }', async () => {
  startPage('dark');
  writeThemeOnDisk({ mode: 'dark', light: 'plannotator', dark: 'catppuccin' });
  const el = await openColors();
  await until(() => shownPalette() === 'catppuccin', 'config.json adopted');
  posted = [];
  act(() => half(el, 'light').click());
  act(() => tile(el, 'tokyo-night')!.click());
  const lightMode = [...el.querySelectorAll<HTMLInputElement>('[data-settings-theme] input[name="ib-theme"]')].find((r) => r.value === 'light')!;
  act(() => lightMode.click());
  expect(shownLight()).toBe(true);
  expect(shownPalette()).toBe('tokyo-night');
  await until(() => themeOnDisk()?.mode === 'light', 'config.json to say light');
  await settle();
  expect(themePosts()).toEqual([{ light: 'tokyo-night', mode: 'light' }]);
  // The dark half the page never touched stays as config.json had it.
  expect(themeOnDisk()).toEqual({ mode: 'light', light: 'tokyo-night', dark: 'catppuccin' });
});

test.skipIf(!hasDom)("a mode flipped before the first settings read keeps the flip and still takes config.json's palettes", async () => {
  // The page's cookie says light with the default palettes; config.json has palettes picked in plan review.
  startPage('light');
  writeThemeOnDisk({ mode: 'light', light: 'catppuccin', dark: 'tokyo-night' });
  let release = () => {};
  settingsGate = new Promise<void>((done) => (release = done));
  const el = await renderApp();
  expect(shownLight()).toBe(true);
  expect(shownPalette()).toBe('plannotator');
  const toggle = el.querySelector('.ib-setrow .ib-theme-tg') as HTMLButtonElement;
  act(() => toggle.click());
  expect(shownLight()).toBe(false);
  // The read answers now: the mode the person chose stands, and both halves come from config.json.
  release();
  await until(() => shownPalette() === 'tokyo-night', "config.json's dark palette");
  expect(shownLight()).toBe(false);
  expect(readThemePairCookies()).toMatchObject({ mode: 'dark', light: 'catppuccin', dark: 'tokyo-night' });
  // The flip still reaches config.json, alone: the read did not swallow the queued write.
  await until(() => themeOnDisk()?.mode === 'dark', 'config.json to say dark');
  await settle();
  expect(themePosts()).toEqual([{ mode: 'dark' }]);
  expect(themeOnDisk()).toEqual({ mode: 'dark', light: 'catppuccin', dark: 'tokyo-night' });
});
