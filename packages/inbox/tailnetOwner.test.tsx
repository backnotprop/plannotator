/**
 * The owner's phone over the tailnet works like the computer for an approved
 * list; a guest's window stays as it was (approval "inbox-tailnet-owner"). The
 * whole window over a real Inbox in a temp data dir, its own process
 * (tests/helpers/inbox-dom-server.ts). happy-dom cannot set the Host the
 * tailnet listener answers, so the answers that differ by caller are made
 * here, from what the table in packages/server/inbox-tailnet-owner.test.ts
 * proves of the real gate: `via` and `guest` on the settings model, and a 403
 * local_only for a guest on each route the approval opened.
 *
 * What regresses: the owner's page left as a stranger's (no update, no agents,
 * no switch), a guest's page offered a route that refuses it, a one-time dialog
 * showing on the phone now that the agents can be read there, a phone left
 * waiting in silence on a restart that did not come back.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxAgentRow, InboxAgentsModel } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type Page = 'local' | 'owner' | 'guest';
type Settings = Record<string, any>;

let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let page: Page = 'local';
let settingsOver: (settings: Settings) => void = () => {};
/** A test's own answer for a request; 'network' for a server that is gone. */
let intercept: ((path: string, method: string) => Response | 'network' | null) | null = null;
const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];

const CODEX: InboxAgentRow = {
  id: 'codex',
  label: 'Codex',
  detected: true,
  reach: { kind: 'mcp', on: true, state: 'connected', path: null, locked: false, reason: null },
  reminder: null,
  note: { agent: 'codex', path: '~/.codex/AGENTS.md', target: null, state: 'absent', create: false, created: false, reason: null },
} as InboxAgentRow;
const AGENTS: InboxAgentsModel = {
  agents: [CODEX],
  last_report: null,
  connecting: false,
  connect_env_off: true,
  tool_env: null,
  notes_offered: false,
  notes_asked: [],
  note_text: '<!-- plannotator-inbox:start v1 -->\n## Plannotator Inbox\n<!-- plannotator-inbox:end -->',
};
const UPDATE = { available: true, state: 'available', version: '9.9.9', current: '0.28.0', action: 'script', releaseUrl: '' };
const ready = { ...UPDATE, state: 'ready' };
let update: typeof UPDATE | null = null;

/** The routes the real gate refuses a guest and answers the owner (inbox-tailnet-owner.test.ts). */
const guestRefused = (path: string) => path.startsWith('/api/inbox/agents') || path.startsWith('/api/inbox/update') || path.startsWith('/api/inbox/cards/marks') || path.startsWith('/api/inbox/whats-new');

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string; type: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] ?? 'application/json') }));
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

const asPage = (settings: Settings) => {
  if (page !== 'local') settings.via = 'tailnet';
  settings.guest = page === 'guest';
  if (page === 'guest') {
    delete settings.cookie_host;
    settings.prompts = { ...settings.prompts, reminder: { ...settings.prompts.reminder, editable: false } };
    settings.voice = { ...settings.voice, on: false, guest: true };
  }
  settingsOver(settings);
  return settings;
};

beforeEach(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-tailnet-owner-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  port = (JSON.parse(await readLine()) as { port: number }).port;
  page = 'local';
  update = null;
  settingsOver = () => {};
  intercept = null;
  requests.length = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    let body = init?.body ? String(init.body) : undefined;
    let parsed: Record<string, unknown> = {};
    if (body?.startsWith('{')) {
      const { serverSession: _session, ...rest } = JSON.parse(body) as Record<string, unknown>;
      parsed = rest;
      body = JSON.stringify(rest);
    }
    requests.push({ path, method, body: parsed });
    const forced = intercept?.(path, method);
    if (forced === 'network') throw new TypeError('Failed to fetch');
    if (forced) return forced;
    if (page === 'guest' && guestRefused(path)) return Response.json({ error: 'This is only available on the computer.', code: 'local_only' }, { status: 403 });
    if (path.startsWith('/api/inbox/agents')) return Response.json(AGENTS);
    if (path.startsWith('/api/inbox/cards/marks')) return Response.json({ marks: {} });
    const answer = await loopback(path, method, body);
    if (method === 'GET' && path.startsWith('/api/inbox/settings') && answer.status === 200) return Response.json(asPage(JSON.parse(answer.text) as Settings));
    if (method === 'GET' && path.startsWith('/api/inbox/threads') && answer.status === 200) return Response.json({ ...(JSON.parse(answer.text) as Settings), update });
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': answer.type } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  window.location.hash = '';
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.location.hash = '';
  childOut?.releaseLock();
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await wait(50);
  }
  throw new Error(`never happened: ${what}`);
}

const $ = (el: ParentNode, selector: string) => el.querySelector<HTMLElement>(selector);

async function open(as: Page, hash = ''): Promise<HTMLElement> {
  page = as;
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => requests.some((r) => r.path.startsWith('/api/inbox/settings')) && requests.some((r) => r.path.startsWith('/api/inbox/threads')), 'the window reading the Inbox');
  await wait(100);
  return host;
}

const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
  });
};

/** Close this page: the next `open` is another device's. */
const leave = () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  requests.length = 0;
};

/** Booleans in the assertions: a failing `expect(element)` prints the whole DOM, gigabytes of it. */
const has = (el: ParentNode, selector: string) => $(el, selector) !== null;

