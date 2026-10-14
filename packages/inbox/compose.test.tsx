/**
 * Compose, as the window draws it (approval record "inbox-compose-to-agent"):
 * the whole window (InboxApp) over a REAL Inbox server in a temp data dir
 * (its own process, tests/helpers/inbox-dom-server.ts), the window's fetches
 * carried to it over loopback, and agent sessions made live by real bridge
 * polls with the registry's token. What is proved: with no live agent, Send
 * sends nothing and says so; closing with words asks Keep draft / Discard
 * (Escape asks too, and a second Escape goes back); Discard keeps nothing;
 * Keep draft makes the sidebar's Drafts row and the Drafts page row; delete
 * has Undo; with a live session To is prefilled and Send starts the thread
 * addressed to it (the list row draws that agent, "To <agent>").
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let projects: string[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];

function loopback(path: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

/** One poll from an agent connection working in `project`: the session is live for 30 s after it. */
async function poll(session: string, hostName: string, project: string) {
  const { token } = JSON.parse(readFileSync(join(dir!, 'data', 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  const answer = await loopback(
    '/api/inbox/bridge/poll',
    'POST',
    JSON.stringify({ session, host: hostName, waitMs: 0, project_path: project, started_at: Date.now() - 60_000, busy: false }),
    { Authorization: `Bearer ${token}` },
  );
  expect(answer.status).toBe(200);
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-compose-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_BROWSER: '/usr/bin/true' },
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
  const started = JSON.parse(line.trim()) as { port: number };
  port = started.port;
  const model = JSON.parse((await loopback('/api/inbox/projects')).text) as { projects: { root: string }[] };
  projects = model.projects.map((p) => p.root);
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
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  posted = [];
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
  await until(() => !!host!.querySelector('.ib-side [data-open-compose]'), 'the window');
  return host;
}

const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement | null;

function type(words: string) {
  const text = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const key = (k: string, extra: KeyboardEventInit = {}) =>
  act(() => {
    (dialog()!.querySelector('textarea') ?? dialog()!).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  });

async function openCompose(el: HTMLElement) {
  act(() => (el.querySelector('.ib-side [data-open-compose]') as HTMLButtonElement).click());
  await until(() => !!dialog()?.querySelector('[data-compose-to]'), 'compose');
}

async function drafts(): Promise<{ id: string; body: string; status: string }[]> {
  return (JSON.parse((await loopback('/api/inbox/drafts')).text) as { drafts: { id: string; body: string; status: string }[] }).drafts;
}

test.skipIf(!hasDom)('no live agent: Send sends nothing and says so; Escape asks Keep draft / Discard, a second Escape goes back; Discard keeps nothing', async () => {
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="none"]') !== null, 'the no-agent state');
  expect(dialog()!.querySelector('[data-compose-note="none"]')?.textContent).toContain('Nothing can be sent until one is.');
  // An empty compose closes at once, asking nothing.
  key('Escape');
  await until(() => dialog() === null, 'compose closed');

  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="none"]') !== null, 'the no-agent state');
  type('Rename the Quiet section to Done?');
  expect(dialog()!.querySelector('[data-compose-subject]')?.textContent).toBe('New thread: Rename the Quiet section to Done?');
  expect(dialog()!.querySelector('[data-compose-send]')?.getAttribute('aria-disabled')).toBe('true');
  key('Enter', { metaKey: true });
  await until(() => dialog()!.querySelector('[data-compose-error]') !== null, 'the error');
  expect(dialog()!.querySelector('[data-compose-error]')?.textContent).toBe('Nothing sent: no live agent is chosen. Save it as a draft.');
  expect(posted.some((p) => p.path === '/api/inbox/messages')).toBe(false);

  key('Escape');
  expect(dialog()!.querySelector('[data-compose-question]')?.textContent).toContain('Keep this message as a draft?');
  key('Escape');
  expect(dialog()!.querySelector('[data-compose-question]')).toBeNull();
  key('Escape');
  act(() => (dialog()!.querySelector('[data-compose-discard]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  expect(await drafts()).toEqual([]);
  expect(el.querySelector('[data-drafts-nav]')).toBeNull();
});

test.skipIf(!hasDom)('Keep draft: the sidebar\'s Drafts row and the Drafts page list it with its chip; delete has Undo', async () => {
  const el = await renderApp();
  await openCompose(el);
  type('Idea: group the list by session.');
  key('Escape');
  act(() => (dialog()!.querySelector('[data-compose-keep]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  await until(() => el.querySelector('[data-drafts-nav]')?.textContent === 'Drafts1', 'the Drafts row');
  expect(document.querySelector('[data-inbox-toast]')?.textContent).toContain('It waits under Drafts and never sends itself.');

  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  const row = el.querySelector('[data-draft-id]')!;
  expect(row.querySelector('[data-draft-chip]')?.textContent).toBe('No agent chosen');
  expect(row.textContent).toContain('Idea: group the list by session.');

  // From the keyboard: the delete button has focus; with no other draft it goes to the Drafts heading, never the page.
  const del = row.querySelector('[data-draft-delete]') as HTMLButtonElement;
  act(() => del.focus());
  act(() => del.click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 0, 'the row gone');
  await until(() => document.activeElement === el.querySelector('[data-drafts-page] h1'), 'focus on the Drafts heading');
  expect(await drafts()).toEqual([]);
  act(() => (document.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft back');
  expect((await drafts()).map((d) => d.body)).toEqual(['Idea: group the list by session.']);
});

test.skipIf(!hasDom)('a live session: To is prefilled, Send starts the thread addressed to it, and the draft it came from goes', async () => {
  await poll('ses_live_dom', 'claude-code', projects[0]!);
  const el = await renderApp('#drafts');
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  await until(() => el.querySelector('[data-draft-chip]')?.textContent === 'No agent chosen', 'the chip');
  act(() => (el.querySelector('.ib-draft-open') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_live_dom"]') !== null && dialog() !== null, 'To prefilled');
  expect(dialog()!.querySelector('[data-compose-status]')?.textContent).toBe('Claude Code takes it as its next turn.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  const send = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(send.body).toMatchObject({ to: { host: 'claude-code', session: 'ses_live_dom' }, body: 'Idea: group the list by session.' });
  expect(typeof send.body.draft_id).toBe('string');
  expect(document.querySelector('[data-inbox-toast]')?.textContent).toContain('Sent to Claude Code');
  // The row that opened it is gone: focus goes to the Drafts heading (no other draft), never the page.
  await until(() => document.activeElement === el.querySelector('[data-drafts-page] h1'), 'focus on the Drafts heading');
  expect(await drafts()).toEqual([]);
  await until(() => el.querySelector('[data-drafts-nav]') === null, 'no Drafts row');
  const sections = (JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] }).sections;
  const row = sections.flatMap((s) => s.threads).find((t) => t.subject === 'Idea: group the list by session.')!;
  expect(row).toMatchObject({ section: 'sent', addressee: { host: 'claude-code', session: 'ses_live_dom' } });
});
