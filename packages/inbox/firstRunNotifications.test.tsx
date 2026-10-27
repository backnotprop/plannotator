/**
 * The first question can notify (the onboarding audit, finding 3; owner
 * approval 2026-10-24). Before this, the notifications ask was drawn only
 * above the list, never on the first-run screen, and a load that showed the
 * agent-note dialog hid it for the rest of the load, which is the load the
 * first message usually lands on: the person was never offered notifications
 * until they reloaded. Now:
 * - the first-run screen offers it under "Try it";
 * - it never shows while the note dialog is open (two one-time surfaces never stack);
 * - after the dialog closes it shows on the same load, on the first-run
 *   screen and, once the first message lands, above the list;
 * - dismissed and off still hide it, and Turn on asks the browser once.
 *
 * The whole window over a REAL Inbox in a temp data dir, one per test (its
 * own process, tests/helpers/inbox-dom-server.ts `first-run`: no project
 * yet). The agents this computer has are a canned model (the Inbox's scratch
 * agent environment finds none), so the note dialog has someone to ask about.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxAgentRow, InboxAgentsModel } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedNotification: unknown;
let pokeStream: (() => void) | null = null;
/** What the browser answers for this origin, and how often it was asked. */
let permission: NotificationPermission = 'default';
let asked = 0;
/** The agents this computer has, as GET /api/inbox/agents answers. */
let agentsModel: InboxAgentsModel;
/** Changes to what GET /api/inbox/settings answers: a page opened over the tailnet, a sound dialog due. */
let settingsOver: (settings: Record<string, any>) => void = () => {};
/** The sound dialog's claim answers yes (the one page that shows it). */
let soundShows = false;
/** The page came through the tailnet (settings `via`). */
let tailnetPage = false;
const posts: { path: string; body: Record<string, unknown> }[] = [];

const NOTE = '<!-- plannotator-inbox:start v1 -->\n## Plannotator Inbox\n<!-- plannotator-inbox:end -->';
const CODEX: InboxAgentRow = {
  id: 'codex',
  label: 'Codex',
  detected: true,
  reach: { kind: 'mcp', on: true, state: 'connected', path: null, locked: false, reason: null },
  reminder: null,
  note: { agent: 'codex', path: '~/.codex/AGENTS.md', target: null, state: 'absent', create: false, created: false, reason: null },
} as InboxAgentRow;
const model = (over: Partial<InboxAgentsModel> = {}): InboxAgentsModel => ({
  agents: [CODEX],
  last_report: null,
  connecting: false,
  connect_env_off: true,
  tool_env: null,
  notes_offered: false,
  notes_asked: [],
  note_text: NOTE,
  ...over,
});

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

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

/** An agent's first message: its folder becomes the Inbox's first project. */
async function firstMessage(body: string): Promise<string> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ first: { root: join(dir!, 'projects', 'billing'), session: 'ses_first', body } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

beforeEach(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-first-run-notify-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'first-run'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  port = (JSON.parse(await readLine()) as { port: number }).port;

  permission = 'default';
  asked = 0;
  settingsOver = () => {};
  soundShows = false;
  tailnetPage = false;
  agentsModel = model();
  posts.length = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    // One Inbox per test (the first message ends a first run for good), while the window module
    // keeps the first server session it saw: the stale-tab guard is not what these tests are about.
    let body = init?.body ? String(init.body) : undefined;
    if (body?.startsWith('{')) {
      const { serverSession: _session, ...rest } = JSON.parse(body) as Record<string, unknown>;
      body = JSON.stringify(rest);
    }
    if (method === 'POST') posts.push({ path, body: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
    // This computer's agents: a canned model (the note dialog's candidates), and its answer.
    if (path.startsWith('/api/inbox/agents/notes')) {
      agentsModel = { ...agentsModel, notes_offered: true, notes_asked: ['codex'] };
      return Response.json({ ...agentsModel, results: [] });
    }
    // Over the tailnet the agents are local only, as the real listener answers.
    if (path.startsWith('/api/inbox/agents') && tailnetPage) return Response.json({ error: 'local only', code: 'local_only' }, { status: 403 });
    if (path.startsWith('/api/inbox/agents')) return Response.json(agentsModel);
    if (path.startsWith('/api/inbox/sound/dialog')) {
      const settings = JSON.parse((await loopback('/api/inbox/settings')).text) as { sound: unknown };
      return Response.json({ show: soundShows, sound: settings.sound });
    }
    const answer = await loopback(path, method, body);
    if (method === 'GET' && path.startsWith('/api/inbox/settings') && answer.status === 200) {
      const settings = JSON.parse(answer.text) as Record<string, any>;
      settingsOver(settings);
      return Response.json(settings);
    }
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') pokeStream = () => listener({ data: '' } as MessageEvent<string>);
    }
    close() {}
  };
  savedNotification = (window as unknown as Record<string, unknown>).Notification;
  (window as unknown as Record<string, unknown>).Notification = class {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      asked += 1;
      permission = 'granted';
      return permission;
    }
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
  pokeStream = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  // Put back "none" as none: a property set to undefined reads as support (see tour.test.tsx).
  if (savedNotification === undefined) delete (window as unknown as Record<string, unknown>).Notification;
  else (window as unknown as Record<string, unknown>).Notification = savedNotification;
  setUrl('about:blank');
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
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('[data-inbox-empty]:not([aria-busy])') !== null, 'the first-run screen');
  return host;
}