test.skipIf(!hasDom)('updates: the owner gets the Update button, About’s action and the General row; a guest none of them', async () => {
  update = UPDATE;
  const owner = await open('owner');
  await until(() => has(owner, '.ib-upd[data-update-state="available"]'), 'the sidebar’s Update button');
  await go('#settings/general');
  await until(() => has(owner, '[data-general-update]'), 'the General row');
  await go('#settings/about');
  await until(() => has(owner, '[data-about-update]'), 'About’s Update now');
  leave();

  const guest = await open('guest');
  await wait(200);
  expect(has(guest, '.ib-upd')).toBe(false);
  await go('#settings/general');
  await until(() => has(guest, '[data-settings-section="general"]'), 'General');
  expect(has(guest, '[data-general-update]')).toBe(false);
  await go('#settings/about');
  await until(() => has(guest, '[data-settings-section="about"]'), 'About');
  await wait(150);
  expect(has(guest, '[data-about-update]')).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('Settings → Agents: the owner reads the agents; a guest sees no row of them', async () => {
  const owner = await open('owner', '#settings/agents');
  await until(() => has(owner, '[data-agent="codex"]'), 'the agent’s row');
  leave();

  const guest = await open('guest', '#settings/agents');
  await until(() => has(guest, '[data-settings-section="agents"]'), 'the section');
  await wait(200);
  expect(has(guest, '[data-agent]')).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('the Board off: the owner can turn it on, a guest gets the note', async () => {
  settingsOver = (settings) => {
    settings.board = { on: false };
  };
  const owner = await open('owner', '#board');
  await until(() => has(owner, '[data-board-view="off"]'), 'the off page');
  expect(has(owner, '[data-board-turn-on]')).toBe(true);
  leave();

  const guest = await open('guest', '#board');
  await until(() => has(guest, '[data-board-view="off"]'), 'the off page');
  expect(has(guest, '[data-board-turn-on]')).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('Voice’s key: the owner gets the form, a guest the note and no form', async () => {
  settingsOver = (settings) => {
    if (!settings.guest) settings.voice = { ...settings.voice, on: true, engine: 'api', computer: 'Studio', key: { source: null, last4: null } };
  };
  const owner = await open('owner', '#settings/voice');
  await until(() => has(owner, '[data-voice-key="empty"]'), 'the key form');
  expect(has(owner, 'input[type="password"]')).toBe(true);
  leave();

  const guest = await open('guest', '#settings/voice');
  await until(() => has(guest, '[data-settings-voice="guest"]'), 'the guest’s note');
  expect(has(guest, 'input[type="password"]')).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('a key saved: the owner can replace or remove it from the phone', async () => {
  settingsOver = (settings) => {
    settings.voice = { ...settings.voice, on: true, engine: 'api', computer: 'Studio', key: { source: 'saved', last4: 'abcd' } };
  };
  const owner = await open('owner', '#settings/voice');
  await until(() => has(owner, '[data-voice-key="saved"]'), 'the saved key');
  expect(has(owner, '[data-voice-key-replace]')).toBe(true);
  expect(has(owner, '[data-voice-key-remove]')).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('the browser address: the computer’s own page says this browser, the owner’s phone says whose, a guest has no row', async () => {
  const heading = (el: HTMLElement) => $(el, '[data-settings-cookie-host] h2')?.textContent;
  const local = await open('local', '#settings/general');
  await until(() => heading(local) !== undefined, 'the group');
  expect(heading(local)).toBe('This browser');
  leave();

  const owner = await open('owner', '#settings/general');
  await until(() => heading(owner) !== undefined, 'the group');
  expect(heading(owner)).toBe('The computer’s browser');
  leave();

  const guest = await open('guest', '#settings/general');
  await until(() => has(guest, '[data-settings-section="general"]'), 'General');
  await wait(150);
  expect(has(guest, '[data-settings-cookie-host]')).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('the one-time note dialog stays off over the tailnet, though the owner can read the agents; this computer still gets it', async () => {
  const dialog = () => document.querySelector('dialog[data-dialog="agent-note"]') !== null;
  await open('owner');
  await until(() => requests.some((r) => r.path.startsWith('/api/inbox/agents')), 'the agents read');
  await wait(3500);
  expect(dialog()).toBe(false);
  leave();

  await open('local');
  await until(dialog, 'the dialog on this computer');
}, 30_000);

test.skipIf(!hasDom)('Restart from the phone when the Inbox does not answer: the window stops waiting and says where to go; this computer’s page is as it was', async () => {
  update = ready;
  intercept = (path, method) => (path === '/api/inbox/restart' && method === 'POST' ? 'network' : null);
  const say = 'The Inbox hasn’t come back yet';
  const press = async (el: HTMLElement) => {
    await until(() => has(el, '.ib-upd[data-update-state="ready"] button'), 'the Update button, ready');
    await act(async () => $(el, '.ib-upd button')!.click());
    await until(() => requests.some((r) => r.path === '/api/inbox/restart'), 'the restart asked');
    await until(() => !has(el, '[data-update-state="restarting"]'), 'the window to stop waiting');
  };
  const owner = await open('owner');
  await press(owner);
  await until(() => (document.body.textContent ?? '').includes(say), 'the note');
  leave();

  const local = await open('local');
  await press(local);
  await wait(100);
  expect((document.body.textContent ?? '').includes(say)).toBe(false);
}, 30_000);
