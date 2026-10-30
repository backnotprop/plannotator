/**
 * Paste to attach, as the window does it (the owner: "I need to be able to
 * paste in as well when I'm in the new message or if I'm focused in a
 * reply"): the whole window (InboxApp) over a REAL Inbox server in a temp
 * data dir (its own process, tests/helpers/inbox-dom-server.ts), its fetches
 * and its uploads (XMLHttpRequest) carried to it over loopback. What is
 * proved: a paste carrying an image in compose, or in the reply box, makes a
 * tile named `pasted-image-<date>-<time>.png`, the upload lands on the
 * server, and Send carries it (the thread's attachment, the reply's
 * attachment on the message that carries the words); a reply of a pasted
 * image alone is sent as a words-only reply; a paste of text alone makes no
 * tile and is left to the browser, as is text copied from a spreadsheet with
 * the picture Chromium adds beside it; Cancel forgets the reply box's files;
 * a file pasted while a Send is in flight stays for the next one; a retry
 * whose contents changed is a new reply, never the earlier one replayed; and
 * each attach by paste is said in a polite live region. On a phone (iOS
 * offers no Paste for a picture in a plain text field) the reply box's
 * paperclip names its file as a paste is; and an image copied from a page with
 * only its link as the text attaches. The reply box's paperclip and a drop on
 * the box add tiles, a drop anywhere over the thread opens a closed reply box
 * with the files, a drag of text or one that started on the page attaches
 * nothing, a drop on New message adds a tile, and Send carries them
 * (approval "inbox-reply-attach").
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxMessage } from '@plannotator/core/inbox-types';

import { NO_BROWSER } from '../../tests/helpers/no-browser';
import { PHONE_QUERY } from './phone';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308060000009d74c6e10000000d49444154789c636060000000040001f61738550000000049454e44ae426082', 'hex');
const PASTED = /^pasted-image-\d{4}-\d\d-\d\d-\d{4}(-\d+)?\.png$/;

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
/** While set, a reply POST waits for it before it reaches the server (a Send in flight). */
let replyGate: Promise<void> | null = null;
/** Set: the next reply POST reaches the server, and the window is told it failed (it went through). */
let replyFailsAfter = false;
/** The Inbox is down: a reply and a thread read fail before reaching it. */
let inboxDown = false;

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-paste-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '10'], {
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
    const isReply = method === 'POST' && path.endsWith('/reply');
    if (inboxDown && (isReply || /\/api\/inbox\/threads\/[^/?]+$/.test(path))) throw new TypeError('Failed to fetch');
    if (isReply && replyGate) await replyGate;
    const answer = await loopback(path, method, body);
    if (isReply && replyFailsAfter) {
      replyFailsAfter = false;
      return new Response(JSON.stringify({ error: 'The connection dropped.' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
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
  inboxDown = false;
  replyFailsAfter = false;
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

function type(text: HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const image = (name = 'image.png') => new File([PNG], name, { type: 'image/png' });

/**
 * A paste on `target`, carrying `files` (a screenshot: a file item) and/or
 * text. Returns whether the browser's own paste was prevented.
 */
function paste(target: HTMLElement, content: { files?: File[]; text?: string; html?: string }): boolean {
  const files = content.files ?? [];
  const items = [
    ...(content.text !== undefined ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : []),
    ...(content.html !== undefined ? [{ kind: 'string', type: 'text/html', getAsFile: () => null }] : []),
    ...files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  ];
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items, types: items.map((i) => i.type), getData: (type: string) => (type === 'text/html' ? (content.html ?? '') : type === 'text/plain' ? (content.text ?? '') : '') } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const tiles = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[data-compose-file]')];

const replyBox = (el: HTMLElement) => el.querySelector('.ib-rbox') as HTMLElement | null;

/**
 * A drag event on `target` carrying `files` (a drag from the file manager) or,
 * with `text`, a drag of selected text or a link. Returns whether the page took
 * it (`preventDefault`: a drop target said yes).
 */
function drag(target: Element, type: 'dragenter' | 'dragover' | 'drop', content: { files?: File[]; text?: string }): boolean {
  const files = content.files ?? [];
  const types = [...(content.text !== undefined ? ['text/plain'] : []), ...(files.length > 0 ? ['Files'] : [])];
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types, dropEffect: 'none', getData: (t: string) => (t === 'text/plain' ? (content.text ?? '') : '') } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** Choose `files` with an `<input type="file">` (the paperclip). */
function choose(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const markdown = (name: string) => new File(['# Q3 export\n\nThe currency column is gone.\n'], name, { type: 'text/markdown' });

test.skipIf(!hasDom)('compose: a pasted image makes a tile with a dated name, uploads, and rides the Send; a text paste stays text', async () => {
  const projects = JSON.parse((await loopback('/api/inbox/projects')).text) as { projects: { id: string; root: string }[] };
  await poll('ses-paste', 'pi', projects.projects.find((p) => p.id === world.project)!.root);
  const el = await renderApp();
  act(() => (el.querySelector('.ib-side [data-open-compose]') as HTMLButtonElement).click());
  const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement;
  // A plain New message opens with To empty: pick the session, as a person does.
  await until(() => !!dialog()?.querySelector('button[data-compose-to="choose"]:not([data-loading])'), 'To loaded');
  act(() => (dialog().querySelector('button[data-compose-to]') as HTMLButtonElement).click());
  await until(() => !!dialog().querySelector('[role="option"][data-compose-session="ses-paste"]'), 'the picker');
  act(() => (dialog().querySelector('[role="option"][data-compose-session="ses-paste"]') as HTMLElement).click());
  await until(() => !!dialog()?.querySelector('[data-compose-to="ses-paste"]'), 'To picked');
  const text = dialog().querySelector('textarea') as HTMLTextAreaElement;

  expect(paste(text, { text: 'just words' })).toBe(false);
  expect(tiles(dialog())).toHaveLength(0);
  // A cell copied in a spreadsheet: its text and the picture Chromium adds. The text is the paste; nothing attaches.
  expect(paste(text, { text: 'Q3\t1,204\t+8%', files: [image()] })).toBe(false);
  expect(tiles(dialog())).toHaveLength(0);

  // A screenshot: an image and no text. The window takes it; the browser pastes nothing.
  expect(paste(text, { files: [image()] })).toBe(true);
  await until(() => tiles(dialog())[0]?.getAttribute('data-compose-file') === 'done', 'the upload');
  const name = tiles(dialog())[0]!.getAttribute('data-compose-file-name')!;
  expect(name).toMatch(PASTED);
  // Said in the dialog's own polite region (the window's sits outside the modal dialog).
  await until(() => dialog().querySelector('[data-compose-paste-live]')?.textContent === `Attached ${name}`, 'the announcement');
  expect(dialog().querySelector('[data-compose-paste-live]')?.getAttribute('aria-live')).toBe('polite');

  // A drop on the dialog (the shared useFileDrop): a text drag is not taken; files show "Drop files to attach"
  // and the drop adds a tile with the file's own name.
  expect(drag(dialog(), 'dragover', { text: 'some words' })).toBe(false);
  expect(dialog().querySelector('.ib-cp-drop')).toBeNull();
  expect(drag(text, 'dragover', { files: [markdown('legend-notes.md')] })).toBe(true);
  expect(dialog().querySelector('.ib-cp-drop')).not.toBeNull();
  expect(drag(text, 'drop', { files: [markdown('legend-notes.md')] })).toBe(true);
  expect(dialog().querySelector('.ib-cp-drop')).toBeNull();
  await until(() => tiles(dialog()).length === 2 && tiles(dialog()).every((t) => t.getAttribute('data-compose-file') === 'done'), 'the dropped file');
  expect(tiles(dialog())[1]!.getAttribute('data-compose-file-name')).toBe('legend-notes.md');

  type(text, 'This is what the legend looks like.');
  act(() => (dialog().querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => document.querySelector('dialog[data-compose]') === null, 'compose closed');
  const sent = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect((sent.body.uploads as string[]).length).toBe(2);
  const threads = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: { threads: { thread_id: string; subject: string }[] }[] };
  const started = threads.sections.flatMap((s) => s.threads).find((t) => t.subject === 'This is what the legend looks like')!;
  const model = JSON.parse((await loopback(`/api/inbox/threads/${started.thread_id}`)).text) as { thread: { messages: InboxMessage[] } };
  expect(model.thread.messages[0]!.attachments!.map((a) => a.name)).toEqual([name, 'legend-notes.md']);
  expect(model.thread.messages[0]!.attachments![0]!.kind).toBe('image');
}, 30_000);

test.skipIf(!hasDom)('the reply box: two pasted images make two tiles (the second name kept apart), a text paste none, and Send carries both on the reply', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  const text = replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement;

  // A spreadsheet cell whose value is a URL (its text, an HTML table, a picture of the cell): text, as before.
  const cellUrl = 'https://example.com/q3';
  expect(paste(text, { text: cellUrl, html: `<table><tr><td>${cellUrl}</td></tr></table>`, files: [image()] })).toBe(false);
  // Even an <img> of that very link: a desktop keeps today's rule (text with an unnamed picture is text).
  expect(paste(text, { text: cellUrl, html: `<img src="${cellUrl}">`, files: [image()] })).toBe(false);
  expect(el.querySelector('[data-reply-files]')).toBeNull();
  // Text alone (a dictation app's synthetic paste included): never prevented, nothing attached.
  expect(paste(text, { text: 'some words' })).toBe(false);
  expect(el.querySelector('[data-reply-files]')).toBeNull();
  // An image copied from a page brings HTML too: the image attaches and the browser's own paste still runs.
  expect(paste(text, { files: [image()], html: '<img src="x.png">' })).toBe(false);
  await until(() => tiles(replyBox(el)!).length === 1, 'the image beside text');
  act(() => (replyBox(el)!.querySelector('[data-compose-file] button') as HTMLButtonElement).click());
  expect(el.querySelector('[data-reply-files]')).toBeNull();

  expect(paste(text, { files: [image()] })).toBe(true);
  expect(paste(text, { files: [image('Pasted Graphic.png')] })).toBe(true);
  await until(() => tiles(replyBox(el)!).length === 2 && tiles(replyBox(el)!).every((t) => t.getAttribute('data-compose-file') === 'done'), 'both uploads');
  const names = tiles(replyBox(el)!).map((t) => t.getAttribute('data-compose-file-name')!);
  expect(names.every((n) => PASTED.test(n))).toBe(true);
  expect(new Set(names).size).toBe(2);
  await until(() => el.querySelector('[data-fold-live]')?.textContent === `Attached ${names[1]}`, 'the announcement');

  type(text, 'The legend overlaps the axis; see both.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect(replies[0]!.body).toMatchObject({ words: 'The legend overlaps the axis; see both.' });
  expect((replies[0]!.body.uploads as string[]).length).toBe(2);
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  const reply = model.thread.messages.at(-1)!;
  expect(reply.author.kind).toBe('person');
  expect(reply.attachments!.map((a) => a.name)).toEqual(names);
  // The sent reply shows them in the thread's read-only tiles.
  const replyTiles = () => [...el.querySelectorAll(`[data-message-article="${reply.id}"] .ib-att-t[data-attachment-id]`)].map((t) => t.getAttribute('data-attachment-name'));
  await until(() => replyTiles().length === 2, 'the reply\'s tiles');
  expect(replyTiles()).toEqual(names);
}, 30_000);

test.skipIf(!hasDom)('the reply box: a pasted image alone is sent as a words-only reply (questions stay open); Cancel forgets pasted files', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  expect(paste(replyBox(el)!.querySelector('textarea')!, { files: [image()] })).toBe(true);
  await until(() => tiles(replyBox(el)!).length === 1, 'the tile');
  // Cancel: the files go with the box.
  act(() => button(el, 'Cancel').click());
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box again');
  expect(el.querySelector('[data-reply-files]')).toBeNull();

  expect(paste(replyBox(el)!, { files: [image()] })).toBe(true);
  await until(() => tiles(replyBox(el)!)[0]?.getAttribute('data-compose-file') === 'done', 'the upload');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect(replies[0]!.body).toMatchObject({ words: '', questions: [] });
  expect(replies[0]!.body.skip).toBeUndefined();
  expect((replies[0]!.body.uploads as string[]).length).toBe(1);
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: (InboxMessage & { questions?: { state: string }[] })[] } };
  expect(model.thread.messages[0]!.questions!.map((q) => q.state)).toEqual(['open']);
  expect(model.thread.messages.at(-1)!.attachments).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)('a file pasted while a Send is in flight stays in the box for the next Send; only the files the Send carried go', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  const text = replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement;
  expect(paste(text, { files: [image()] })).toBe(true);
  await until(() => tiles(replyBox(el)!)[0]?.getAttribute('data-compose-file') === 'done', 'the first upload');
  const first = tiles(replyBox(el)!)[0]!.getAttribute('data-compose-file-name')!;
  type(text, 'First shot.');

  let open: () => void = () => {};
  replyGate = new Promise<void>((r) => (open = r));
  try {
    act(() => button(el, 'Send').click());
    await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send in flight');
    expect(paste(text, { files: [image()] })).toBe(true);
    await until(() => tiles(replyBox(el)!).length === 2 && tiles(replyBox(el)!)[1]!.getAttribute('data-compose-file') === 'done', 'the second upload');
    const second = tiles(replyBox(el)!)[1]!.getAttribute('data-compose-file-name')!;
    open();
    await until(() => tiles(replyBox(el) ?? document.createElement('div')).length === 1, 'the Send done');
    // The box stays, holding only the file pasted while the Send was in flight; its words went.
    expect(tiles(replyBox(el)!).map((t) => t.getAttribute('data-compose-file-name'))).toEqual([second]);
    expect((replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    const sent = posted.filter((p) => p.path.endsWith('/reply'));
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body.uploads as string[]).length).toBe(1);
    const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
    expect(model.thread.messages.at(-1)!.attachments!.map((a) => a.name)).toEqual([first]);

    // The next Send carries it.
    act(() => button(el, 'Send').click());
    await until(() => el.querySelector('.ib-rbox') === null, 'the second Send');
    const again = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
    expect(again.thread.messages.at(-1)!.attachments!.map((a) => a.name)).toEqual([second]);
  } finally {
    open();
    replyGate = null;
  }
}, 30_000);

test.skipIf(!hasDom)('a Send that went through but answered an error is read back: the box closes, and the reply is in the thread once', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  const text = replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement;
  type(text, 'Looks off.');
  replyFailsAfter = true;
  act(() => button(el, 'Send').click());
  // The reply went (its key is in the thread): finished as if the answer had come.
  await until(() => el.querySelector('.ib-rbox') === null, 'the box closed');
  expect(el.querySelector('.ib-error')).toBeNull();
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  expect(model.thread.messages.filter((m) => m.author.kind === 'person')).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)('a Send the Inbox never got, then a file pasted and the same words sent again: the file rides the new reply, never lost', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  const text = replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement;
  type(text, 'Here is the screen.');
  inboxDown = true;
  act(() => button(el, 'Send').click());
  await until(() => !!el.querySelector('.ib-error'), 'the error');
  inboxDown = false;
  // The person pastes the screenshot they meant to send, and sends the same words again.
  expect(paste(text, { files: [image()] })).toBe(true);
  await until(() => tiles(replyBox(el)!)[0]?.getAttribute('data-compose-file') === 'done', 'the upload');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect((reply.body.uploads as string[]).length).toBe(1);
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  const mine = model.thread.messages.filter((m) => m.author.kind === 'person');
  expect(mine).toHaveLength(1);
  expect(mine[0]!.body.startsWith('Here is the screen.')).toBe(true);
  expect(mine[0]!.attachments).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)('a phone: the reply box has an attach button; a chosen image uploads and rides the Send; an image copied from a page attaches, a spreadsheet cell holding a URL stays text', async () => {
  const savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === PHONE_QUERY,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    // A phone draws one screen at a time: the thread, no sidebar.
    const el = await renderApp(`#thread=${world.waiting}`, 'fieldset[data-question-key]');
    act(() => button(el, 'Reply').click());
    await until(() => replyBox(el) !== null, 'the reply box');
    const input = el.querySelector<HTMLInputElement>('input[type="file"][data-reply-attach]')!;
    expect(input).not.toBeNull();
    // The picker offers the photo library and Files; the button is named, with no native title.
    expect(input.accept).toBe('image/*,*/*');
    const label = input.closest('label')!;
    expect(label.getAttribute('aria-label')).toBe('Attach files');
    expect(label.hasAttribute('title')).toBe(false);
    Object.defineProperty(input, 'files', { configurable: true, value: [image('header.png')] });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => tiles(replyBox(el)!)[0]?.getAttribute('data-compose-file') === 'done', 'the chosen file\'s upload');
    expect(tiles(replyBox(el)!)[0]!.getAttribute('data-compose-file-name')).toBe('header.png');
    await until(() => el.querySelector('[data-fold-live]')?.textContent === 'Attached header.png', 'the announcement');

    const text = replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement;
    // A spreadsheet cell whose value is a URL: text on a phone too; nothing attaches.
    const link = 'https://example.com/board/header.png';
    expect(paste(text, { text: link, html: `<table><tr><td>${link}</td></tr></table>`, files: [image()] })).toBe(false);
    expect(tiles(replyBox(el)!)).toHaveLength(1);
    // An image copied from a page on a phone: the picture, its link as the plain text and an <img> of that link.
    // The picture attaches and the link is not pasted into the words.
    expect(paste(text, { files: [image()], text: link, html: `<img src="${link}">` })).toBe(true);
    await until(() => tiles(replyBox(el)!).length === 2 && tiles(replyBox(el)!).every((t) => t.getAttribute('data-compose-file') === 'done'), 'the pasted picture');

    type(text, 'The header on my phone.');
    act(() => button(el, 'Send').click());
    await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
    const replies = posted.filter((p) => p.path.endsWith('/reply'));
    expect(replies).toHaveLength(1);
    expect((replies[0]!.body.uploads as string[]).length).toBe(2);
    const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
    expect(model.thread.messages.at(-1)!.attachments!.map((a) => a.name)[0]).toBe('header.png');
    expect(model.thread.messages.at(-1)!.attachments).toHaveLength(2);
  } finally {
    window.matchMedia = savedMatchMedia;
  }
}, 30_000);

test.skipIf(!hasDom)('a desktop reply box: the paperclip in its toolbar and a drop on the box add tiles with their own names, a text drag attaches nothing, and Send carries them', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');

  // The paperclip is the first thing in the box's toolbar, the way to browse for any file.
  const input = replyBox(el)!.querySelector<HTMLInputElement>('.ib-rfoot > label:first-child input[type="file"][data-reply-attach]')!;
  expect(input).not.toBeNull();
  expect(input.closest('label')!.getAttribute('aria-label')).toBe('Attach files');
  expect(input.accept).toBe('');
  choose(input, [markdown('currency-notes.md')]);
  await until(() => tiles(replyBox(el)!)[0]?.getAttribute('data-compose-file') === 'done', 'the chosen file');
  // A desktop's file keeps its own name (a phone's is named as a paste is).
  expect(tiles(replyBox(el)!)[0]!.getAttribute('data-compose-file-name')).toBe('currency-notes.md');

  // A drag of selected text over the box: not taken, no outline.
  expect(drag(replyBox(el)!, 'dragover', { text: 'some words' })).toBe(false);
  expect(replyBox(el)!.hasAttribute('data-drop-over')).toBe(false);
  // Files dragged over the box: the box takes them and says so; the pane's own target stays off.
  expect(drag(replyBox(el)!, 'dragover', { files: [image('ledger-q3-export.png')] })).toBe(true);
  expect(replyBox(el)!.hasAttribute('data-drop-over')).toBe(true);
  expect(replyBox(el)!.querySelector('[data-box-drop]')).not.toBeNull();
  expect(el.querySelector('[data-pane-drop]')).toBeNull();
  expect(drag(replyBox(el)!, 'drop', { files: [image('ledger-q3-export.png')] })).toBe(true);
  expect(replyBox(el)!.hasAttribute('data-drop-over')).toBe(false);
  await until(() => tiles(replyBox(el)!).length === 2 && tiles(replyBox(el)!).every((t) => t.getAttribute('data-compose-file') === 'done'), 'the dropped file');
  const names = tiles(replyBox(el)!).map((t) => t.getAttribute('data-compose-file-name')!);
  expect(names).toEqual(['currency-notes.md', 'ledger-q3-export.png']);

  type(replyBox(el)!.querySelector('textarea') as HTMLTextAreaElement, 'Here is the Q3 export.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect((replies[0]!.body.uploads as string[]).length).toBe(2);
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  expect(model.thread.messages.at(-1)!.attachments!.map((a) => a.name)).toEqual(names);
}, 30_000);

test.skipIf(!hasDom)('files dropped anywhere over the thread with the reply closed open the reply box holding them; a text drag shows no target', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  expect(replyBox(el)).toBeNull();
  const pane = el.querySelector('section.ib-pane')!;
  // Over the agent's message, far from the closed reply: a link or text dragged is left alone.
  const message = el.querySelector('fieldset[data-question-key]')!;
  expect(drag(message, 'dragover', { text: 'https://example.com/q3' })).toBe(false);
  expect(pane.querySelector('[data-pane-drop]')).toBeNull();
  // A drag that started on the page (an image in a message dragged a little), even one a browser gives a Files
  // type: no target, nothing taken, until it ends.
  act(() => {
    message.dispatchEvent(new Event('dragstart', { bubbles: true }));
  });
  expect(drag(message, 'dragover', { files: [image('copy-of-a-tile.png')] })).toBe(false);
  expect(pane.querySelector('[data-pane-drop]')).toBeNull();
  expect(drag(message, 'drop', { files: [image('copy-of-a-tile.png')] })).toBe(false);
  act(() => {
    message.dispatchEvent(new Event('dragend', { bubbles: true }));
  });
  expect(replyBox(el)).toBeNull();
  // Files: the whole pane is the target.
  expect(drag(message, 'dragover', { files: [image('ledger-q3-export.png')] })).toBe(true);
  expect(pane.querySelector('[data-pane-drop]')).not.toBeNull();
  expect(drag(message, 'drop', { files: [image('ledger-q3-export.png')] })).toBe(true);
  expect(pane.querySelector('[data-pane-drop]')).toBeNull();
  // The drop opened the reply box with the file in it.
  await until(() => replyBox(el) !== null && tiles(replyBox(el)!)[0]?.getAttribute('data-compose-file') === 'done', 'the box with the dropped file');
  expect(tiles(replyBox(el)!).map((t) => t.getAttribute('data-compose-file-name'))).toEqual(['ledger-q3-export.png']);

  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('.ib-rbox') === null, 'the Send');
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect((replies[0]!.body.uploads as string[]).length).toBe(1);
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  expect(model.thread.messages.at(-1)!.attachments!.map((a) => a.name)).toEqual(['ledger-q3-export.png']);
}, 30_000);
