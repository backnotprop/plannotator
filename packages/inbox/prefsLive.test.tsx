/**
 * `event: prefs`: a preference saved anywhere shows in an open window at once, with no reload.
 *
 * The whole window (InboxApp) over a REAL Inbox server in a temp data dir (tests/helpers/inbox-dom-server.ts), its
 * event stream the server's own (a stand-in EventSource reads /api/inbox/events over loopback). What it catches: the
 * finding this event fixes, that the theme, the text size and the diff layout saved in another window or by an agent
 * reached an open window only at its next load (the first-read adoption takes config.json once); a window that moves
 * without an event (it must be the event that moves it, not a poll); a save from Settings in another window, or an
 * agent's POST /api/inbox/prefs, not reaching this one.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { resetInboxTextSizeForTests, TEXT_SIZE_PROPERTY } = (hasDom ? await import('./textSize') : {}) as typeof import('./textSize');
const { resetInboxThemeForTests } = (hasDom ? await import('./theme') : {}) as typeof import('./theme');
const { resetInboxDiffOptionsForTests } = (hasDom ? await import('./diffOptions') : {}) as typeof import('./diffOptions');
const { configStore } = (hasDom ? await import('@plannotator/ui/config') : {}) as typeof import('@plannotator/ui/config');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let thread = '';
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
const streams = new Set<ClientRequest>();
/** Every frame name the window's stream has delivered. */
const heard: string[] = [];
/** The window's settings reads: how many began, the latest one answered, and how many had begun as each `prefs` frame arrived. */
let settingsReads = 0;
let lastAnsweredRead = 0;
const readsAtPrefsFrame: number[] = [];

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

/** An EventSource over the server's real stream: each named frame to its listeners, as a browser's would. */
class LoopbackEventSource {
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  private req: ClientRequest;
  constructor(url: string) {
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    this.req = request({ host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream', Host: `127.0.0.1:${port}` } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let name = 'message';
          let id = '';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
            else if (line.startsWith('id: ')) id = line.slice(4);
          }
          if (data.length === 0) continue;
          heard.push(name);
          if (name === 'prefs') readsAtPrefsFrame.push(settingsReads);
          const event = new MessageEvent(name, { data: data.join('\n'), lastEventId: id });
          for (const listener of this.listeners.get(name) ?? []) act(() => listener(event as MessageEvent<string>));
        }
      });
    });
    this.req.on('error', () => {});
    this.req.end();
    streams.add(this.req);
  }
  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.req.destroy();
    streams.delete(this.req);
  }
}

const configPath = () => join(dir!, 'data', 'config.json');
function writeOnDisk(change: Record<string, unknown>) {
  const current = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath(), JSON.stringify({ ...current, ...change }, null, 2));
}

beforeAll(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-prefs-live-dom-')));
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
  resetInboxTextSizeForTests();
  resetInboxThemeForTests();
  resetInboxDiffOptionsForTests();
  savedFetch = globalThis.fetch;
  settingsReads = 0;
  lastAnsweredRead = 0;
  readsAtPrefsFrame.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const read = (init?.method ?? 'GET') === 'GET' && String(input).includes('/api/inbox/settings?') ? ++settingsReads : 0;
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    if (read) lastAnsweredRead = Math.max(lastAnsweredRead, read);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = LoopbackEventSource;
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const stream of streams) stream.destroy();
  streams.clear();
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  resetInboxTextSizeForTests();
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

/** Until the `frames`th `prefs` frame has arrived and a settings read begun after it has answered, then one turn for the window to take it. */
async function readAfterFrame(frames: number, what: string) {
  await until(() => readsAtPrefsFrame.length >= frames && lastAnsweredRead > readsAtPrefsFrame[frames - 1]!, what);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const textSize = () => document.documentElement.style.getPropertyValue(TEXT_SIZE_PROPERTY);

test.skipIf(!hasDom)('a save from another window or an agent shows at once; a config.json change with no event does not', async () => {
  window.location.hash = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector(`[data-thread-id="${thread}"]`) !== null && heard.includes('hello') && lastAnsweredRead > 0, 'the list, the event stream and the first settings read');
  // Whatever this page started with (the theme follows the system until one is saved): each step moves away from it.
  const startSize = textSize();
  const startMode = configStore.get('themePair').mode;
  const otherMode = startMode === 'light' ? 'dark' : 'light';
  const otherStyle = configStore.get('diffStyle') === 'split' ? 'unified' : 'split';

  // config.json changed with no save through the Inbox (what a window saw before `event: prefs`), then a frame that
  // names another key: the window reads its settings again and still moves neither.
  writeOnDisk({ inboxTextSize: 12, theme: { mode: otherMode } });
  expect((await loopback('/api/inbox/prefs', 'POST', JSON.stringify({ set: { 'sound.volume': 40 } }))).status).toBe(200);
  await readAfterFrame(1, 'the settings read after the sound frame');
  expect(textSize()).toBe(startSize);
  expect(configStore.get('themePair').mode).toBe(startMode);

  // Another window saves the text size from Settings.
  expect((await loopback('/api/inbox/settings', 'POST', JSON.stringify({ text_size: 13 }))).status).toBe(200);
  await readAfterFrame(2, 'the settings read after the text size frame');
  expect(textSize()).toBe('13');

  // An agent sets the theme and the diff layout through the preference route.
  const agent = await loopback('/api/inbox/prefs', 'POST', JSON.stringify({ set: { 'appearance.theme': otherMode, 'diff.style': otherStyle, 'appearance.text_size': 15 } }));
  expect(agent.status).toBe(200);
  await readAfterFrame(3, 'the settings read after the agent’s frame');
  expect(configStore.get('themePair').mode).toBe(otherMode);
  expect(configStore.get('diffStyle')).toBe(otherStyle);
  expect(textSize()).toBe('15');
  expect(heard.filter((name) => name === 'prefs').length).toBe(3);
});
