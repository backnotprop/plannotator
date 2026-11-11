import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxMessage } from '@plannotator/core/inbox-types';

import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { ComposeFileTiles } = (hasDom ? await import('./compose/ComposeFiles') : {}) as typeof import('./compose/ComposeFiles');
const { unsentReply } = (hasDom ? await import('./unsent') : {}) as typeof import('./unsent');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const PASTED = /^pasted-text-\d{4}-\d\d-\d\d-\d{4}(-\d+)?\.txt$/;
const LOG = Array.from({ length: 800 }, (_, i) => `2026-11-01T21:10:${String(i % 60).padStart(2, '0')}Z worker retry ${i} charged`).join('\n') + '\n';

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let worlds: World[] = [];
let world: World = { project: '', waiting: '' };
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedXhr: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let refuseDraft: { code: string; error: string; field?: string } | null = null;
let uploadsStarted: string[] = [];
let inflight = 0;

function loopback(path: string, method = 'GET', body?: string | Buffer, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
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

class LoopbackXhr {
  status = 0;
  responseText = '';
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private path = '';
  private aborted = false;
  open(_method: string, path: string) {
    this.path = path;
    uploadsStarted.push(path);
  }
  setRequestHeader() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  send(file: Blob) {
    void (async () => {
      const bytes = Buffer.from(await file.arrayBuffer());
      const answer = await loopback(this.path, 'POST', bytes, { 'Content-Type': 'application/octet-stream' });
      if (this.aborted) return;
      this.upload.onprogress?.({ loaded: bytes.length, total: bytes.length, lengthComputable: true });
      this.status = answer.status;
      this.responseText = answer.text;
      this.onload?.();
    })();
  }
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-paste-text-dom-')));
  // The DOM server uses the scratch HOME it inherits from the preload: nothing here names one.
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '10'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_BROWSER: NO_BROWSER },
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
  world = worlds.shift()!;
  savedFetch = globalThis.fetch;
  inflight = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inflight += 1;
    try {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? String(init.body) : undefined;
      if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
      if (refuseDraft && method === 'POST' && path.endsWith('/draft')) {
        const refusal = refuseDraft;
        refuseDraft = null;
        return new Response(JSON.stringify(refusal), { status: 422, headers: { 'Content-Type': 'application/json' } });
      }
      const answer = await loopback(path, method, body);
      return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    } finally {
      inflight -= 1;
    }
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedXhr = (globalThis as Record<string, unknown>).XMLHttpRequest;
  (globalThis as Record<string, unknown>).XMLHttpRequest = LoopbackXhr;
  posted = [];
  refuseDraft = null;
  uploadsStarted = [];
  window.location.hash = '';
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // Leaving the thread saves what waits at once: that save (and its read-back) is answered by this test's Inbox
  // before the real fetch is back. On the real fetch it fails (a relative URL), and a save that did not land
  // marks its thread "not saved" in module state, so the next test would start with the restart guard asking.
  await requestsSettled();
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  (globalThis as Record<string, unknown>).XMLHttpRequest = savedXhr;
});

/**
 * No request of this test is in flight, on two reads a macrotask apart: the draft's saves chain on microtasks,
 * so a save queued behind an answer has started its request by the second read.
 */
async function requestsSettled() {
  for (let i = 0; i < 250; i++) {
    if (inflight === 0) {
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      if (inflight === 0) return;
    }
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  }
  throw new Error(`timed out waiting for the requests of the test to settle (${inflight} in flight)`);
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function renderApp(hash = '', ready = '.ib-side [data-open-compose]') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!host!.querySelector(ready), 'the window');
  return host;
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

