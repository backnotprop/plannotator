/**
 * Attachments in the message header (design record
 * "inbox-attachments-header", variant Count, approved 2026-10-11), as the
 * window draws it over a REAL Inbox server in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts with its `header-files` seed).
 * The failure this catches: a long message whose files the reader never
 * learns about, a count that disagrees with the tiles (or says "changed"
 * when nothing changed), a band that stays open or traps Escape, and a file
 * opened from the header going somewhere other than where its tile goes.
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

/** The real Inbox, in its own process: happy-dom's Response cannot be served from this one. */
const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type Files = { thread: string; first: string; middle: string; last: string; ids: Record<string, string> };
type World = { project: string; waiting: string; filed: string; attachment: string; files: Files };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

/** One request to the real Inbox over loopback (happy-dom's own fetch would resolve against its page). */
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

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-hatts-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'header-files'], {
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
});

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

/** Act until `check` holds (the window's reads go to another process), or fail after 5 s. */
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
  await settle();
  return host;
}

const article = (el: ParentNode, messageId: string) => el.querySelector<HTMLElement>(`[data-message-article="${messageId}"]`)!;
const countOf = (el: ParentNode, messageId: string) => el.querySelector<HTMLButtonElement>(`[data-header-files="${messageId}"]`);
const bandOf = (el: ParentNode, messageId: string) => el.querySelector<HTMLElement>(`[data-header-band="${messageId}"]`);
const words = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const press = (key: string, target: EventTarget) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

