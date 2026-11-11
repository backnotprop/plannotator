import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection } from '@plannotator/core/inbox-types';

import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let projects: string[] = [];
let seeded: { waiting: string } | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let sendAnswer: { status: number; body: Record<string, unknown> } | null = null;

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
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_BROWSER: NO_BROWSER },
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
  const started = JSON.parse(line.trim()) as { port: number; worlds: { waiting: string }[] };
  port = started.port;
  seeded = started.worlds[0]!;
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
    if (sendAnswer && method === 'POST' && path === '/api/inbox/messages') {
      return new Response(JSON.stringify(sendAnswer.body), { status: sendAnswer.status, headers: { 'Content-Type': 'application/json' } });
    }
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

async function pickTo(session: string) {
  await until(() => dialog()!.querySelector('[data-compose-to]:not([data-loading])') !== null && dialog()!.querySelector('button[data-compose-to]') !== null, 'To loaded');
  act(() => (dialog()!.querySelector('button[data-compose-to]') as HTMLButtonElement).click());
  await until(() => dialog()!.querySelector(`[role="option"][data-compose-session="${session}"]`) !== null, `${session} in the picker`);
  act(() => (dialog()!.querySelector(`[role="option"][data-compose-session="${session}"]`) as HTMLElement).click());
  await until(() => dialog()!.querySelector(`[data-compose-to="${session}"]`) !== null, `To names ${session}`);
}

async function drafts(): Promise<{ id: string; body: string; status: string }[]> {
  return (JSON.parse((await loopback('/api/inbox/drafts')).text) as { drafts: { id: string; body: string; status: string }[] }).drafts;
}

