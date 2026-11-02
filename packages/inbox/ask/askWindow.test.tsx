/**
 * Ask AI's window in the whole Inbox window (InboxApp) over a REAL Inbox in a
 * temp data dir, with a scripted agent on a live connection (its own process,
 * tests/helpers/inbox-ask-dom-server.ts). What is proved: with the setting off
 * nothing shows and nothing is read; the icon shows only for a thread that can
 * ask; a question gets its answer under the real agent's name and icon, and the
 * surface the agent gets comes from the thread; the dropdown's pick moves
 * `#thread=`; the box's words stay across a thread switch; Mod+Enter in the
 * window never sends the reply draft; Escape in it never closes the thread.
 *
 * The same in a real browser on the built Inbox: tests/e2e/inbox-ask-window.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../../../tests/helpers/no-browser';

setDefaultTimeout(30_000);

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('../App') : {}) as typeof import('../App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../../tests/helpers/inbox-ask-dom-server.ts');
/** The icon of the agent that owns the seeded threads, not the fallback an unknown host gets. */
const claudeMark = renderToStaticMarkup(<HostMark host="claude-code" />);

interface World {
  port: number;
  serverSession: string;
  project: string;
  first: string;
  second: string;
  mine: string;
  resolved: string;
  stop: () => Promise<void>;
}

const dirs: string[] = [];
let on: World;
let off: World;
let world: World;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
/** Every request the window made. */
let requests: { method: string; path: string; body: Record<string, unknown> }[] = [];

async function startWorld(setting: 'on' | 'off'): Promise<World> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `plannotator-inbox-ask-dom-${setting}-`)));
  dirs.push(dir);
  const child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), setting], {
    env: {
      ...process.env,
      DOM_TESTS: '0',
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      CODEX_HOME: join(dir, 'codex'),
      OPENCODE_CONFIG_DIR: join(dir, 'opencode'),
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      PLANNOTATOR_BROWSER: NO_BROWSER,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const started = JSON.parse(line.trim()) as Omit<World, 'stop'>;
  return {
    ...started,
    stop: async () => {
      child.kill();
      await child.exited;
    },
  };
}

function loopback(port: number, path: string, method: string, body?: string, signal?: AbortSignal | null): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    signal?.addEventListener('abort', () => req.destroy());
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  if (!hasDom) return;
  on = await startWorld('on');
  off = await startWorld('off');
});