/** happy-dom's page address (about:blank by default, whose origin is "null"). */
function setUrl(url: string) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

const firstRunAsk = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-first-run-ask] [data-notification-ask]');
const listAsk = (el: HTMLElement) => el.querySelector<HTMLElement>('.ib-listcol [data-notification-ask]:not([data-first-run-ask] *)');
const noteDialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="agent-note"]');
const buttonIn = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

test.skipIf(!hasDom)('the note dialog first, never with the ask; after it closes the ask shows on the same load, on the first-run screen and above the list', async () => {
  const el = await renderApp();
  // Not before the note dialog is decided (the agents settle after a second read, about 2.5 s): the
  // dialog would open over a line the person may be pressing, and Turn on would stack the browser's
  // prompt on it. Checked on every tick until the dialog opens.
  let askBeforeDialog = false;
  await until(() => {
    if (firstRunAsk(el) !== null) askBeforeDialog = true;
    return noteDialog() !== null;
  }, 'the agent-note dialog');
  expect(askBeforeDialog).toBe(false);
  // Two one-time surfaces never stack: no ask while the dialog is open.
  expect(firstRunAsk(el)).toBeNull();

  await act(async () => document.querySelector<HTMLButtonElement>('[data-anote-notnow]')!.click());
  await until(() => noteDialog() === null, 'the dialog closing');
  await until(() => firstRunAsk(el) !== null, 'the first-run ask after the dialog');
  const ask = firstRunAsk(el)!;
  expect(ask.getAttribute('data-notification-ask')).toBe('ask');
  // It sits in Try it, under the prompt to copy: the moment before the first question.
  expect(ask.closest('.ib-try')).not.toBeNull();
  expect(ask.textContent).toContain('Get a desktop notice when the first question arrives.');
  expect(buttonIn(ask, 'Turn on')).toBeDefined();
  expect(buttonIn(ask, 'Not now')).toBeDefined();
  // No native titles: hover text is a component tooltip.
  expect(ask.querySelector('[title]')).toBeNull();

  // The first message lands on the same load: the list replaces the first-run screen, and the ask comes along.
  await firstMessage('Hello from Claude Code.');
  pokeStream?.();
  await until(() => el.querySelector('.ib-lbody [data-thread-id]') !== null, 'the list with the first thread');
  expect(el.querySelector('[data-inbox-empty]')).toBeNull();
  await until(() => listAsk(el) !== null, 'the ask above the list');
  expect(listAsk(el)!.getAttribute('data-notification-ask')).toBe('ask');
  expect(listAsk(el)!.textContent).toContain('Get a desktop notice when an agent needs you.');
  expect(noteDialog()).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('with nobody to ask about, the ask is on the first-run screen at once; Turn on asks the browser once and the line goes', async () => {
  agentsModel = model({ notes_asked: ['codex'], notes_offered: true });
  const el = await renderApp();
  await until(() => firstRunAsk(el) !== null, 'the first-run ask');
  expect(noteDialog()).toBeNull();
  await act(async () => buttonIn(firstRunAsk(el)!, 'Turn on')!.click());
  await until(() => firstRunAsk(el) === null, 'the ask going after Turn on');
  expect(asked).toBe(1);
  // Recorded for this address, as Settings does.
  const saved = posts.find((p) => p.path.startsWith('/api/inbox/settings') && (p.body.notifications as Record<string, unknown> | undefined)?.enabled === true);
  expect((saved?.body.notifications as Record<string, unknown>).allowed_origin).toBe(window.location.origin);
}, 30_000);

test.skipIf(!hasDom)('Not now on the first-run screen is the same "Not now": it stays dismissed, and the list does not ask either', async () => {
  agentsModel = model({ notes_asked: ['codex'], notes_offered: true });
  const el = await renderApp();
  await until(() => firstRunAsk(el) !== null, 'the first-run ask');
  await act(async () => buttonIn(firstRunAsk(el)!, 'Not now')!.click());
  await until(() => firstRunAsk(el) === null, 'the ask going after Not now');
  expect(asked).toBe(0);
  const settings = JSON.parse((await loopback('/api/inbox/settings')).text) as { notifications: { dismissed: boolean } };
  expect(settings.notifications.dismissed).toBe(true);

  await firstMessage('Hello from Claude Code.');
  pokeStream?.();
  await until(() => el.querySelector('.ib-lbody [data-thread-id]') !== null, 'the list with the first thread');
  await wait(300);
  expect(listAsk(el)).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('blocked: the first-run screen says the first question cannot notify, quietly, with How to allow', async () => {
  permission = 'denied';
  agentsModel = model({ notes_asked: ['codex'], notes_offered: true });
  const el = await renderApp();
  await until(() => firstRunAsk(el) !== null, 'the blocked line');
  expect(firstRunAsk(el)!.getAttribute('data-notification-ask')).toBe('blocked');
  expect(firstRunAsk(el)!.textContent).toContain('so you get no notice when an agent asks you its first question');
  expect(buttonIn(firstRunAsk(el)!, 'How to allow')).toBeDefined();
}, 30_000);

test.skipIf(!hasDom)('the ask above the list waits for the note dialog too, and comes back on the same load once it closes', async () => {
  // An Inbox that already has a thread: the list, not the first-run screen.
  await firstMessage('Hello from Claude Code.');
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  const el = host;
  await until(() => el.querySelector('.ib-lbody [data-thread-id]') !== null, 'the list');
  let askBeforeDialog = false;
  await until(() => {
    if (listAsk(el) !== null) askBeforeDialog = true;
    return noteDialog() !== null;
  }, 'the agent-note dialog');
  expect(askBeforeDialog).toBe(false);
  expect(listAsk(el)).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-anote-notnow]')!.click());
  await until(() => listAsk(el) !== null, 'the ask above the list after the dialog');
  expect(listAsk(el)!.getAttribute('data-notification-ask')).toBe('ask');
}, 30_000);

test.skipIf(!hasDom)('moved: allowed at another port of this computer, the first-run screen says so with Allow', async () => {
  setUrl('http://localhost:61000/');
  agentsModel = model({ notes_asked: ['codex'], notes_offered: true });
  await loopback('/api/inbox/settings', 'POST', JSON.stringify({ notifications: { enabled: true, allowed_origin: 'http://localhost:52817' } }));
  const el = await renderApp();
  await until(() => firstRunAsk(el) !== null, 'the moved line');
  const line = firstRunAsk(el)!;
  expect(line.getAttribute('data-notification-ask')).toBe('moved');
  expect(line.textContent).toContain('Notifications are off at this address.');
  expect(line.textContent).toContain('localhost:52817');
  expect(buttonIn(line, 'Allow')).toBeDefined();
}, 30_000);

test.skipIf(!hasDom)('over the tailnet: the first-run screen asks nothing (another device; the first run is set up on this computer)', async () => {
  tailnetPage = true;
  settingsOver = (settings) => {
    settings.via = 'tailnet';
  };
  const el = await renderApp();
  // The note dialog is never decided for a tailnet page's sake (its agents are local only), so give the window time.
  await wait(3500);
  expect(el.querySelector('[data-inbox-empty]')).not.toBeNull();
  expect(firstRunAsk(el)).toBeNull();
  expect(noteDialog()).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('a load that showed the sound dialog: no ask while it is open, and none after it closes on that load', async () => {
  settingsOver = (settings) => {
    settings.sound = { ...settings.sound, dialog_due: true };
  };
  soundShows = true;
  const el = await renderApp();
  let askBeforeSound = false;
  await until(() => {
    if (firstRunAsk(el) !== null) askBeforeSound = true;
    return buttonIn(document.body, 'Keep it on') !== undefined;
  }, 'the sound dialog');
  expect(askBeforeSound).toBe(false);
  expect(firstRunAsk(el)).toBeNull();
  await act(async () => buttonIn(document.body, 'Keep it on')!.click());
  await until(() => buttonIn(document.body, 'Keep it on') === undefined, 'the sound dialog closing');
  await wait(3500);
  expect(firstRunAsk(el)).toBeNull();
  // And the note dialog waits for a later load too.
  expect(noteDialog()).toBeNull();
}, 30_000);