test.skipIf(!hasDom)('no live agent: Send sends nothing and says so; Escape keeps the words as a draft with no question, Reopen brings them back, Delete draft and an emptied compose keep nothing', async () => {
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="none"]') !== null, 'the no-agent state');
  expect(dialog()!.querySelector('[data-compose-note="none"]')?.textContent).toContain('Nothing can be sent until one is.');
  await until(() => document.activeElement === dialog()!.querySelector('textarea'), 'focus in the message');
  expect(dialog()!.querySelector('[data-compose-save]')).toBeNull();
  key('Escape');
  await until(() => dialog() === null, 'compose closed');

  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="none"]') !== null, 'the no-agent state');
  type('Rename the Quiet section to Done?');
  await until(() => chipInput().value === 'Quiet section', 'the chip named from the message');
  expect(dialog()!.querySelector('[data-compose-send]')?.getAttribute('aria-disabled')).toBe('true');
  key('Enter', { metaKey: true });
  await until(() => dialog()!.querySelector('[data-compose-error]') !== null, 'the error');
  expect(dialog()!.querySelector('[data-compose-error]')?.textContent).toBe('Nothing sent: no live agent is chosen. Save it as a draft.');
  expect(posted.some((p) => p.path === '/api/inbox/messages')).toBe(false);

  key('Escape');
  await until(() => dialog() === null, 'compose closed');
  const kept = await drafts();
  expect(kept.map((d) => d.body)).toEqual(['Rename the Quiet section to Done?']);
  const toast = document.querySelector('[data-inbox-toast]')!;
  expect(toast.textContent).toContain('Draft saved');
  const reopen = toast.querySelector('[data-toast-action]') as HTMLButtonElement;
  expect(reopen.textContent).toBe('Reopen');
  act(() => reopen.click());
  await until(() => dialog()?.querySelector('textarea') != null, 'compose reopened');
  expect((dialog()!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Rename the Quiet section to Done?');
  act(() => (dialog()!.querySelector('[data-compose-delete]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  await until(() => document.querySelector('[data-inbox-toast]')?.textContent?.includes('Draft saved') !== true, 'the delete toast');
  expect(await drafts()).toEqual([]);

  await openCompose(el);
  type('Never mind.');
  type('');
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
  expect(await drafts()).toEqual([]);
  // Bun 1.3 passed a failing `.toBeNull()` here when the element was too big to print.
  const { replies } = JSON.parse((await loopback('/api/inbox/drafts')).text) as { replies?: unknown[] };
  expect(el.querySelector('[data-drafts-nav] .ib-n')?.textContent ?? '0').toBe(String(replies?.length ?? 0));
});

test.skipIf(!hasDom)('Keep draft: the sidebar\'s Drafts row and the Drafts page list it with its chip; delete has Undo', async () => {
  const el = await renderApp();
  await openCompose(el);
  type('Idea: group the list by session.');
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
  const replies = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { replies?: unknown[] }).replies?.length ?? 0;
  await until(() => el.querySelector('[data-drafts-nav]')?.textContent === `Drafts${1 + replies}`, 'the Drafts row');
  expect(document.querySelector('[data-inbox-toast]')?.textContent).toContain('It never sends itself');

  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  const page = el.querySelector('[data-drafts-page]')!;
  expect(page.querySelector('.ib-dh')?.textContent).toBe('Drafts');
  expect(page.querySelector('.ib-dh')?.nextElementSibling?.tagName).not.toBe('P');
  const row = el.querySelector('[data-draft-id]')!;
  expect(row.querySelector('[data-draft-chip]')?.textContent).toBe('No agent chosen');
  expect(row.textContent).toContain('Idea: group the list by session');

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

test.skipIf(!hasDom)('a live session: a draft saved with nobody in To reopens with To empty; picked, Send starts the thread addressed to it, and the draft it came from goes', async () => {
  await poll('ses_live_dom', 'claude-code', projects[0]!);
  const el = await renderApp('#drafts');
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  await until(() => el.querySelector('[data-draft-chip]')?.textContent === 'No agent chosen', 'the chip');
  act(() => (el.querySelector('[data-draft-id] .ib-draft-open') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('[data-compose-to="choose"]:not([data-loading])') != null, 'To loaded, empty');
  expect(dialog()!.querySelector('[data-compose-send]')?.getAttribute('aria-disabled')).toBe('true');
  await pickTo('ses_live_dom');
  expect(dialog()!.querySelector('[data-compose-status]')).toBeNull();
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  const send = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(send.body).toMatchObject({ to: { host: 'claude-code', session: 'ses_live_dom' }, body: 'Idea: group the list by session.' });
  expect(typeof send.body.draft_id).toBe('string');
  expect(document.querySelector('[data-inbox-toast]')?.textContent).toContain('Sent to Claude Code');
  const detail = document.querySelector('[data-inbox-toast] .ib-tdetail')?.textContent ?? '';
  expect(detail).toMatch(/^in \S/);
  expect(detail).not.toContain('next turn');
  await until(() => /^Sent to Claude Code in .+\. It takes it as its next turn\.$/.test(document.querySelector('[data-inbox-live]')?.textContent ?? ''), 'the live region says the whole sentence');
  await until(() => document.activeElement === el.querySelector('[data-drafts-page] h1'), 'focus on the Drafts heading');
  expect(await drafts()).toEqual([]);
  const replies = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { replies?: unknown[] }).replies?.length ?? 0;
  await until(() => (el.querySelector('[data-drafts-nav]')?.textContent ?? 'Drafts0') === `Drafts${replies}`, 'the Drafts row without the message');
  const sections = (JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] }).sections;
  const row = sections.flatMap((s) => s.threads).find((t) => t.subject === 'Idea: group the list by session')!;
  expect(row).toMatchObject({ section: 'sent', addressee: { host: 'claude-code', session: 'ses_live_dom' } });
});

test.skipIf(!hasDom)('a plain New message opens with To empty and focus on To; Send is refused until an agent is picked; a draft and "Message <host>" keep the session they name', async () => {
  await poll('ses_empty_a', 'claude-code', projects[0]!);
  await poll('ses_empty_b', 'pi', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  const toButton = () => dialog()!.querySelector('button[data-compose-to]') as HTMLButtonElement;
  expect(document.activeElement).toBe(toButton());
  await until(() => dialog()!.querySelector('[data-compose-to="choose"]:not([data-loading])') !== null, 'To loaded, empty');
  await new Promise((r) => setTimeout(r, 200));
  expect(toButton().getAttribute('data-compose-to')).toBe('choose');
  expect(toButton().getAttribute('aria-label')).toBe('To: choose an agent');
  expect(document.activeElement).toBe(toButton());
  // Pinned on purpose: the user-facing refusal while To is empty.
  expect(dialog()!.querySelector('[data-compose-status]')?.textContent).toBe('Choose an agent to send it.');
  expect(dialog()!.querySelector('[data-compose-send]')?.getAttribute('aria-disabled')).toBe('true');
  expect(dialog()!.querySelector('[data-compose-save]')).toBeNull();
  type('Look at the relay budget.');
  await until(() => dialog()!.querySelector('[data-compose-save]') !== null, 'Save draft once something is written');
  key('Enter', { metaKey: true });
  await until(() => dialog()!.querySelector('[data-compose-error]') !== null, 'the error');
  // Pinned on purpose: the user-facing refusal ⌘↵ gives while To is empty.
  expect(dialog()!.querySelector('[data-compose-error]')?.textContent).toBe('Nothing sent: choose a live agent first.');
  expect(posted.some((p) => p.path === '/api/inbox/messages')).toBe(false);
  act(() => toButton().click());
  await until(() => dialog()!.querySelector('[data-compose-picker]') !== null, 'the picker');
  act(() => {
    (dialog()!.querySelector('[data-compose-picker] input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => dialog()!.querySelector('[data-compose-picker]') === null, 'the picker closed');
  expect(document.activeElement).toBe(toButton());
  await pickTo('ses_empty_b');
  expect(document.activeElement).toBe(dialog()!.querySelector('textarea'));
  expect(dialog()!.querySelector('[data-compose-send]')?.hasAttribute('aria-disabled')).toBe(false);

  key('Escape');
  await until(() => dialog() === null, 'compose closed');
  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelector('[data-draft-id] .ib-draft-open') !== null, 'the draft row');
  act(() => (el.querySelector('[data-draft-id] .ib-draft-open') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_empty_b"]') != null, 'the draft keeps its To');
  expect(document.activeElement).toBe(dialog()!.querySelector('textarea'));
  act(() => (dialog()!.querySelector('[data-compose-delete]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'draft deleted');

  act(() => (el.querySelector('.ib-sp-entry') as HTMLButtonElement).click());
  await until(() => document.querySelector('dialog[data-search-palette]') !== null, 'the palette');
  const input = document.querySelector('dialog[data-search-palette] input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, 'claude');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(() => document.querySelector('[data-compose-action="message"]') !== null, 'the Message action');
  act(() => (document.querySelector('[data-compose-action="message"]') as HTMLElement).click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_empty_a"]') != null, 'To names the action\'s session');
  expect(document.activeElement).toBe(dialog()!.querySelector('textarea'));
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
});

test.skipIf(!hasDom)('sent to session A, the next plain New message opens with To empty; the picker lists A first with no row highlighted, Enter picks nothing, an arrow highlights A', async () => {
  await poll('ses_owner_a', 'claude-code', projects[0]!);
  await poll('ses_owner_b', 'pi', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await pickTo('ses_owner_a');
  type('First message to A.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  expect(posted.find((p) => p.path === '/api/inbox/messages')!.body).toMatchObject({ to: { session: 'ses_owner_a' } });

  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to]:not([data-loading])') !== null, 'To loaded');
  await new Promise((r) => setTimeout(r, 200));
  const toButton = dialog()!.querySelector('button[data-compose-to]') as HTMLButtonElement;
  expect(toButton.getAttribute('data-compose-to')).toBe('choose');
  expect(document.activeElement).toBe(toButton);

  act(() => toButton.click());
  await until(() => dialog()!.querySelector('[data-compose-picker] [role="option"]') !== null, 'the picker');
  const input = dialog()!.querySelector('[data-compose-picker] input') as HTMLInputElement;
  const options = () => [...dialog()!.querySelectorAll<HTMLElement>('[data-compose-picker] [role="option"]')];
  expect(options()[0]!.getAttribute('data-compose-session')).toBe('ses_owner_a');
  expect(options().some((o) => o.getAttribute('aria-selected') === 'true')).toBe(false);
  expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  const press = (k: string) =>
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  press('Enter');
  expect(dialog()!.querySelector('[data-compose-picker]')).not.toBeNull();
  expect(toButton.getAttribute('data-compose-to')).toBe('choose');
  press('ArrowDown');
  expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  press('Enter');
  await until(() => dialog()!.querySelector('[data-compose-to="ses_owner_a"]') !== null, 'A picked');
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
});

function rowsOnScreen(el: HTMLElement): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of el.querySelectorAll<HTMLElement>('.ib-listcol .ib-lbody [data-thread-id]')) {
    const section = r.closest('[data-section-id]')?.getAttribute('data-section-id') ?? '?';
    (out[section] ??= []).push(r.getAttribute('data-thread-id')!);
  }
  return out;
}

async function threadIdOf(subject: string): Promise<string> {
  const sections = (JSON.parse((await loopback('/api/inbox/threads?archived=exclude')).text) as { sections: InboxListSection[] }).sections;
  const row = sections.flatMap((s) => s.threads).find((t) => t.subject === subject);
  expect(row?.section).toBe('sent');
  return row!.thread_id;
}

test.skipIf(!hasDom)('Send with a thread open: the new thread is in Sent at once, "To Claude Code", and the rows on screen keep their places', async () => {
  await poll('ses_sent_open', 'claude-code', projects[0]!);
  const el = await renderApp(`#thread=${seeded!.waiting}`);
  await until(() => el.querySelector('section.ib-pane') !== null && el.querySelector('.ib-listcol .ib-lbody [data-thread-id]') !== null, 'the thread and the list');
  const before = rowsOnScreen(el);
  await openCompose(el);
  await pickTo('ses_sent_open');
  type('Look at the flaky upload test while I read this.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const id = await threadIdOf('Look at the flaky upload test while I read this');
  await until(() => (rowsOnScreen(el).sent ?? []).includes(id), 'the new row in Sent');
  const row = el.querySelector<HTMLElement>(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`)!;
  expect(row.textContent).toContain('To Claude Code');
  expect(el.querySelector('section.ib-pane')).not.toBeNull();
  const after = rowsOnScreen(el);
  for (const [section, ids] of Object.entries(before)) expect((after[section] ?? []).filter((t) => t !== id)).toEqual(ids);
});

test.skipIf(!hasDom)('Send with no thread open: the new thread is in Sent at once', async () => {
  await poll('ses_sent_list', 'claude-code', projects[0]!);
  const el = await renderApp();
  await until(() => el.querySelector('.ib-listcol .ib-lbody [data-thread-id]') !== null, 'the list');
  await openCompose(el);
  await pickTo('ses_sent_list');
  type('Draft the release notes for the paste fix.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const id = await threadIdOf('Draft the release notes for the paste fix');
  await until(() => (rowsOnScreen(el).sent ?? []).includes(id), 'the new row in Sent');
});

test.skipIf(!hasDom)('Send lights the new thread\'s row once, and only it', async () => {
  await poll('ses_sent_lit', 'claude-code', projects[0]!);
  const el = await renderApp();
  await until(() => el.querySelector('.ib-listcol .ib-lbody [data-thread-id]') !== null, 'the list');
  const lit = () => [...el.querySelectorAll('.ib-listcol [data-thread-id][data-lit]')].map((r) => r.getAttribute('data-thread-id')!);
  expect(lit()).toEqual([]);
  await openCompose(el);
  await pickTo('ses_sent_lit');
  type('Check the lit row after a send.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const id = await threadIdOf('Check the lit row after a send');
  await until(() => lit().length > 0, 'the new row lit');
  expect(lit()).toEqual([id]);
  await until(() => lit().length === 0, 'the light off');
}, 20_000);

test.skipIf(!hasDom)('git too slow to tell the project (project_unresolved): the dialog stays with the words and says to press Send again', async () => {
  await poll('ses_live_dom', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await pickTo('ses_live_dom');
  type('Plan the retry budget.');
  sendAnswer = { status: 503, body: { code: 'project_unresolved', error: 'Could not tell which project /x belongs to: git did not answer in time. Nothing was sent or saved; try the same call again.' } };
  try {
    act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
    await until(() => dialog()!.querySelector('[data-compose-error]') !== null, 'the error');
  } finally {
    sendAnswer = null;
  }
  expect(dialog()!.querySelector('[data-compose-error]')!.textContent).toBe('Could not tell which project that session works in: git did not answer in time. Nothing was sent; press Send again.');
  expect((dialog()!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Plan the retry budget.');
  type('');
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
});

test.skipIf(!hasDom)('the To picker: one line per session, a start time only where one project has two live sessions, and To names the agent and project', async () => {
  const other = join(dir!, 'other-project');
  mkdirSync(other, { recursive: true });
  await poll('ses_pair_a', 'claude-code', projects[0]!);
  await poll('ses_pair_b', 'pi', projects[0]!);
  await poll('ses_solo', 'claude-code', other);
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="choose"]:not([data-loading])') !== null, 'To loaded, empty');
  act(() => (dialog()!.querySelector('[data-compose-to]') as HTMLButtonElement).click());
  await until(() => dialog()!.querySelector('[data-compose-session="ses_solo"]') !== null, 'the picker');
  const option = (session: string) => dialog()!.querySelector(`[role="option"][data-compose-session="${session}"]`)!;
  expect(dialog()!.querySelector('[role="listbox"] [role="group"]')).toBeNull();
  expect(option('ses_solo').parentElement!.getAttribute('role')).toBe('listbox');
  expect(option('ses_pair_a').querySelector('[data-compose-started]')).not.toBeNull();
  expect(option('ses_pair_b').querySelector('[data-compose-started]')).not.toBeNull();
  expect(option('ses_solo').querySelector('[data-compose-started]')).toBeNull();
  expect(option('ses_pair_a').getAttribute('aria-label')).toContain(', started ');
  expect(option('ses_solo').getAttribute('aria-label')).not.toContain('started');
  expect(option('ses_solo').getAttribute('aria-label')).toContain('Claude Code in other-project');
  act(() => (option('ses_solo') as HTMLElement).click());
  await until(() => dialog()!.querySelector('[data-compose-to="ses_solo"]') !== null, 'To changed');
  const to = dialog()!.querySelector('[data-compose-to]')!;
  expect(to.querySelector('b')!.textContent).toBe('Claude Code');
  expect(to.querySelector('.ib-cp-tod')!.textContent).toBe('· other-project');
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
});

const chip = () => dialog()!.querySelector('[data-compose-thread-name]') as HTMLElement;
const chipInput = () => dialog()!.querySelector('[data-compose-thread-name] input') as HTMLInputElement;
const chipError = () => dialog()!.querySelector('[data-compose-thread-name-error]');
function fillChip(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    chipInput().focus();
    setter.call(chipInput(), value);
    chipInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const blurChip = () => act(() => chipInput().blur());

test.skipIf(!hasDom)('the thread chip follows the message until typed in; typed, it stays; emptied, it follows again once focus leaves; a draft keeps only a typed name', async () => {
  await poll('ses_named', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await pickTo('ses_named');
  expect(chip().getAttribute('data-compose-thread-name')).toBe('auto');
  expect(chip().hasAttribute('data-empty')).toBe(true);
  expect(chipInput().value).toBe('');
  expect(chipInput().placeholder).toBe('Name this thread');
  expect(dialog()!.querySelector('[data-compose-thread-row] .ib-cp-tol')!.textContent).toBe('Thread');
  expect(dialog()!.querySelector('[data-compose-subject]')).toBeNull();

  type('can you fix the paste bug in the reply box');
  await until(() => chipInput().value === 'Paste bug', 'the chip named from the message');
  expect(chip().hasAttribute('data-auto')).toBe(true);
  expect(chip().querySelector('.ib-cp-tname-auto')?.textContent).toBe('auto');
  const described = () => chipInput().getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');
  expect(described()).toContain('Named from your message until you type here.');
  expect(chipInput().hasAttribute('title')).toBe(false);
  type('I want to explore what adding a board would look like. Kanban specifically.');
  await until(() => chipInput().value === 'Kanban board', 'the chip follows the message');
  type('What do you think?');
  await until(() => chipInput().value === '', 'nothing to name');

  type('I want to explore what adding a board would look like. Kanban specifically.');
  await until(() => chipInput().value === 'Kanban board', 'named again');
  fillChip('Board ideas');
  expect(chip().getAttribute('data-compose-thread-name')).toBe('edited');
  expect(chip().hasAttribute('data-auto')).toBe(false);
  expect(described()).toContain('Your name for the thread.');
  type('can you fix the paste bug in the reply box');
  await new Promise((r) => setTimeout(r, 400));
  expect(chipInput().value).toBe('Board ideas');

  fillChip('');
  await new Promise((r) => setTimeout(r, 300));
  expect(chipInput().value).toBe('');
  blurChip();
  await until(() => chipInput().value === 'Paste bug', 'following the message again');
  expect(chip().getAttribute('data-compose-thread-name')).toBe('auto');

  key('Escape');
  await until(() => dialog() === null, 'compose closed');
  let saved = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { drafts: { id: string; thread_name?: string }[] }).drafts;
  expect(saved.map((d) => d.thread_name)).toEqual([undefined]);
  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  act(() => (el.querySelector('[data-draft-id] .ib-draft-open') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_named"]') != null && chipInput()?.value === 'Paste bug', 'reopened, named from the message');

  fillChip('Kanban board');
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
  saved = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { drafts: { id: string; thread_name?: string }[] }).drafts;
  expect(saved.map((d) => d.thread_name)).toEqual(['Kanban board']);
});

test.skipIf(!hasDom)('Send: a typed name goes as thread_name (checked first), the chip that follows the message as thread_name_auto; the row has either as its chip', async () => {
  await poll('ses_named', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await pickTo('ses_named');
  type('I want to explore what adding a board would look like. Kanban specifically.');
  await until(() => chipInput().value === 'Kanban board', 'named from the message');
  fillChip('Kanban\u202eboard');
  posted = [];
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => chipError() !== null, 'the error on the chip');
  expect(chipError()!.textContent).toBe('Thread name must not contain bidirectional control characters.');
  expect(chip().hasAttribute('data-invalid')).toBe(true);
  expect(chipInput().getAttribute('aria-invalid')).toBe('true');
  expect(dialog()!.querySelector('[data-compose-error]')).toBeNull();
  expect(posted.some((p) => p.path === '/api/inbox/messages')).toBe(false);
  fillChip('Kanban board');
  expect(chipError()).toBeNull();
  act(() => {
    chipInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => dialog() === null, 'sent');
  let send = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(send.body.thread_name).toBe('Kanban board');
  expect(send.body.thread_name_auto).toBeUndefined();

  await openCompose(el);
  await pickTo('ses_named');
  type('can you fix the paste bug in the reply box');
  await until(() => chipInput().value === 'Paste bug', 'named from the message');
  posted = [];
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  send = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(send.body).toMatchObject({ thread_name: 'Paste bug', thread_name_auto: true });

  const sections = (JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] }).sections;
  const rows = sections.flatMap((s) => s.threads);
  expect(rows.find((t) => t.subject === 'I want to explore what adding a board would look like')!.thread_name).toBe('Kanban board');
  expect(rows.find((t) => t.subject === 'can you fix the paste bug in the reply box')!.thread_name).toBe('Paste bug');
});

test.skipIf(!hasDom)('a typed name another open thread has: refused (409) and said on the chip; a suggestion another thread has is simply not used; the limit counts characters, not UTF-16 units', async () => {
  await poll('ses_taken', 'claude-code', projects[0]!);
  const { serverSession } = JSON.parse((await loopback('/api/inbox/settings')).text) as { serverSession: string };
  const first = await loopback(
    '/api/inbox/messages',
    'POST',
    JSON.stringify({ serverSession, to: { session: 'ses_taken' }, body: 'Relay retry budget, five a minute.', idempotency_key: 'taken-1', thread_name: 'Relay budget' }),
  );
  expect(first.status).toBe(200);

  const el = await renderApp();
  await openCompose(el);
  await pickTo('ses_taken');
  fillChip('🎉'.repeat(130));
  expect([...chipInput().value].length).toBe(120);

  type('Another idea about the relay.');
  fillChip('relay  BUDGET');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => chipError() !== null, 'the refusal on the chip');
  expect(chipError()!.textContent).toContain('Another open thread in this project has this name.');
  expect(dialog()!.querySelector('[data-compose-thread-pill]')!.getAttribute('aria-label')).toBe('Relay budget, with Claude Code');
  expect(dialog()!.querySelector('[data-compose-thread-name-join]')).not.toBeNull();
  expect(chip().hasAttribute('data-offer')).toBe(true);
  expect(chip().hasAttribute('data-invalid')).toBe(false);
  expect(dialog()!.querySelector('[data-compose-error]')).toBeNull();
  fillChip('Relay budget v2');
  expect(chip().hasAttribute('data-offer')).toBe(false);
  expect(chipError()).toBeNull();
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');

  await openCompose(el);
  await pickTo('ses_taken');
  type('Thinking about the relay budget again.');
  await until(() => chipInput().value === 'Relay budget', 'a taken suggestion');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent anyway');
  const rows = (JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] }).sections.flatMap((s) => s.threads);
  expect(rows.find((t) => t.subject === 'Thinking about the relay budget again')!.thread_name ?? null).toBeNull();
});

test.skipIf(!hasDom)('dictation or a paste into the chip that cannot be a name is never cut short: it goes to the message, and the chip says so', async () => {
  await poll('ses_named', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await pickTo('ses_named');
  type('Kanban board idea.');
  await until(() => chipInput().value !== '', 'named');
  const before = chipInput().value;
  const paste = (text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    Object.defineProperty(event, 'clipboardData', { value: { getData: (kind: string) => (kind === 'text/plain' ? text : ''), files: [], items: [], types: ['text/plain'] } });
    act(() => {
      chipInput().focus();
      chipInput().dispatchEvent(event);
    });
    return event;
  };
  const long = 'And the columns should follow every state a thread can be in, '.repeat(3).trim();
  const event = paste(long);
  expect(event.defaultPrevented).toBe(true);
  const text = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  await until(() => text.value === `Kanban board idea. ${long}`, 'the words in the message');
  expect(chipInput().value).toBe(before);
  expect(dialog()!.querySelector('[data-compose-thread-name-note]')!.textContent).toBe('Too long for a name, so it went into your message.');
  paste('Line one\nline two');
  await until(() => text.value.endsWith('\nLine one\nline two'), 'the lines in the message');
  expect(paste('this is a sentence the person said out loud').defaultPrevented).toBe(true);
  expect(paste('Short').defaultPrevented).toBe(false);
});

test.skipIf(!hasDom)('Create thread on a card with no thread: compose to a live session in its project, starting with the title; the Send links the thread to the card', async () => {
  expect((await loopback('/api/inbox/settings', 'POST', JSON.stringify({ board: { on: true } }))).status).toBe(200);
  // The first-visit dialog is claimed here, so it never covers the card.
  await loopback('/api/inbox/board/intro', 'POST', '{}');
  const project = (JSON.parse((await loopback('/api/inbox/projects')).text) as { projects: { id: string; root: string }[] }).projects[0]!;
  const made = JSON.parse((await loopback('/api/inbox/cards', 'POST', JSON.stringify({ project: project.id, title: 'Settings search' }))).text) as { card: { id: string; threads: string[] } };
  expect(made.card.threads).toEqual([]);
  await poll('ses_create_thread', 'claude-code', project.root);
  const el = await renderApp(`#board&card=${made.card.id}`);
  await until(() => el.querySelector<HTMLButtonElement>('[data-card-create-thread]:not(:disabled)') !== null, 'Create thread');
  expect(el.querySelector('[data-card-open-thread]')).toBeNull();
  act(() => el.querySelector<HTMLButtonElement>('[data-card-create-thread]')!.click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_create_thread"]') != null, 'compose to the live session');
  expect(dialog()!.querySelector('[data-compose-card]')!.textContent).toContain('Settings search');
  expect((dialog()!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Settings search\n\n');
  expect(dialog()!.querySelector('[data-compose-board]')).toBeNull();
  key('Escape');
  await until(() => dialog() === null, 'closed without asking');
  act(() => el.querySelector<HTMLButtonElement>('[data-card-create-thread]')!.click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_create_thread"]') != null, 'compose again');
  type('Settings search\n\nFuzzy or prefix matching? Say which and why.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const thread = await threadIdOf('Settings search');
  await until(async () => (JSON.parse((await loopback(`/api/inbox/cards/${made.card.id}`)).text) as { card: { threads: string[] } }).card.threads.includes(thread), 'the thread linked to the card');
  await until(() => el.querySelector(`[data-card-open-thread="${thread}"]`) !== null, 'Open thread on the card');
  expect(el.querySelector('[data-card-create-thread]')).toBeNull();
});

test.skipIf(!hasDom)('Create thread kept as a draft: the draft keeps the card; sent later from Drafts, the thread is linked to the card', async () => {
  expect((await loopback('/api/inbox/settings', 'POST', JSON.stringify({ board: { on: true } }))).status).toBe(200);
  await loopback('/api/inbox/board/intro', 'POST', '{}');
  const project = (JSON.parse((await loopback('/api/inbox/projects')).text) as { projects: { id: string; root: string }[] }).projects[0]!;
  const made = JSON.parse((await loopback('/api/inbox/cards', 'POST', JSON.stringify({ project: project.id, title: 'Draft card link' }))).text) as { card: { id: string } };
  await poll('ses_draft_card', 'claude-code', project.root);
  const el = await renderApp(`#board&card=${made.card.id}`);
  await until(() => el.querySelector<HTMLButtonElement>('[data-card-create-thread]:not(:disabled)') !== null, 'Create thread');
  act(() => el.querySelector<HTMLButtonElement>('[data-card-create-thread]')!.click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_draft_card"]') != null, 'compose to the live session');
  type('Draft card link\n\nWhich of the two search modes?');
  key('Escape');
  await until(() => dialog() === null, 'kept as a draft');
  const kept = (await drafts()).find((d) => d.body.startsWith('Draft card link')) as unknown as { id: string; card?: { id: string; title: string } };
  expect(kept.card).toEqual({ id: made.card.id, title: 'Draft card link' });
  expect((JSON.parse((await loopback(`/api/inbox/cards/${made.card.id}`)).text) as { card: { threads: string[] } }).card.threads).toEqual([]);

  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelector(`[data-draft-id="${kept.id}"]`) !== null, 'the draft row');
  act(() => (el.querySelector(`[data-draft-id="${kept.id}"] [data-draft-delete]`) as HTMLButtonElement).click());
  await until(() => el.querySelector(`[data-draft-id="${kept.id}"]`) === null, 'the row gone');
  act(() => (document.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  await until(() => el.querySelector(`[data-draft-id="${kept.id}"]`) !== null, 'the draft back');
  const restored = (await drafts()).find((d) => d.id === kept.id) as unknown as { card?: { id: string; title: string } };
  expect(restored.card).toEqual({ id: made.card.id, title: 'Draft card link' });

  act(() => (el.querySelector(`[data-draft-id="${kept.id}"] .ib-draft-open`) as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector(`[data-compose-card="${made.card.id}"]`) != null, 'the draft names the card');
  await until(() => dialog()!.querySelector('[data-compose-to="ses_draft_card"]') !== null, 'To keeps the session');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const thread = await threadIdOf('Draft card link');
  await until(async () => (JSON.parse((await loopback(`/api/inbox/cards/${made.card.id}`)).text) as { card: { threads: string[] } }).card.threads.includes(thread), 'the thread linked to the card');
  const refused = await loopback(`/api/inbox/drafts/drf_${'0'.repeat(26)}`, 'POST', JSON.stringify({ body: 'x', base: null, card: { id: 'msg_x', title: 'x' } }));
  expect(refused.status).toBe(422);
  expect(JSON.parse(refused.text)).toMatchObject({ code: 'validation_error', field: 'card' });
});

const BOARD_CHOICE_KEY = 'plannotator-inbox-compose-board';
const boardChip = () => dialog()!.querySelector<HTMLButtonElement>('[data-compose-board]');

test.skipIf(!hasDom)('Board chip: none while the Board is off', async () => {
  expect((await loopback('/api/inbox/settings', 'POST', JSON.stringify({ board: { on: false } }))).status).toBe(200);
  localStorage.setItem(BOARD_CHOICE_KEY, '1');
  try {
    await poll('ses_chip_off', 'claude-code', projects[0]!);
    const el = await renderApp();
    await openCompose(el);
    await until(() => dialog()!.querySelector('[data-compose-thread-row]') !== null, 'the Thread row');
    expect(boardChip()).toBeNull();
  } finally {
    localStorage.removeItem(BOARD_CHOICE_KEY);
  }
});

test.skipIf(!hasDom)('Board chip: off by default; on, the Send asks for the Board with the words as typed, the sent message is marked, and the next compose remembers it', async () => {
  expect((await loopback('/api/inbox/settings', 'POST', JSON.stringify({ board: { on: true } }))).status).toBe(200);
  await loopback('/api/inbox/board/intro', 'POST', '{}');
  localStorage.removeItem(BOARD_CHOICE_KEY);
  await poll('ses_chip', 'claude-code', projects[0]!);
  let el = await renderApp();
  await openCompose(el);
  await until(() => boardChip() !== null, 'the Board chip');
  expect(boardChip()!.getAttribute('aria-pressed')).toBe('false');
  // The accessible name, pinned on purpose: the approval's name for the control (it holds its visible word, WCAG 2.5.3).
  expect(boardChip()!.getAttribute('aria-label')).toBe('Track on Board');
  act(() => boardChip()!.click());
  expect(boardChip()!.getAttribute('aria-pressed')).toBe('true');
  expect(localStorage.getItem(BOARD_CHOICE_KEY)).toBe('1');
  await pickTo('ses_chip');
  type('Chip tracked work\n\nMove the retry budget into config.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const sendBody = posted.find((p) => p.path === '/api/inbox/messages')!.body;
  expect(sendBody.board_request).toBe(true);
  const threadId = await threadIdOf('Chip tracked work');
  const stored = JSON.parse((await loopback(`/api/inbox/threads/${threadId}`)).text) as { thread: { messages: { body: string; board_request?: boolean }[] } };
  expect(stored.thread.messages[0]).toMatchObject({ body: 'Chip tracked work\n\nMove the retry budget into config.', board_request: true });

  await openCompose(el);
  await until(() => boardChip() !== null, 'the Board chip again');
  expect(boardChip()!.getAttribute('aria-pressed')).toBe('true');
  act(() => boardChip()!.click());
  expect(localStorage.getItem(BOARD_CHOICE_KEY)).toBeNull();
  key('Escape');
  await until(() => dialog() === null, 'closed');

  act(() => root?.unmount());
  host?.remove();
  el = await renderApp(`#thread=${threadId}`);
  await until(() => el.querySelector(`[data-message-article] [data-board-request]`) !== null, 'the Board mark');
  expect(el.textContent).not.toContain('plannotator-board-request');
});

test.skipIf(!hasDom)('Board chip: a draft keeps it, whatever the browser chose since', async () => {
  expect((await loopback('/api/inbox/settings', 'POST', JSON.stringify({ board: { on: true } }))).status).toBe(200);
  await loopback('/api/inbox/board/intro', 'POST', '{}');
  localStorage.removeItem(BOARD_CHOICE_KEY);
  await poll('ses_chip_draft', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await until(() => boardChip() !== null, 'the Board chip');
  act(() => boardChip()!.click());
  type('Chip draft kept\n\nLater.');
  key('Escape');
  await until(() => dialog() === null, 'kept as a draft');
  const kept = (await drafts()).find((d) => d.body.startsWith('Chip draft kept')) as unknown as { id: string; board_request?: boolean };
  expect(kept.board_request).toBe(true);
  localStorage.removeItem(BOARD_CHOICE_KEY);
  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelector(`[data-draft-id="${kept.id}"]`) !== null, 'the draft row');
  act(() => (el.querySelector(`[data-draft-id="${kept.id}"] .ib-draft-open`) as HTMLButtonElement).click());
  await until(() => boardChip() !== null, 'the draft opens with the chip');
  expect(boardChip()!.getAttribute('aria-pressed')).toBe('true');
});
