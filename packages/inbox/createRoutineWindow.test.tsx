/**
 * `/create-routine` in the window, over a REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts). Its requests carry the page's Origin, as a browser's do. What regresses:
 *
 * - the Routines switch not moving the "/" list: turned on in Settings in this window, the next "/" lists
 *   `create-routine` with the owner's line; turned off in another window (its `capabilities` event), it goes;
 * - the person's Send of `/create-routine` from the reply box not being what turns the agent's routine on: the
 *   agent's `routine create` naming that thread arrives on, and the person sees it on in the thread and in Routines.
 *
 * No routine here can run: the only one made runs once, in 2099.
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
import { CREATE_ROUTINE_SKILL } from '@plannotator/core/create-routine-skill';
import { resetSkillCatalogCache } from '@plannotator/ui/utils/skillCatalog';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
/** The window's event stream, fired by hand: `fire(name, json)`. */
let listeners = new Map<string, (event: MessageEvent<string>) => void>();
const fire = (name: string, data: unknown) => act(() => listeners.get(name)?.({ data: JSON.stringify(data), lastEventId: '' } as MessageEvent<string>));

/** A request as the window's page sends one: its Origin is this Inbox. */
function loopback(path: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const origin = `http://127.0.0.1:${port}`;
    // An agent's call passes `Origin: ''`: no Origin at all.
    const all = Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...(method === 'GET' ? {} : { Origin: origin }), ...headers }).filter(([, value]) => value !== ''));
    const req = request({ host: '127.0.0.1', port, path, method, headers: all }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

const TESTS = 2;
const SLOW = 30_000;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-create-routine-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  // One global skill, so the "/" list opens with Routines off too (an empty catalog opens no list).
  mkdirSync(join(dir, '.claude', 'skills', 'write-better'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 'write-better', 'SKILL.md'), '---\nname: write-better\ndescription: Improve prose.\n---\n\n# Write better\n');
  // This Bun by its own path: the PATH below has no `bun` on it.
  child = Bun.spawn([process.execPath, SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    // No agent CLI on PATH: the Inbox can start nothing.
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), PLANNOTATOR_TEST_SANDBOX: '1', HOME: dir, PATH: `${join(dir, 'bin')}:/usr/bin:/bin` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await readLine()) as { port: number; worlds: World[] };
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
  world = worlds.shift()!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  listeners = new Map();
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
      listeners.set(name, listener);
    }
    close() {}
  };
  window.location.hash = '';
  // The catalog is the page's, kept between renders: each test starts as a fresh page.
  resetSkillCatalogCache();
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  // Routines off again, as each test found them.
  await routines(false);
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function serverSession(): Promise<string> {
  return (JSON.parse((await loopback('/api/inbox/sessions')).text) as { serverSession: string }).serverSession;
}

/** Routines on or off, as another window's switch saves it. */
async function routines(on: boolean) {
  const saved = await loopback('/api/inbox/settings', 'POST', JSON.stringify({ serverSession: await serverSession(), scheduled_threads: { on } }));
  expect(saved.status).toBe(200);
}

/** The person's thread page, drawn fresh. */
async function renderApp(hash: string, ready: string) {
  act(() => root?.unmount());
  host?.remove();
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector(ready) !== null, ready);
  return host!;
}

async function go(hash: string, ready: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event('hashchange'));
  });
  await until(() => host!.querySelector(ready) !== null, ready);
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

const textarea = (el: ParentNode) => el.querySelector('textarea.ib-rtext') as HTMLTextAreaElement | null;

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

const menu = () => document.querySelector('[data-skill-menu]');
const rows = () => [...document.querySelectorAll('[data-skill-item]')].map((r) => r.getAttribute('data-skill-item'));

/** The reply box's "/" list, read once its menu is open. */
async function slashList(el: HTMLElement): Promise<(string | null)[]> {
  if (!textarea(el)) act(() => button(el, 'Reply').click());
  await until(() => textarea(el) !== null, 'the reply box');
  await type(textarea(el)!, '');
  await type(textarea(el)!, '/');
  await until(() => menu() !== null, 'the picker');
  // The catalog is read once per box; a moment for a re-read to land.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  const names = rows();
  await type(textarea(el)!, '');
  return names;
}