function type(text: HTMLTextAreaElement, words: string, caret = words.length) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(before, 'inputType', { value: 'insertText' });
    text.dispatchEvent(before);
    setter.call(text, words);
    text.setSelectionRange(caret, caret);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function browserUndo(text: HTMLTextAreaElement): boolean {
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'inputType', { value: 'historyUndo' });
  act(() => {
    text.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function paste(target: HTMLElement, words: string): boolean {
  const items = [{ kind: 'string', type: 'text/plain', getAsFile: () => null }];
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [], items, types: ['text/plain'], getData: (type: string) => (type === 'text/plain' ? words : '') } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const pastedTiles = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[data-pasted-text]')];
const replyBox = (el: HTMLElement) => el.querySelector('.ib-rbox') as HTMLElement | null;

async function openReply(el: HTMLElement): Promise<HTMLTextAreaElement> {
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  return replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement;
}

const BEFORE = 'Here is the log from the failing run.';
const AFTER = ' The third retry is the one that charged twice.';

test.skipIf(!hasDom)('the reply box: 32 KB pasted between words becomes a tile; Undo puts the exact text back there with the caret after it', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, BEFORE + AFTER, BEFORE.length);
  const short = 'x'.repeat(32 * 1024 - 1);
  expect(paste(text, short)).toBe(false);
  expect(pastedTiles(el)).toHaveLength(0);

  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(el).length === 1, 'the tile');
  const tile = pastedTiles(el)[0]!;
  expect(tile.getAttribute('data-compose-file-name')).toMatch(PASTED);
  expect(tile.querySelector('.ib-pt-nm')?.textContent).toBe(LOG.split('\n')[0]);
  expect(text.value).toBe(BEFORE + AFTER);
  await until(() => el.querySelector('[data-fold-live]')?.textContent?.startsWith('Attached pasted-text-') === true, 'the announcement');

  type(text, `Hi. ${BEFORE}${AFTER}`, 4 + BEFORE.length);
  act(() => (tile.querySelector('[data-pasted-undo]') as HTMLButtonElement).click());
  expect(pastedTiles(el)).toHaveLength(0);
  expect(text.value).toBe(`Hi. ${BEFORE}${LOG}${AFTER}`);
  expect(document.activeElement).toBe(text);
  expect(text.selectionStart).toBe(`Hi. ${BEFORE}${LOG}`.length);
  expect(text.selectionEnd).toBe(text.selectionStart);
}, 30_000);

test.skipIf(!hasDom)('after 10 s the tile offers Put back in box; a selection the paste replaced is gone, as a paste takes it', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, `${BEFORE} OLD WORDS${AFTER}`);
  act(() => text.setSelectionRange(BEFORE.length + 1, BEFORE.length + 1 + 'OLD WORDS'.length));
  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(el).length === 1 && text.value === `${BEFORE} ${AFTER}`, 'the tile, the selection gone');
  const tile = () => pastedTiles(el)[0]!;
  expect(tile().querySelector('[data-pasted-undo]')).not.toBeNull();
  expect(tile().querySelector('[data-pasted-put-back]')).toBeNull();

  await wait(10_200);
  expect(tile().querySelector('[data-pasted-undo]')).toBeNull();
  expect(tile().querySelector('[data-pasted-line]')?.textContent).toContain('Put back in box');
  const back = tile().querySelector('[data-pasted-put-back]') as HTMLButtonElement;
  const name = tile().getAttribute('data-compose-file-name')!;
  expect(back.getAttribute('aria-label')).toContain(name);
  expect(back.getAttribute('aria-label')).toContain('Put back in box');
  type(text, `${BEFORE} ${AFTER} Thanks.`, `${BEFORE} ${AFTER} Thanks.`.length);
  act(() => (tile().querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  expect(text.value).toBe(`${BEFORE} ${LOG}${AFTER} Thanks.`);
  expect(text.selectionStart).toBe(`${BEFORE} ${LOG}`.length);
}, 40_000);

test.skipIf(!hasDom)('a keyboard user on Undo as its 10 s pass: focus stays on the same control, which now reads Put back in box', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  const file = { key: 'k1', name: 'pasted-text-2026-11-02-0109.txt', size: LOG.length, state: 'done' as const, progress: 1, upload: null, error: null, preview: null, pasted: { text: LOG, preview: 'The log', at: Date.now() - 9_800 } };
  act(() => {
    root = createRoot(host!);
    root.render(<ComposeFileTiles files={[file]} onRemove={() => {}} onPutBack={() => {}} />);
  });
  const undo = host.querySelector('[data-pasted-undo]') as HTMLButtonElement;
  act(() => undo.focus());
  expect(document.activeElement).toBe(undo);
  await until(() => host!.querySelector('[data-pasted-put-back]') !== null, 'the swap');
  expect(host.querySelector('[data-pasted-undo]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[data-pasted-put-back]'));
  expect(document.activeElement?.textContent).toBe('Put back in box');
}, 30_000);