/** The first message open (a later visit folds what was already looked at), its attachments' states read (the changed count needs them). */
async function firstOpen(el: HTMLElement) {
  await until(() => el.querySelector(`[data-message-article="${ids.files.first}"]`) !== null, 'the thread');
  const first = article(el, ids.files.first);
  if (first.hasAttribute('data-folded')) act(() => first.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  await until(() => words(countOf(el, ids.files.first)).includes('1 changed'), 'the changed count');
}

async function openThread() {
  const el = await renderApp(`#thread=${ids.files.thread}`);
  await firstOpen(el);
  return el;
}

test.skipIf(!hasDom)('an agent message with files says so in its "to you" line, with the changed count; a message without files does not', async () => {
  const el = await openThread();
  const first = countOf(el, ids.files.first)!;
  // The quiet count, beside "to you": 3 attachments · 1 changed (plan.html was edited after it was sent).
  expect(first.closest('.ib-fl-meta')?.textContent).toContain('to you');
  expect(words(first).replace(/\s*·\s*/g, ' · ')).toBe('3 attachments · 1 changed');
  expect(first.getAttribute('aria-label')).toBe('3 attachments, 1 changed');
  // A disclosure that starts closed, naming the band it opens.
  expect(first.getAttribute('aria-expanded')).toBe('false');
  const band = el.querySelector(`#${CSS.escape(first.getAttribute('aria-controls')!)}`) as HTMLElement;
  expect(band).toBe(bandOf(el, ids.files.first)!);
  expect(band.hidden).toBe(true);
  expect(band.querySelectorAll('[data-attachment-id]')).toHaveLength(0);
  // A short message with one unchanged file: the count, no "changed".
  expect(words(countOf(el, ids.files.last))).toBe('1 attachment');
  expect(countOf(el, ids.files.last)!.getAttribute('aria-label')).toBe('1 attachment');
  // The message with no files keeps its header as it was.
  expect(countOf(el, ids.files.middle)).toBeNull();
  expect(article(el, ids.files.middle).querySelector('.ib-fl-meta .ib-hcount')).toBeNull();
  // The foot tiles are there as always.
  expect(article(el, ids.files.first).querySelectorAll('.ib-attachments:not(.ib-hatts-tiles) [data-attachment-id]')).toHaveLength(3);
});

test.skipIf(!hasDom)('a thread whose messages carry no files has no count; a one-message thread shows it in the sender line itself', async () => {
  const plain = await renderApp(`#thread=${ids.waiting}`);
  await until(() => plain.querySelector('[data-open-head]') !== null, 'the thread');
  expect(plain.querySelector('[data-header-files]')).toBeNull();
  expect(plain.querySelector('[data-header-band]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  const el = await renderApp(`#thread=${ids.filed}`);
  await until(() => countOf(el, ids.filed) !== null, 'the count');
  // One message: no fold button, the count sits in the plain sender line.
  expect(el.querySelector('[data-fold-head]')).toBeNull();
  expect(words(countOf(el, ids.filed))).toBe('1 attachment');
});

test.skipIf(!hasDom)('the count opens the same tiles in a band under the sender; Escape closes it from the count or a tile, focus back on the count, the thread stays open', async () => {
  const el = await openThread();
  const count = countOf(el, ids.files.first)!;
  act(() => count.click());
  const band = bandOf(el, ids.files.first)!;
  expect(count.getAttribute('aria-expanded')).toBe('true');
  expect(band.hidden).toBe(false);
  expect(band.getAttribute('role')).toBe('region');
  // The same tiles as the foot, in the same order, with the same changed line; no second heading, the note under them.
  const headerTiles = [...band.querySelectorAll('[data-attachment-id]')].map((t) => t.getAttribute('data-attachment-name'));
  const footTiles = [...article(el, ids.files.first).querySelectorAll('.ib-attachments:not(.ib-hatts-tiles) [data-attachment-id]')].map((t) => t.getAttribute('data-attachment-name'));
  expect(headerTiles).toEqual(['spec.md', 'plan.html', 'run.sh']);
  expect(headerTiles).toEqual(footTiles);
  expect(words(band.querySelector('[data-attachment-name="plan.html"]'))).toContain('Changed since it was sent');
  expect(band.querySelector('.ib-attach-h')).toBeNull();
  expect(words(band)).toContain('Also at the end of the message.');
  // Detail ids stay unique with both sets on the page.
  const described = [...el.querySelectorAll('[aria-describedby]')].map((t) => t.getAttribute('aria-describedby'));
  expect(new Set(described).size).toBe(described.length);
  // The band sits above the message body, under the sender row.
  const msg = article(el, ids.files.first).querySelector('.ib-msg')!;
  expect(msg.firstElementChild).toBe(band);

  // Escape from a tile in the band closes it and puts focus on the count.
  const tile = band.querySelector<HTMLButtonElement>('[data-attachment-name="spec.md"]')!;
  tile.focus();
  press('Escape', tile);
  expect(count.getAttribute('aria-expanded')).toBe('false');
  expect(band.hidden).toBe(true);
  expect(document.activeElement).toBe(count);
  await settle();
  expect(window.location.hash).toContain(`thread=${ids.files.thread}`);

  // Escape on the count itself closes it too; a click closes it again as well.
  act(() => count.click());
  expect(band.hidden).toBe(false);
  press('Escape', count);
  expect(band.hidden).toBe(true);
  await settle();
  expect(window.location.hash).toContain(`thread=${ids.files.thread}`);
  act(() => count.click());
  act(() => count.click());
  expect(count.getAttribute('aria-expanded')).toBe('false');
  // Closed, Escape is the window's again: the thread closes.
  press('Escape', count);
  await until(() => !window.location.hash.includes('thread='), 'the thread closed');
});

test.skipIf(!hasDom)('a file opened from the header opens beside the thread exactly as its tile at the foot does', async () => {
  const el = await openThread();
  const specId = ids.files.ids['spec.md']!;
  act(() => countOf(el, ids.files.first)!.click());
  act(() => bandOf(el, ids.files.first)!.querySelector<HTMLButtonElement>(`[data-attachment-id="${specId}"]`)!.click());
  await until(() => el.querySelector(`[data-attachment-pane="${specId}"]`) !== null, 'the file beside the thread');
  const fromHeader = window.location.hash;
  expect(fromHeader).toContain(`file=${specId}`);
  // Focus goes into the pane, as from a tile.
  await until(() => el.querySelector(`[data-attachment-pane="${specId}"]`)!.contains(document.activeElement), 'focus in the pane');
  // The band stays open; its tile and the foot's both say "Open beside".
  expect(bandOf(el, ids.files.first)!.hidden).toBe(false);
  const current = [...el.querySelectorAll(`[data-attachment-id="${specId}"][aria-current="true"]`)];
  expect(current).toHaveLength(2);
  // Stepping order is the thread's, whichever tile opened it: spec, plan, run, listing.
  expect(words(el.querySelector('[data-attachment-pane]'))).toContain('1 of 4');

  // The same file from the foot lands on the same route.
  act(() => root?.unmount());
  host?.remove();
  const again = await openThread();
  act(() => article(again, ids.files.first).querySelector<HTMLButtonElement>(`.ib-attachments:not(.ib-hatts-tiles) [data-attachment-id="${specId}"]`)!.click());
  await until(() => again.querySelector(`[data-attachment-pane="${specId}"]`) !== null, 'the file from the foot');
  expect(window.location.hash).toBe(fromHeader);
});

test.skipIf(!hasDom)('folding: the fold button still folds the message; a folded line keeps its paperclip; the band starts closed when it opens again', async () => {
  const el = await openThread();
  const count = countOf(el, ids.files.first)!;
  act(() => count.click());
  expect(bandOf(el, ids.files.first)!.hidden).toBe(false);
  // The fold button lies under the sender; the count is not inside it (no button in a button).
  const head = article(el, ids.files.first).querySelector<HTMLButtonElement>('[data-fold-head]')!;
  expect(head.contains(count)).toBe(false);
  expect(head.getAttribute('aria-label')).toContain('Fold this message');
  act(() => head.click());
  await settle();
  expect(article(el, ids.files.first).hasAttribute('data-folded')).toBe(true);
  expect(countOf(el, ids.files.first)).toBeNull();
  expect(bandOf(el, ids.files.first)).toBeNull();
  expect(words(article(el, ids.files.first).querySelector('[data-fold-head]'))).toContain('3');
  act(() => article(el, ids.files.first).querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  await settle();
  expect(countOf(el, ids.files.first)!.getAttribute('aria-expanded')).toBe('false');
  expect(bandOf(el, ids.files.first)!.hidden).toBe(true);
});

test.skipIf(!hasDom)('nothing is remembered: after another thread, the band starts closed again', async () => {
  const el = await openThread();
  act(() => countOf(el, ids.files.first)!.click());
  expect(bandOf(el, ids.files.first)!.hidden).toBe(false);
  // Another thread in the same window, then back (the thread pane stays mounted across threads).
  act(() => {
    window.location.hash = `#thread=${ids.filed}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => countOf(el, ids.filed) !== null, 'the other thread');
  act(() => {
    window.location.hash = `#thread=${ids.files.thread}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await firstOpen(el);
  expect(countOf(el, ids.files.first)!.getAttribute('aria-expanded')).toBe('false');
  expect(bandOf(el, ids.files.first)!.hidden).toBe(true);
});