test.skipIf(!hasDom)(
  'the Routines switch moves the "/" list: on in Settings here, /create-routine is listed with its line; off in another window, it goes',
  async () => {
    const el = await renderApp(`#thread=${world.waiting}`, '[data-message-id]');
    expect(await slashList(el)).not.toContain('create-routine');

    // This window's own switch, in Settings → Capabilities. No event comes (the stream is fired by hand): the save itself moves the list.
    await go('#settings/capabilities', '[data-settings-scheduled]');
    const toggle = el.querySelector<HTMLButtonElement>('[data-settings-scheduled] button[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => toggle.click());
    await until(() => el.querySelector('[data-settings-scheduled] button[role="switch"]')?.getAttribute('aria-checked') === 'true', 'Routines on');
    await go(`#thread=${world.waiting}`, '[data-message-id]');
    expect(await slashList(el)).toContain('create-routine');
    await type(textarea(el)!, '/create-rou');
    await until(() => rows().join() === 'create-routine', 'the filtered picker');
    expect(document.querySelector('[data-skill-item="create-routine"]')!.textContent).toContain(CREATE_ROUTINE_SKILL.description);
    expect(CREATE_ROUTINE_SKILL.description).toBe('Describe the routine you want an agent to create in your Plannotator Inbox');
    await type(textarea(el)!, '');

    // Off in another window: its capabilities event moves this window's list.
    await routines(false);
    fire('capabilities', { scheduled_threads: { on: false } });
    expect(await slashList(el)).not.toContain('create-routine');
  },
  SLOW * 2,
);

test.skipIf(!hasDom)(
  "the person's /create-routine Send turns on the routine the agent makes in that thread: on in the thread and in Routines",
  async () => {
    await routines(true);
    const el = await renderApp(`#thread=${world.waiting}`, '[data-message-id]');
    // Turned on in another window: its capabilities event reaches this one.
    fire('capabilities', { scheduled_threads: { on: true } });
    act(() => button(el, 'Reply').click());
    await until(() => textarea(el) !== null, 'the reply box');
    await type(textarea(el)!, '/create-routine every weekday at 9, check this repo for outdated dependencies');
    await until(() => el.querySelector('[data-skill-ref-token="create-routine"]') !== null, 'the painted token');
    act(() => button(el, 'Send').click());
    await until(() => textarea(el) === null, 'the Send');
    // The Send reached the server with the built-in's block; the agent it answers is the one the person asked.
    type Stored = { id: string; reply_to?: string | null; author: { kind: string; session?: string }; body: string };
    let asked = '';
    await until(async () => {
      const thread = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: Stored[] } };
      const sent = thread.thread.messages.find((m) => m.author.kind === 'person' && m.body.includes('--- BEGIN SKILL INSTRUCTIONS: create-routine ---'));
      asked = thread.thread.messages.find((m) => m.id === sent?.reply_to)?.author.session ?? '';
      return asked !== '';
    }, 'the Send on the server');

    // That agent, through the Inbox's own MCP: `routine create` naming this thread (only the agent the person wrote to takes it).
    const call = await loopback(
      '/mcp',
      'POST',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'routine',
          arguments: {
            op: 'create',
            name: 'Dependency check',
            prompt: 'Check this repo for outdated dependencies.',
            schedule: { at: '2099-01-05T09:00', tz: 'America/New_York' },
            folder: { scratch: true },
            agent: 'claude-code',
            agent_host: 'claude-code',
            agent_session: asked,
            agent_name: 'Claude Code',
            thread_id: world.waiting,
          },
        },
      }),
      { accept: 'application/json, text/event-stream', Origin: '' },
    );
    const data = call.text.split('\n').find((line) => line.startsWith('data:'));
    const result = (JSON.parse(data ? data.slice(5) : call.text) as { result: { content: { text: string }[]; structuredContent: { scheduled: { id: string; enabled: boolean } } } }).result;
    expect(result.content[0]!.text).toContain(': on, ');
    const id = result.structuredContent.scheduled.id;

    // The thread the person asked in: the agent's line says it is on, and links to it.
    const thread = await renderApp(`#thread=${world.waiting}`, '[data-message-id]');
    await until(() => [...thread.querySelectorAll('[data-message-id]')].some((m) => m.textContent?.includes('It is on, as you asked with /create-routine.')), 'the on line');
    const line = [...thread.querySelectorAll('[data-message-id]')].find((m) => m.textContent?.includes('It is on, as you asked with /create-routine.'))!;
    expect(line.querySelector(`a[href="#routine=${id}"]`)).not.toBeNull();

    // Routines: its row is on, with a next run.
    const page = await renderApp('#routines', `[data-scheduled-row="${id}"]`);
    const row = page.querySelector(`[data-scheduled-row="${id}"]`)!;
    expect(row.getAttribute('data-state')).toBe('on');
    expect(row.querySelector('[data-scheduled-next]')?.textContent).not.toBe('Off');
    await loopback('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'routine', arguments: { op: 'delete', id, agent_host: 'claude-code' } } }), { accept: 'application/json, text/event-stream', Origin: '' });
  },
  SLOW * 2,
);