test.skipIf(!hasDom)('CRLF line ends: Undo puts back the words as the box holds them (\\n), the caret after them; the file keeps the bytes', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  const crlf = LOG.replace(/\n/g, '\r\n');
  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, crlf)).toBe(true);
  await until(() => pastedTiles(el).length === 1, 'the tile');
  act(() => (pastedTiles(el)[0]!.querySelector('[data-pasted-undo]') as HTMLButtonElement).click());
  expect(text.value).toBe(BEFORE + LOG + AFTER);
  expect(text.selectionStart).toBe((BEFORE + LOG).length);

  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, crlf)).toBe(true);
  expect(paste(text, `${LOG}second\n`)).toBe(true);
  await until(() => pastedTiles(el).length === 2, 'two tiles');
  const labels = pastedTiles(el).map((tile) => tile.querySelector('[data-pasted-undo]')!.getAttribute('aria-label'));
  expect(new Set(labels).size).toBe(2);
  pastedTiles(el).forEach((tile, i) => expect(labels[i]).toContain(tile.getAttribute('data-compose-file-name')!));
  act(() => (pastedTiles(el)[1]!.querySelector('.ib-cp-fx') as HTMLButtonElement).click());
  await until(() => pastedTiles(el)[0]?.getAttribute('data-compose-file') === 'done', 'the upload');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
  expect(posted.find((p) => p.path.endsWith('/reply'))!.body).toMatchObject({ words: BEFORE + AFTER });
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  expect(readFileSync(model.thread.messages.at(-1)!.attachments![0]!.path, 'utf8')).toBe(crlf);
}, 30_000);

test.skipIf(!hasDom)('a paste of a named file beside 32 KB of text: the file attaches and the text is a tile, not words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, BEFORE + AFTER, BEFORE.length);
  const file = new File(['%PDF-1.4 notes'], 'notes.pdf', { type: 'application/pdf' });
  const items = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: file.type, getAsFile: () => file },
  ];
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [file], items, types: items.map((i) => i.type), getData: (t: string) => (t === 'text/plain' ? LOG : '') } });
  act(() => {
    text.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  await until(() => el.querySelectorAll('[data-compose-file]').length === 2, 'the file and the tile');
  expect(pastedTiles(el)).toHaveLength(1);
  expect(el.querySelector('[data-compose-file-name="notes.pdf"]')).not.toBeNull();
  expect(text.value).toBe(BEFORE + AFTER);
  act(() => (pastedTiles(el)[0]!.querySelector('[data-pasted-undo]') as HTMLButtonElement).click());
  expect(text.value).toBe(BEFORE + LOG + AFTER);
  expect(text.selectionStart).toBe((BEFORE + LOG).length);
}, 30_000);

test.skipIf(!hasDom)('a reply draft refused for anything but its length never says "too long", and the restart guard asks until a save lands', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  refuseDraft = { code: 'validation_error', error: 'base_body: a string.', field: 'base_body' };
  type(text, 'Ship it.');
  await until(() => refuseDraft === null, 'the refused save');
  await wait(300);
  const saidTooLong = el.querySelector('[data-draft-too-long]') !== null;
  const guardAsked = unsentReply() !== null;
  type(text, 'Ship it today.');
  await until(() => posted.some((p) => p.path.endsWith('/draft') && p.body.body === 'Ship it today.'), 'the save');
  expect(saidTooLong).toBe(false);
  expect(guardAsked).toBe(true);
  expect(el.querySelector('[data-draft-too-long]')).toBeNull();
  await until(() => unsentReply() === null, 'the guard at rest');
}, 30_000);

test.skipIf(!hasDom)("the browser's undo puts the paste back as the very next edit, stands down after another edit, and Send carries the file", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(el).length === 1, 'the tile');
  expect(browserUndo(text)).toBe(true);
  expect(pastedTiles(el)).toHaveLength(0);
  expect(text.value).toBe(BEFORE + LOG + AFTER);
  expect(text.selectionStart).toBe((BEFORE + LOG).length);

  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(el).length === 1, 'the tile again');
  type(text, `${BEFORE}!${AFTER}`, BEFORE.length + 1);
  expect(browserUndo(text)).toBe(false);
  expect(pastedTiles(el)).toHaveLength(1);
  expect(text.value).toBe(`${BEFORE}!${AFTER}`);

  await until(() => pastedTiles(el)[0]?.getAttribute('data-compose-file') === 'done', 'the upload');
  const name = pastedTiles(el)[0]!.getAttribute('data-compose-file-name')!;
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
  const reply = posted.find((p) => p.path.endsWith('/reply'))!;
  expect(reply.body).toMatchObject({ words: `${BEFORE}!${AFTER}` });
  expect((reply.body.uploads as string[]).length).toBe(1);
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  const sent = model.thread.messages.at(-1)!;
  expect(sent.attachments!.map((a) => a.name)).toEqual([name]);
  expect(readFileSync(sent.attachments![0]!.path, 'utf8')).toBe(LOG);
}, 30_000);

