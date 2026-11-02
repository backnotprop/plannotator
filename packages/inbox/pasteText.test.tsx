/**
 * A long paste as a file (approval "inbox-paste-attachment", Option A), as the
 * window does it: the whole window (InboxApp) over a REAL Inbox server in a
 * temp data dir (its own process, tests/helpers/inbox-dom-server.ts), its
 * fetches and uploads carried to it over loopback. What is proved:
 *  - a paste of 32 KB or more in the reply box is prevented and becomes a
 *    pasted text tile (`pasted-text-<stamp>.txt`); the words around it stay;
 *  - Undo (its first 10 s) and Put back in box (after them) put the exact text
 *    back where it was pasted, after edits around it, with the caret after it;
 *    a selection the paste would have replaced goes, as a paste takes it;
 *  - the browser's own undo (`historyUndo`) puts it back as the field's very
 *    next edit, and stands down after any other edit;
 *  - Send carries it as an ordinary upload with the paste's bytes;
 *  - New message: a tile alone is sent (words or files), Put back works there,
 *    and 32 KB pasted into the thread-name chip becomes a tile, not words;
 *  - a reply too long for a draft says so above the box, and is never posted.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
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

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const PASTED = /^pasted-text-\d{4}-\d\d-\d\d-\d{4}(-\d+)?\.txt$/;
/** A 40 KB log: over the 32 KB line, so it becomes a tile. */
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

/** The window's upload (api.ts uploadFile): an XMLHttpRequest, carried over loopback with the file's bytes. */
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
  // The DOM server keeps its own scratch HOME under the data dir: nothing here names one.
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '7'], {
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
  savedXhr = (globalThis as Record<string, unknown>).XMLHttpRequest;
  (globalThis as Record<string, unknown>).XMLHttpRequest = LoopbackXhr;
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
  (globalThis as Record<string, unknown>).XMLHttpRequest = savedXhr;
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

/** Typing: the field's new value and its `input` (with the `beforeinput` a browser sends first). */
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

/** The browser's undo (⌘Z, Edit → Undo) as the page sees it: a `beforeinput` of type historyUndo. True when the page took it. */
function browserUndo(text: HTMLTextAreaElement): boolean {
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'inputType', { value: 'historyUndo' });
  act(() => {
    text.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** A paste of plain text on `target`. Returns whether the browser's own paste was prevented. */
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
  // Under the line: text, as before.
  const short = 'x'.repeat(32 * 1024 - 1);
  expect(paste(text, short)).toBe(false);
  expect(pastedTiles(el)).toHaveLength(0);

  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(el).length === 1, 'the tile');
  const tile = pastedTiles(el)[0]!;
  expect(tile.getAttribute('data-compose-file-name')).toMatch(PASTED);
  // Its name is the paste's first words; the box's words are untouched.
  expect(tile.querySelector('.ib-pt-nm')?.textContent).toBe(LOG.split('\n')[0]);
  expect(text.value).toBe(BEFORE + AFTER);
  await until(() => el.querySelector('[data-fold-live]')?.textContent?.startsWith('Attached pasted-text-') === true, 'the announcement');

  // Words typed before the paste's place meanwhile: the paste still goes back between "run." and " The third".
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
  // "OLD WORDS" selected: the paste takes their place.
  act(() => text.setSelectionRange(BEFORE.length + 1, BEFORE.length + 1 + 'OLD WORDS'.length));
  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(el).length === 1 && text.value === `${BEFORE} ${AFTER}`, 'the tile, the selection gone');
  const tile = () => pastedTiles(el)[0]!;
  expect(tile().querySelector('[data-pasted-undo]')).not.toBeNull();
  expect(tile().querySelector('[data-pasted-put-back]')).toBeNull();

  await wait(10_200);
  expect(tile().querySelector('[data-pasted-undo]')).toBeNull();
  expect(tile().querySelector('[data-pasted-line]')?.textContent).toContain('Put back in box');
  // Typed after the paste's place: those words stay after it.
  type(text, `${BEFORE} ${AFTER} Thanks.`, `${BEFORE} ${AFTER} Thanks.`.length);
  act(() => (tile().querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  expect(text.value).toBe(`${BEFORE} ${LOG}${AFTER} Thanks.`);
  expect(text.selectionStart).toBe(`${BEFORE} ${LOG}`.length);
}, 40_000);

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

  // Again, then a word typed: the next undo is the browser's own, and the tile stays.
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

  // Put back in New message: at the caret, between the words.
  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(dialog()).length === 1, 'the tile');
  act(() => (pastedTiles(dialog())[0]!.querySelector('[data-pasted-undo]') as HTMLButtonElement).click());
  expect(text.value).toBe(BEFORE + LOG + AFTER);
  expect(text.selectionStart).toBe((BEFORE + LOG).length);

  // The thread-name chip: 32 KB is not a name, and goes to the message as a tile, not as words.
  type(text, '');
  const chip = dialog().querySelector('input[aria-label="Thread name"]') as HTMLInputElement;
  expect(paste(chip, LOG)).toBe(true);
  await until(() => pastedTiles(dialog()).length === 1, 'the chip paste as a tile');
  expect(text.value).toBe('');
  expect(dialog().querySelector('[data-compose-thread-name-note]')?.textContent).toContain('attached');

  // Only the tile, no words: it is sent, as a reply of files is.
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
  // No agent is live in this world's project, so the dialog offers Save draft.
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
