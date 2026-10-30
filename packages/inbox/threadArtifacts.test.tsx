/**
 * A thread's Artifacts view (approval "inbox-thread-artifacts", variant
 * Swap), as the whole window draws it over a REAL Inbox server in a temp data
 * dir (its own process, tests/helpers/inbox-dom-server.ts with its
 * `artifacts` seed: an image in the text that is also attached, a Markdown
 * file, the person's pasted sketch, another image in the text with a ZIP, a
 * guided review, a SQL file). What this catches: the button missing, showing
 * on a thread with nothing, or counting something other than the grid; the
 * view not swapping (or leaving the messages and the foot on screen); the
 * order; a tile opening something other than what its message tile opens;
 * Escape not returning (or not with focus on the button); and the phone's
 * screen of its own.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PHONE_QUERY } from './phone';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string; artifacts: { thread: string; ids: Record<string, string>; guide: string } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let phone = false;

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

const TESTS = 6;
// Each test reads a real Inbox in another process; a cold start can take a few seconds.
setDefaultTimeout(20_000);

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-artifacts-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'artifacts'], {
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
  const started = JSON.parse(line.trim()) as { port: number; worlds: World[] };
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
  ids = worlds.shift()!;
  phone = false;
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
    matches: query === PHONE_QUERY ? phone : false,
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
  document.body.innerHTML = '';
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

const button = (el: ParentNode) => el.querySelector<HTMLButtonElement>('[data-artifacts-button]');
const view = (el: ParentNode) => el.querySelector<HTMLElement>('[data-artifacts-view]');
const tiles = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>('[data-artifacts-view] [data-artifact-tile]')];
const tileNames = (el: ParentNode) => tiles(el).map((t) => (t.getAttribute('aria-label') ?? '').replace(/^Download /, '').split(',')[0]);
const messagesBody = (el: ParentNode) => el.querySelector<HTMLElement>('section.ib-pane > .ib-pbody:not(.ib-artbody)')!;
const press = (key: string, target: EventTarget) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

async function openThread() {
  const el = await renderApp(`#thread=${ids.artifacts.thread}`);
  await until(() => button(el) !== null, 'the Artifacts button');
  return el;
}

test.skipIf(!hasDom)('the header: an Artifacts button with the count, icons at the right, Mark read keeping its label; none on a thread with nothing', async () => {
  const el = await openThread();
  const b = button(el)!;
  // Seven artifacts: the image in the text (also attached: one), the spec, the sketch, the after image, the ZIP, the guide, the SQL.
  expect(b.getAttribute('aria-label')).toBe('Artifacts, 7');
  expect(b.getAttribute('aria-pressed')).toBe('false');
  expect(b.hasAttribute('title')).toBe(false);
  expect(b.textContent).toBe('7');
  const expand = el.querySelector<HTMLButtonElement>('[data-expand-all]')!;
  expect(expand.textContent).toBe('');
  expect(expand.getAttribute('aria-label')).toMatch(/^(Expand all messages|Fold the earlier messages)$/);
  const head = el.querySelector('section.ib-pane .ib-phead')!;
  const order = [...head.querySelectorAll('[data-artifacts-button], [data-expand-all], [data-archive], .ib-vsep, [aria-label="Close the thread"]')].map((n) =>
    n.hasAttribute('data-artifacts-button') ? 'artifacts' : n.hasAttribute('data-expand-all') ? 'expand' : n.hasAttribute('data-archive') ? 'archive' : n.classList.contains('ib-vsep') ? '|' : 'close',
  );
  expect(order).toEqual(['artifacts', 'expand', 'archive', '|', 'close']);
  // A thread with no artifact has no button.
  act(() => root?.unmount());
  host?.remove();
  const plain = await renderApp(`#thread=${ids.waiting}`);
  await until(() => plain.querySelector('section.ib-pane [data-archive]') !== null, 'the plain thread');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  expect(button(plain)).toBeNull();
});

test.skipIf(!hasDom)('the button swaps the messages for the grid, newest first; the address carries it; focus moves to the heading', async () => {
  const el = await openThread();
  act(() => button(el)!.click());
  await until(() => tiles(el).length === 7, 'the grid');
  expect(window.location.hash).toBe(`#thread=${ids.artifacts.thread}&artifacts`);
  expect(button(el)!.getAttribute('aria-pressed')).toBe('true');
  expect(messagesBody(el).hidden).toBe(true);
  expect(el.querySelector<HTMLElement>('section.ib-pane > .ib-pfoot')!.hidden).toBe(true);
  expect(document.activeElement).toBe(view(el)!.querySelector('h2'));
  expect(el.querySelector('[data-artifacts-summary]')!.textContent).toBe('7 from 5 messages · newest first');
  const guideTitle = 'Guided review: Token refresh';
  expect(tileNames(el)).toEqual(['flow.sql', guideTitle, 'after.png', 'traces.zip', 'sketch.png', 'before.png', 'spec.md']);
  // The tile's words: who sent it, "in text", a download.
  const after = tiles(el)[2]!;
  expect(after.getAttribute('aria-label')).toMatch(/^after\.png, PNG image, 1 × 1, .+, from Claude Code at .+, shown in the message text$/);
  expect(after.textContent).toContain('in text');
  expect(tiles(el)[3]!.tagName).toBe('A');
  expect(tiles(el)[3]!.getAttribute('aria-label')).toMatch(/^Download traces\.zip, /);
  expect(tiles(el)[4]!.getAttribute('aria-label')).toMatch(/^sketch\.png, .+, from you at /);
});

test.skipIf(!hasDom)('a tile opens the viewer beside the grid with its tile ringed; the image attached and in the text opens as one', async () => {
  const el = await renderApp(`#thread=${ids.artifacts.thread}&artifacts`);
  await until(() => tiles(el).length === 7, 'the grid');
  const spec = tiles(el).find((t) => t.getAttribute('aria-label')?.startsWith('spec.md'))!;
  act(() => spec.click());
  await until(() => el.ownerDocument.querySelector('[data-attachment-pane]') !== null, 'the file');
  expect(window.location.hash).toContain('&artifacts&file=');
  expect(window.location.hash).toContain(`file=${ids.artifacts.ids['spec.md']}`);
  // The grid stays, its tile ringed.
  expect(tiles(el)).toHaveLength(7);
  await until(() => tiles(el).find((t) => t.getAttribute('aria-label')?.startsWith('spec.md'))!.getAttribute('aria-current') === 'true', 'the ringed tile');
  // The image's attached record opens the same artifact as the one in the text: its tile is ringed, one step.
  window.location.hash = `#thread=${ids.artifacts.thread}&artifacts&file=${ids.artifacts.ids['before.png (attached)']}`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await until(() => tiles(el).find((t) => t.getAttribute('aria-label')?.startsWith('before.png'))!.getAttribute('aria-current') === 'true', 'the image ringed');
  const label = el.ownerDocument.querySelector('[data-step-label]')?.getAttribute('aria-label') ?? el.ownerDocument.querySelector('[data-full-view-position]')?.getAttribute('aria-label') ?? '';
  // Six files step (the guide opens its own reader): the image is the first.
  expect(label).toMatch(/^1 of 6, before\.png\./);
});

test.skipIf(!hasDom)('Escape, the pressed button and Back to the thread return to the messages, with focus on the button', async () => {
  const el = await openThread();
  act(() => button(el)!.click());
  await until(() => tiles(el).length === 7, 'the grid');
  // The thread's j / k / n stand down while the grid stands in for the messages.
  const heading = view(el)!.querySelector('h2')!;
  for (const key of ['j', 'k', 'n']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(document.activeElement).toBe(heading);
  press('Escape', heading);
  await until(() => view(el) === null, 'the messages back');
  expect(window.location.hash).toBe(`#thread=${ids.artifacts.thread}`);
  expect(messagesBody(el).hidden).toBe(false);
  expect(document.activeElement).toBe(button(el));
  act(() => button(el)!.click());
  await until(() => view(el) !== null, 'the grid again');
  act(() => button(el)!.click());
  await until(() => view(el) === null, 'the pressed button returns');
  act(() => button(el)!.click());
  await until(() => view(el) !== null, 'the grid a third time');
  act(() => el.querySelector<HTMLButtonElement>('[data-artifacts-back]')!.click());
  await until(() => view(el) === null, 'Back to the thread');
  expect(document.activeElement).toBe(button(el));
  // With the grid gone, Escape closes the thread as before.
  press('Escape', document.body);
  await until(() => el.querySelector('section.ib-pane') === null, 'the thread closed');
});

test.skipIf(!hasDom)("a guided review opens its reader and the reader's Back returns to the grid; a link to an empty thread's grid says so", async () => {
  const el = await renderApp(`#thread=${ids.artifacts.thread}&artifacts`);
  await until(() => tiles(el).length === 7, 'the grid');
  act(() => tiles(el)[1]!.click());
  expect(window.location.hash).toBe(`#thread=${ids.artifacts.thread}&artifacts&guide=${ids.artifacts.guide}`);
  press('Escape', document.body);
  await until(() => window.location.hash === `#thread=${ids.artifacts.thread}&artifacts`, 'back to the grid');
  window.location.hash = `#thread=${ids.waiting}&artifacts`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await until(() => el.querySelector('[data-artifacts-empty]') !== null, 'the empty grid');
  expect(el.querySelector('[data-artifacts-empty]')!.textContent).toContain('No artifacts in this thread yet');
});

test.skipIf(!hasDom)('a phone: a screen of its own with its way back to the thread; no ⋯ on tiles', async () => {
  phone = true;
  const el = await openThread();
  act(() => button(el)!.click());
  await until(() => tiles(el).length === 7, 'the grid');
  const back = el.querySelector<HTMLButtonElement>('[data-artifacts-phone-back]')!;
  expect(back.getAttribute('aria-label')).toBe('Back to the thread');
  expect(back.textContent).toContain('Thread');
  // The header is the screen's: no Mark read, no Archive, no other back.
  expect(el.querySelector('section.ib-pane [data-mark-read]')).toBeNull();
  expect(el.querySelector('section.ib-pane [data-archive]')).toBeNull();
  expect(el.querySelector('[data-artifacts-back]')).toBeNull();
  expect(el.querySelector('[data-artifacts-view] [data-open-in-more]')).toBeNull();
  act(() => back.click());
  await until(() => view(el) === null, 'the thread');
  expect(window.location.hash).toBe(`#thread=${ids.artifacts.thread}`);
});
