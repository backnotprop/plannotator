/**
 * The art backgrounds in the Inbox (art.tsx, @plannotator/ui/art; the owner,
 * 2026-11-01: the Workspaces themes, the same in the Inbox). Mirrors the
 * Workspaces test of its PR 1178: the whole window (InboxApp) over a REAL
 * Inbox server in a temp data dir (tests/helpers/inbox-dom-server.ts), and
 * the layer is looked for where it must be, on the real panes.
 *
 * - None (the default) mounts no layer and leaves every pane's styles as they
 *   were, so a window nobody changed looks as it did.
 * - A pick in Settings → General → Appearance → Background mounts one layer
 *   on the Settings page at once, as the page's first child, under the
 *   content and out of the way of the pointer and of a screen reader; None
 *   takes it away and gives the page its own styles back.
 * - A stored pick draws behind the thread list and the open thread: one
 *   layer each, the first child of the list column and of the thread pane.
 * - Lofi's City row comes and goes with Lofi, and its pick is kept.
 *
 * happy-dom has no OffscreenCanvas, so no art worker starts and nothing is
 * drawn: the test is the mount, the choice and where it is kept (a cookie).
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
const { ART_CITY_COOKIE, ART_THEME_COOKIE, resetInboxArtForTests } = (hasDom ? await import('./art') : {}) as typeof import('./art');
const { storage } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let thread = '';
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

function forgetChoice() {
  storage.removeItem(ART_THEME_COOKIE);
  storage.removeItem(ART_CITY_COOKIE);
  resetInboxArtForTests();
}

beforeAll(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-art-dom-')));
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
  const first = JSON.parse(line.trim()) as { port: number; worlds: { stopped: string }[] };
  port = first.port;
  thread = first.worlds[0]!.stopped;
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
  forgetChoice();
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

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  forgetChoice();
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

async function go(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

const threadShown = (el: HTMLElement) => () =>
  el.querySelector(`.ib-listcol [data-thread-id="${thread}"]`) !== null && el.querySelector(`section.ib-pane[data-thread-id="${thread}"]`) !== null;
const layers = (el: Element) => [...el.querySelectorAll<HTMLCanvasElement>('canvas[data-art-layer]')];

/** The ground's art layer: its first child is the layer's host, and the host holds the one canvas. */
function layerOn(ground: HTMLElement | null, kind: 'scroll' | 'frame') {
  if (!ground) throw new Error('no ground');
  const first = ground.firstElementChild as HTMLElement | null;
  expect(first?.getAttribute('data-art-host')).toBe(kind);
  expect(first?.getAttribute('aria-hidden')).toBe('true');
  expect(first?.style.pointerEvents).toBe('none');
  // Under every child, inside the ground's own stacking context.
  expect(first?.style.zIndex).toBe('-10');
  expect(ground.style.isolation).toBe('isolate');
  const canvases = layers(ground);
  expect(canvases).toHaveLength(1);
  expect(canvases[0]!.parentElement).toBe(first);
  expect(canvases[0]!.getAttribute('aria-hidden')).toBe('true');
  expect(canvases[0]!.style.pointerEvents).toBe('none');
  return first!;
}

async function pickIn(el: HTMLElement, group: string, value: string) {
  await until(() => el.querySelector(`[${group}] input[value="${value}"]`) !== null, `the ${value} tile`);
  const radio = el.querySelector<HTMLInputElement>(`[${group}] input[value="${value}"]`)!;
  act(() => radio.click());
}