test.skipIf(!hasDom)('New message: a tile alone is sent; Put back works there; 32 KB pasted into the thread name becomes a tile', async () => {
  const projects = JSON.parse((await loopback('/api/inbox/projects')).text) as { projects: { id: string; root: string }[] };
  await poll('ses-paste-text', 'pi', projects.projects.find((p) => p.id === world.project)!.root);
  const el = await renderApp();
  act(() => (el.querySelector('.ib-side [data-open-compose]') as HTMLButtonElement).click());
  const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement;
  await until(() => !!dialog()?.querySelector('button[data-compose-to="choose"]:not([data-loading])'), 'To loaded');
  act(() => (dialog().querySelector('button[data-compose-to]') as HTMLButtonElement).click());
  await until(() => !!dialog().querySelector('[role="option"][data-compose-session="ses-paste-text"]'), 'the picker');
  act(() => (dialog().querySelector('[role="option"][data-compose-session="ses-paste-text"]') as HTMLElement).click());
  await until(() => !!dialog()?.querySelector('[data-compose-to="ses-paste-text"]'), 'To picked');
  const text = dialog().querySelector('textarea') as HTMLTextAreaElement;

  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(dialog()).length === 1, 'the tile');
  act(() => (pastedTiles(dialog())[0]!.querySelector('[data-pasted-undo]') as HTMLButtonElement).click());
  expect(text.value).toBe(BEFORE + LOG + AFTER);
  expect(text.selectionStart).toBe((BEFORE + LOG).length);

  type(text, '');
  const chip = dialog().querySelector('input[aria-label="Thread name"]') as HTMLInputElement;
  expect(paste(chip, LOG)).toBe(true);
  await until(() => pastedTiles(dialog()).length === 1, 'the chip paste as a tile');
  expect(text.value).toBe('');
  expect(dialog().querySelector('[data-compose-thread-name-note]')?.textContent).toContain('attached');

  await until(() => pastedTiles(dialog())[0]?.getAttribute('data-compose-file') === 'done', 'the upload');
  const name = pastedTiles(dialog())[0]!.getAttribute('data-compose-file-name')!;
  act(() => (dialog().querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => document.querySelector('dialog[data-compose]') === null, 'compose closed');
  const sent = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(sent.body.body).toBe('');
  const threads = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: { threads: { thread_id: string; subject: string }[] }[] };
  const started = threads.sections.flatMap((s) => s.threads).find((t) => t.subject === name)!;
  const model = JSON.parse((await loopback(`/api/inbox/threads/${started.thread_id}`)).text) as { thread: { messages: InboxMessage[] } };
  expect(model.thread.messages[0]!.attachments!.map((a) => a.name)).toEqual([name]);
}, 30_000);

test.skipIf(!hasDom)('a reply too long for a draft says so above the box and is never posted as one; shorter, it saves again', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  const huge = 'w'.repeat(1_000_001);
  type(text, huge);
  await until(() => el.querySelector('[data-draft-too-long]') !== null, 'the line');
  expect(el.querySelector('[data-draft-too-long]')?.textContent).toContain('1,000,000');
  await wait(700);
  expect(posted.some((p) => p.path.endsWith('/draft') && (p.body.body as string)?.length > 1_000_000)).toBe(false);

  type(text, 'Shorter now.');
  await until(() => posted.some((p) => p.path.endsWith('/draft') && p.body.body === 'Shorter now.'), 'the save');
  expect(el.querySelector('[data-draft-too-long]')).toBeNull();
}, 30_000);

test.skipIf(!hasDom)("New message: a draft too long to keep says so plainly, never the Inbox's field words", async () => {
  const el = await renderApp();
  act(() => (el.querySelector('.ib-side [data-open-compose]') as HTMLButtonElement).click());
  const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement;
  await until(() => !!dialog()?.querySelector('[data-compose-to]:not([data-loading])'), 'the sessions read');
  const text = dialog().querySelector('textarea') as HTMLTextAreaElement;
  type(text, 'd'.repeat(1_000_001));
  await until(() => !!dialog().querySelector('[data-compose-save]'), 'Save draft');
  act(() => (dialog().querySelector('[data-compose-save]') as HTMLButtonElement).click());
  await until(() => !!dialog().querySelector('[data-compose-error]'), 'the error');
  const said = dialog().querySelector('[data-compose-error]')!.textContent!;
  expect(said).toContain('1,000,000');
  expect(said).not.toContain('body:');
  expect(posted.some((p) => p.path.startsWith('/api/inbox/drafts/'))).toBe(false);
}, 30_000);