afterAll(async () => {
  if (!hasDom) return;
  await on?.stop();
  await off?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  if (!hasDom) return;
  requests = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    requests.push({ method, path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const answer = await loopback(world.port, path, method, init?.body ? String(init.body) : undefined, init?.signal);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  window.location.hash = '';
  window.sessionStorage.clear();
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

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openInbox(target: World, threadId: string): Promise<HTMLElement> {
  world = target;
  window.location.hash = `#thread=${threadId}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-phead') !== null, 'the thread');
  return host;
}

const askButton = () => document.querySelector<HTMLButtonElement>('[data-ask-open]');
const askWindow = () => document.querySelector<HTMLElement>('[data-chat-window]');
const askBox = () => askWindow()?.querySelector('textarea') ?? null;

function type(field: HTMLTextAreaElement, words: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openChat() {
  await until(() => askButton() !== null, 'the icon');
  act(() => askButton()!.click());
  await until(() => askBox() !== null, 'the window');
}

function pressEnter(target: HTMLElement, mod = false) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: mod, ctrlKey: mod, bubbles: true, cancelable: true }));
  });
}

async function openMenu() {
  const chip = askWindow()!.querySelector<HTMLElement>('[data-ask-chip]')!;
  act(() => chip.click());
  await until(() => document.querySelector('[data-ask-menu] [data-ask-chat]') !== null, 'the dropdown');
}

test('a resolved thread has no icon; an open one does, and it opens and minimizes the window', async () => {
  if (!hasDom) return;
  await openInbox(on, on.resolved);
  await wait(300);
  expect(askButton()).toBeNull();
  act(() => {
    window.location.hash = `#thread=${on.first}`;
    window.dispatchEvent(new Event('hashchange'));
  });
  await until(() => askButton() !== null, 'the icon on an open thread');
  expect(askWindow()).toBeNull();
  await openChat();
  expect(askButton()!.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(askBox());
  // The window is outside the thread's section, which is what keeps its keys off the reply.
  expect(askWindow()!.closest('.ib-pane')).toBeNull();
  expect(askWindow()!.closest('.pn-inbox')).not.toBeNull();
  act(() => askWindow()!.querySelector<HTMLElement>('[aria-label="Close"]')!.click());
  expect(askWindow()).toBeNull();
  // The × minimizes: the thread's chat stays, and the icon gives it back.
  await openChat();
});

test('a question gets its answer, under the real agent name and icon', async () => {
  if (!hasDom) return;
  await openInbox(on, on.first);
  await openChat();
  const header = askWindow()!.querySelector('[data-ask-chip]')!;
  expect(header.textContent).toContain('Why did the retry fail?');
  expect(header.querySelector('.ib-mk')!.outerHTML).toBe(claudeMark);
  type(askBox()!, 'What ran out?');
  pressEnter(askBox()!);
  await until(() => askWindow()!.textContent!.includes('Answered: What ran out?'), 'the answer');
  expect(askBox()!.value).toBe('');
  const answer = askWindow()!.querySelector<HTMLElement>('[data-message-role="assistant"]')!;
  expect(answer.textContent).toContain('Claude Code');
  expect(answer.querySelector('.ib-mk')!.outerHTML).toBe(claudeMark);
  // Always names the provider; the surface is the server's, so the window never sends a thread's name.
  const session = requests.find((r) => r.path === '/api/ai/session')!;
  expect(typeof session.body.providerId).toBe('string');
  expect(String(session.body.providerId)).toContain('#');
  expect(JSON.stringify(session.body)).not.toContain('retry');
  expect(requests.some((r) => r.path === '/api/ai/abort' && r.body.reason === 'supersede')).toBe(false);
});

test('picking a chat moves to its thread, and its box keeps its own words', async () => {
  if (!hasDom) return;
  await openInbox(on, on.second);
  await openChat();
  type(askBox()!, 'Half a question about the deploy');
  await wait(20);
  await openMenu();
  await until(() => document.querySelector(`[data-ask-menu] [data-ask-chat="${on.first}"]`) !== null, 'the list of chats');
  const rows = [...document.querySelectorAll<HTMLElement>('[data-ask-menu] [data-ask-chat]')];
  expect(rows[0]!.getAttribute('data-ask-chat')).toBe(on.second);
  expect(rows[0]!.getAttribute('data-state')).toBe('current');
  // The chat from the last test, with its real agent, and no close control on any row.
  const other = rows.find((row) => row.getAttribute('data-ask-chat') === on.first)!;
  expect(other.textContent).toContain('Why did the retry fail?');
  expect(other.textContent).toContain('api');
  expect(other.querySelector('.ib-mk')!.outerHTML).toBe(claudeMark);
  expect(document.querySelectorAll('[data-ask-menu] button').length).toBe(0);
  act(() => other.click());
  await until(() => window.location.hash.includes(on.first), 'the route');
  await until(() => askWindow()?.textContent?.includes('Why did the retry fail?') === true, 'that chat');
  await until(() => askWindow()?.textContent?.includes('Answered: What ran out?') === true, 'its transcript');
  expect(askBox()!.value).toBe('');
  // Back to the first (it has no question yet, so no row): open as it was left, the words as they were.
  act(() => {
    window.location.hash = `#thread=${on.second}`;
    window.dispatchEvent(new Event('hashchange'));
  });
  await until(() => askBox()?.value === 'Half a question about the deploy', 'the words');
});

test('Mod+Enter from the window never sends the reply draft', async () => {
  if (!hasDom) return;
  await openInbox(on, on.mine);
  await until(() => askButton() !== null, 'the icon');
  // The Send the key looks for must count as on screen (happy-dom lays nothing out).
  const savedRects = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  try {
    const footButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('section.ib-pane .ib-pfoot button')].find((button) => button.textContent?.trim() === name);
    act(() => footButton('Reply')!.click());
    await until(() => document.querySelector('section.ib-pane textarea') !== null, 'the reply box');
    const replyBox = document.querySelector<HTMLTextAreaElement>('section.ib-pane textarea')!;
    type(replyBox, 'A reply that must stay a draft');
    await until(() => footButton('Send') !== undefined, 'the Send');
    await openChat();
    await wait(300);
    const sends = () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reply')).length;
    requests = [];
    for (const target of [askWindow()!.querySelector<HTMLElement>('[tabindex="0"]')!, askWindow()!.querySelector<HTMLElement>('[data-ask-chip]')!, askBox()!]) {
      act(() => target.focus());
      pressEnter(target, true);
      await wait(150);
      expect(sends()).toBe(0);
    }
    expect(replyBox.value).toBe('A reply that must stay a draft');
    // The same key from the thread does send: the checks above can fail.
    act(() => document.querySelector<HTMLElement>('section.ib-pane')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })));
    await until(() => sends() === 1, 'the Send from the thread');
  } finally {
    HTMLElement.prototype.getClientRects = savedRects;
  }
});

test('Escape from the window leaves the thread where it is', async () => {
  if (!hasDom) return;
  await openInbox(on, on.first);
  await openChat();
  const pane = askWindow()!.querySelector<HTMLElement>('[tabindex="0"]')!;
  act(() => {
    pane.focus();
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  });
  await wait(100);
  expect(window.location.hash).toContain(on.first);
  expect(document.querySelector('.ib-phead')).not.toBeNull();
  expect(askWindow()).not.toBeNull();
});

test('Stop works from a page that did not start the answer', async () => {
  if (!hasDom) return;
  await openInbox(on, on.second);
  await openChat();
  type(askBox()!, 'Answer this slowly');
  pressEnter(askBox()!);
  await until(() => askWindow()!.textContent!.includes('Connecting…'), 'the question to go out');
  // A reload: this page's stream and AI session are gone, the answer goes on at the Inbox.
  act(() => root?.unmount());
  host?.remove();
  await openInbox(on, on.second);
  await openChat();
  await until(() => askWindow()!.textContent!.includes('Answering…'), 'the read to say it runs');
  requests = [];
  act(() => askWindow()!.querySelector<HTMLElement>('[aria-label="Stop"]')!.click());
  await until(() => requests.some((r) => r.path.endsWith('/ask/stop')), 'the Stop');
  expect(requests.some((r) => r.path === '/api/ai/abort')).toBe(false);
  await until(() => askWindow()!.textContent!.includes('Stopped.'), 'the turn to say so');
  expect(askWindow()!.querySelector('[aria-label="Stop"]')).toBeNull();
});

// Last: the page keeps the first server session it saw, so another Inbox only works once this file is done posting.
test('with the setting off the window reads nothing about Ask AI and shows nothing', async () => {
  if (!hasDom) return;
  await openInbox(off, off.first);
  await wait(250);
  expect(askButton()).toBeNull();
  expect(askWindow()).toBeNull();
  expect(document.querySelector('[data-ask-layer]')).toBeNull();
  expect(requests.filter((r) => r.path.includes('/ask')).length).toBe(0);
});