test.skipIf(!hasDom)('None, the default: no layer behind the list, the thread or Settings, and no pane restyled', async () => {
  const el = await renderApp(`#thread=${thread}`);
  await until(threadShown(el), 'the thread beside the list');
  expect(layers(el)).toHaveLength(0);
  expect(el.querySelector('[data-art-host]')).toBeNull();
  for (const pane of [el.querySelector<HTMLElement>('.ib-listcol'), el.querySelector<HTMLElement>('section.ib-pane')]) {
    expect(pane!.style.isolation).toBe('');
    expect(pane!.style.position).toBe('');
  }
  await go('#settings');
  await until(() => el.querySelector('[data-background-choices]') !== null, 'the Background row');
  expect(layers(el)).toHaveLength(0);
  // None is the chosen tile, first, and nothing is kept for it.
  const tiles = [...el.querySelectorAll<HTMLInputElement>('[data-background-choices] input')];
  expect(tiles.map((t) => t.value)).toEqual(['none', 'weather', 'drafting', 'plant', 'fortress', 'skifree', 'lofi']);
  expect(tiles[0]!.checked).toBe(true);
  expect(storage.getItem(ART_THEME_COOKIE)).toBeNull();
});

test.skipIf(!hasDom)('a pick in Settings shows behind the Settings page at once; None takes it away', async () => {
  const el = await renderApp('#settings');
  await until(() => el.querySelector('[data-background-choices]') !== null, 'the Background row');
  await pickIn(el, 'data-background-choices', 'plant');
  await until(() => layers(el).length === 1, 'the Settings layer');
  const page = el.querySelector<HTMLElement>('.ib-spage.ib-sframe');
  const hostEl = layerOn(page, 'scroll');
  expect(hostEl.style.position).toBe('sticky');
  expect(el.querySelector('[data-settings-background]')?.getAttribute('data-settings-background')).toBe('plant');
  expect(storage.getItem(ART_THEME_COOKIE)).toBe('plant');

  await pickIn(el, 'data-background-choices', 'none');
  await until(() => layers(el).length === 0, 'no layer');
  expect(el.querySelector('[data-art-host]')).toBeNull();
  expect(page!.style.isolation).toBe('');
  expect(storage.getItem(ART_THEME_COOKIE)).toBeNull();
});

test.skipIf(!hasDom)('a stored pick draws behind the thread list and the open thread, one layer each', async () => {
  storage.setItem(ART_THEME_COOKIE, 'fortress');
  resetInboxArtForTests();
  const el = await renderApp(`#thread=${thread}`);
  await until(threadShown(el), 'the thread beside the list');
  await until(() => layers(el).length === 2, 'two layers');
  const list = el.querySelector<HTMLElement>('.ib-listcol');
  const pane = el.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${thread}"]`);
  // Frames: the host covers the pane without taking room in its column, and the pane is positioned for it.
  for (const ground of [list, pane]) {
    const hostEl = layerOn(ground, 'frame');
    expect(hostEl.style.position).toBe('absolute');
    expect(getComputedStyle(ground!).position).toBe('relative');
  }
  // Closing the thread takes its layer with it; the list keeps its own.
  await go('#');
  await until(() => el.querySelector('section.ib-pane') === null, 'the thread closed');
  expect(layers(el)).toHaveLength(1);
  layerOn(el.querySelector<HTMLElement>('.ib-listcol'), 'frame');
});

test.skipIf(!hasDom)("Lofi's City row comes with Lofi, and its pick is kept", async () => {
  const el = await renderApp('#settings');
  await until(() => el.querySelector('[data-background-choices]') !== null, 'the Background row');
  expect(el.querySelector('[data-background-cities]')).toBeNull();
  await pickIn(el, 'data-background-choices', 'lofi');
  await until(() => el.querySelector('[data-background-cities]') !== null, 'the City row');
  expect([...el.querySelectorAll<HTMLInputElement>('[data-background-cities] input')].map((t) => t.value)).toEqual(['harbour', 'mountain', 'downtown']);
  await pickIn(el, 'data-background-cities', 'mountain');
  expect(storage.getItem(ART_CITY_COOKIE)).toBe('mountain');
  expect(el.querySelector('[data-settings-background-city]')?.getAttribute('data-settings-background-city')).toBe('mountain');
  await pickIn(el, 'data-background-choices', 'weather');
  await until(() => el.querySelector('[data-background-cities]') === null, 'the City row gone');
  // The city is kept for the next time Lofi is picked.
  expect(storage.getItem(ART_CITY_COOKIE)).toBe('mountain');
});
