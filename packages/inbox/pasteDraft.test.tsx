/**
 * A long paste kept in a draft (approval "inbox-paste-attachment", PR 2): the
 * whole window (InboxApp) over a REAL Inbox server in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts), its fetches and uploads carried
 * to it over loopback. What is proved:
 *  - the reply draft keeps the pasted tile beside the words, with its place;
 *    after a reload the tile is back and Put back puts the exact text there
 *    (read from its upload), the words around untouched, the caret after it,
 *    and the draft then holds the words alone;
 *  - another window's save (`event: drafts`) brings its tile into a box with
 *    no edits, and Put back works there;
 *  - a reply draft of the paste alone goes with the Send from a closed box;
 *  - a reopened New message draft offers Put back too;
 *  - a paste still uploading stays when another window saves the draft;
 *  - one paste's upload gone: the draft keeps the others, and the restart
 *    guard asks for the paste no draft holds (and for one still uploading);
 *  - a Put back that cannot read the paste says so and keeps the tile;
 *  - a CRLF paste read back goes into the box with `\n` line ends.
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
import type { InboxMessage, InboxReplyDraft, InboxUpload } from '@plannotator/core/inbox-types';

import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
/** The update control's restart guard: what a restart would lose (null: nothing). */
const { unsentReply } = (hasDom ? await import('./unsent') : {}) as typeof import('./unsent');
const { DRAFT_NOT_SAVED_FAILED } = (hasDom ? await import('./components/DraftLabel') : {}) as typeof import('./components/DraftLabel');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
/** A 40 KB log: over the 32 KB line, so it becomes a tile. */
const LOG = Array.from({ length: 800 }, (_, i) => `2026-11-01T21:10:${String(i % 60).padStart(2, '0')}Z worker retry ${i} charged`).join('\n') + '\n';
const BEFORE = 'Here is the log from the failing run.';
const AFTER = ' The third retry is the one that charged twice.';

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
/** The window's event streams (a stand-in EventSource), to hand it an `event: drafts`. */
let streams: { listeners: Map<string, ((event: { data: string }) => void)[]> }[] = [];
function emit(type: string, data: unknown) {
  for (const stream of streams) for (const listener of stream.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
}

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

/** Uploads wait for `release()` while set: a paste still uploading. */
let heldUploads: { promise: Promise<void>; release: () => void } | null = null;
/** While set, a paste's text read (`GET uploads/:id/text`) fails as an Inbox that cannot answer would (502). */
let failTextReads = false;
/** The statuses of the window's draft saves, in order. */
const statuses: number[] = [];
/** A POST that `match`es waits for `wait` before it reaches the Inbox (a slow link). */
let gate: { match: (path: string, body: string) => boolean; wait: Promise<void> } | null = null;
/** This test's fetch calls not answered yet: afterEach waits for none before the real fetch is back. */
let inflight = 0;
/** While set, every reply-draft save gets no answer (an Inbox that stopped answering); reads still answer. */
let dropDraftSaves = false;
function holdUploads() {
  let release = () => {};
  const promise = new Promise<void>((done) => (release = done));
  heldUploads = { promise, release: () => ((heldUploads = null), release()) };
  return heldUploads;
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
      // An upload still on its way while the test holds it (`holdUploads`).
      if (heldUploads) await heldUploads.promise;
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-paste-draft-dom-')));
  // The DOM server uses the scratch HOME it inherits from the preload: nothing here names one.
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '12'], {
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
      if (failTextReads && /\/uploads\/[^/]+\/text$/.test(path)) {
        return new Response(JSON.stringify({ code: 'forward_failed', error: 'The Inbox could not answer.' }), { status: 502 });
      }
      if (dropDraftSaves && method === 'POST' && path.endsWith('/draft')) throw new TypeError('Failed to fetch');
      if (gate && method === 'POST' && gate.match(path, body ?? '')) await gate.wait;
      const answer = await loopback(path, method, body);
      if (method === 'POST' && path.includes('/draft')) statuses.push(answer.status);
      return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    } finally {
      inflight -= 1;
    }
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  streams = [];
  (globalThis as Record<string, unknown>).EventSource = class {
    listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor() {
      streams.push(this);
    }
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {}
  };
  savedXhr = (globalThis as Record<string, unknown>).XMLHttpRequest;
  (globalThis as Record<string, unknown>).XMLHttpRequest = LoopbackXhr;
  posted = [];
  window.location.hash = '';
});

afterEach(async () => {
  if (!hasDom) return;
  heldUploads?.release();
  unmount();
  // Leaving the thread saves what waits at once: that save (and its read-back) is answered by this test's Inbox
  // before the real fetch is back. On the real fetch it fails (a relative URL), and a save that did not land
  // marks its thread "not saved" in module state, so the next test would start with the restart guard asking.
  await requestsSettled();
  globalThis.fetch = savedFetch;
  failTextReads = false;
  dropDraftSaves = false;
  gate = null;
  statuses.length = 0;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  (globalThis as Record<string, unknown>).XMLHttpRequest = savedXhr;
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

/**
 * No request of this test is in flight, on two reads a macrotask apart: the draft's saves chain on microtasks,
 * so a save queued behind an answer has started its request by the second read.
 */
async function requestsSettled() {
  // About 5 s, so a slow runner still settles.
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
    setter.call(text, words);
    text.setSelectionRange(caret, caret);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function paste(target: HTMLElement, words: string): boolean {
  const items = [{ kind: 'string', type: 'text/plain', getAsFile: () => null }];
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [], items, types: ['text/plain'], getData: (t: string) => (t === 'text/plain' ? words : '') } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const pastedTiles = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[data-pasted-text]')];
const replyBox = (el: HTMLElement) => el.querySelector('.ib-rbox') as HTMLElement | null;
const replyText = (el: HTMLElement) => replyBox(el)?.querySelector('textarea') as HTMLTextAreaElement | null;

async function openReply(el: HTMLElement): Promise<HTMLTextAreaElement> {
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  return replyText(el)!;
}

async function serverDraft(): Promise<InboxReplyDraft | null> {
  return (JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}/draft`)).text) as { draft: InboxReplyDraft | null }).draft;
}

async function serverSession(): Promise<string> {
  return (JSON.parse((await loopback('/api/inbox/health')).text) as { serverSession: string }).serverSession;
}

test.skipIf(!hasDom)('the reply draft keeps the tile; after a reload it is back, and Put back puts the exact text where it was, caret after it', async () => {
  let el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, LOG)).toBe(true);
  // Saved with the words, the tile's upload and its place between them.
  await until(async () => (await serverDraft())?.files?.length === 1, 'the draft with the paste');
  const saved = (await serverDraft())!;
  expect(saved.body).toBe(BEFORE + AFTER);
  expect(saved.files![0]!.pasted!.at).toBe(BEFORE.length);
  const name = saved.files![0]!.name;

  // A reload: the window again, the box back with its words and the tile, past its Undo.
  unmount();
  el = await renderApp(`#thread=${world.waiting}`);
  await until(() => replyBox(el) !== null && pastedTiles(el).length === 1, 'the box and its tile');
  const tile = pastedTiles(el)[0]!;
  expect(tile.getAttribute('data-compose-file-name')).toBe(name);
  expect(tile.hasAttribute('data-pasted-fresh')).toBe(false);
  expect(tile.querySelector('.ib-pt-nm')?.textContent).toBe(LOG.split('\n')[0]);
  const again = replyText(el)!;
  expect(again.value).toBe(BEFORE + AFTER);

  // Words typed before its place meanwhile: it still goes back between "run." and " The third".
  type(again, `Hi. ${BEFORE}${AFTER}`, 4 + BEFORE.length);
  act(() => (tile.querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  await until(() => pastedTiles(el).length === 0, 'the words back');
  expect(again.value).toBe(`Hi. ${BEFORE}${LOG}${AFTER}`);
  expect(document.activeElement).toBe(again);
  expect(again.selectionStart).toBe(`Hi. ${BEFORE}${LOG}`.length);
  // The draft holds the words alone now.
  await until(async () => {
    const now = await serverDraft();
    return now?.body === `Hi. ${BEFORE}${LOG}${AFTER}` && now.files === undefined;
  }, 'the draft without the paste');
}, 30_000);

test.skipIf(!hasDom)("another window's save brings its tile into a box with no edits; Put back works there", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  expect(text.value).toBe('');
  // The other window: the paste uploaded, the draft saved with it.
  const session = await serverSession();
  const upload = JSON.parse((await loopback(`/api/inbox/uploads?name=pasted-text-other.txt&serverSession=${session}`, 'POST', Buffer.from(LOG), { 'Content-Type': 'application/octet-stream' })).text) as {
    upload: InboxUpload;
  };
  const saved = await loopback(
    `/api/inbox/threads/${world.waiting}/draft`,
    'POST',
    JSON.stringify({ serverSession: session, body: BEFORE + AFTER, base: null, files: [{ upload_id: upload.upload.upload_id, pasted: { at: BEFORE.length, preview: 'From the other window' } }] }),
  );
  expect(saved.status).toBe(200);
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-restore]') !== null, 'the offer');
  act(() => (el.querySelector('[data-draft-restore]') as HTMLButtonElement).click());
  await until(() => pastedTiles(el).length === 1 && replyText(el)?.value === BEFORE + AFTER, 'the other window\'s draft');
  expect(pastedTiles(el)[0]!.querySelector('.ib-pt-nm')?.textContent).toBe('From the other window');
  act(() => (pastedTiles(el)[0]!.querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  await until(() => pastedTiles(el).length === 0, 'the words back');
  expect(replyText(el)!.value).toBe(BEFORE + LOG + AFTER);
  expect(replyText(el)!.selectionStart).toBe((BEFORE + LOG).length);
}, 30_000);

test.skipIf(!hasDom)('a draft of the paste alone whose save gets no answer says "Not saved", and the restart guard asks; the next save that lands holds the file', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  dropDraftSaves = true;
  expect(paste(text, LOG)).toBe(true);
  // No words in the box: the file is what the save carried, and it did not land.
  await until(() => el.querySelector('[data-draft-head][data-draft-failed]') !== null, 'Not saved');
  expect(el.querySelector('[data-draft-head] .ib-draft-saved')?.textContent).toBe(DRAFT_NOT_SAVED_FAILED);
  expect(replyText(el)!.value).toBe('');
  expect(unsentReply()).not.toBeNull();
  // The Inbox answers again; the next key saves, with the file.
  dropDraftSaves = false;
  type(replyText(el)!, 'x');
  await until(() => el.querySelector('[data-draft-head][data-draft-failed]') === null, 'Not saved cleared');
  await until(async () => (await serverDraft())?.files?.length === 1, 'the draft with the file');
  await until(() => unsentReply() === null, 'the guard at rest');
}, 30_000);

test.skipIf(!hasDom)('a draft of the paste alone, its box closed, goes with the Send and the draft is done', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  expect(paste(text, LOG)).toBe(true);
  await until(async () => (await serverDraft())?.files?.length === 1, 'the draft of the paste');
  const name = (await serverDraft())!.files![0]!.name;
  // Closing the box (its chevron) keeps it as the draft.
  act(() => (el.querySelector('[data-reply-close]') as HTMLButtonElement).click());
  await until(() => replyBox(el) === null, 'the box closed');
  expect((await serverDraft())?.files?.length).toBe(1);
  // The foot's Send carries the kept paste.
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Send'), 'the foot\'s Send');
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  const reply = posted.find((p) => p.path.endsWith('/reply'))!;
  expect((reply.body.uploads as string[]).length).toBe(1);
  expect(typeof reply.body.clear_draft).toBe('string');
  await until(async () => (await serverDraft()) === null, 'the draft done');
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  const sent = model.thread.messages.at(-1)!;
  expect(sent.attachments!.map((a) => a.name)).toEqual([name]);
  expect(readFileSync(sent.attachments![0]!.path, 'utf8')).toBe(LOG);
}, 30_000);

test.skipIf(!hasDom)('a reopened New message draft offers Put back: the exact text back where it was, caret after it', async () => {
  // No agent is live in this world's project, so the dialog offers Save draft.
  let el = await renderApp();
  act(() => (el.querySelector('.ib-side [data-open-compose]') as HTMLButtonElement).click());
  const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement | null;
  await until(() => !!dialog()?.querySelector('[data-compose-to]:not([data-loading])'), 'the sessions read');
  const text = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  type(text, BEFORE + AFTER, BEFORE.length);
  expect(paste(text, LOG)).toBe(true);
  await until(() => pastedTiles(dialog()!)[0]?.getAttribute('data-compose-file') === 'done', 'the upload');
  await until(() => !!dialog()!.querySelector('[data-compose-save]'), 'Save draft');
  act(() => (dialog()!.querySelector('[data-compose-save]') as HTMLButtonElement).click());
  await until(() => posted.some((p) => p.path.startsWith('/api/inbox/drafts/')), 'the draft saved');
  const savedFiles = posted.find((p) => p.path.startsWith('/api/inbox/drafts/'))!.body.files as { upload_id: string; pasted: { at: number } }[];
  expect(savedFiles[0]!.pasted.at).toBe(BEFORE.length);

  // Another visit: the Drafts page, the draft opened again.
  unmount();
  el = await renderApp('#drafts', '[data-drafts-page]');
  await until(() => !!el.querySelector('[data-draft-id] .ib-draft-open'), 'the draft row');
  act(() => (el.querySelector('[data-draft-id] .ib-draft-open') as HTMLButtonElement).click());
  await until(() => !!dialog() && pastedTiles(dialog()!).length === 1, 'the draft with its tile');
  const reopened = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  expect(reopened.value).toBe(BEFORE + AFTER);
  act(() => (pastedTiles(dialog()!)[0]!.querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  await until(() => pastedTiles(dialog()!).length === 0, 'the words back');
  expect(reopened.value).toBe(BEFORE + LOG + AFTER);
  expect(reopened.selectionStart).toBe((BEFORE + LOG).length);
}, 30_000);

/** A file uploaded and a draft saved as another window (or a phone) would: over loopback, never through this window. */
async function uploadAsOther(name: string, words: string): Promise<InboxUpload> {
  const session = await serverSession();
  const answer = await loopback(`/api/inbox/uploads?name=${name}&serverSession=${session}`, 'POST', Buffer.from(words), { 'Content-Type': 'application/octet-stream' });
  return (JSON.parse(answer.text) as { upload: InboxUpload }).upload;
}
/** A phone's Send carrying `uploads` (no `clear_draft`: the draft stays, and the server drops those uploads from it). */
async function phoneSend(uploads: string[]) {
  const answer = await loopback(
    `/api/inbox/messages/${world.waiting}/reply`,
    'POST',
    JSON.stringify({ serverSession: await serverSession(), idempotency_key: `phone-${crypto.randomUUID()}`, words: 'From the phone', uploads }),
  );
  expect(answer.status).toBe(200);
}

test.skipIf(!hasDom)("a paste still uploading stays when another window saves the draft, and Put back still puts it where it was", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, BEFORE + AFTER, BEFORE.length);
  await until(async () => (await serverDraft())?.body === BEFORE + AFTER, 'the words saved');
  const held = holdUploads();
  expect(paste(text, LOG)).toBe(true);
  expect(pastedTiles(el)[0]?.getAttribute('data-compose-file')).toBe('uploading');
  // While it uploads, another window adds a sentence to the same draft.
  const base = (await serverDraft())!.updated_at;
  const theirs = `${BEFORE}${AFTER} Thanks.`;
  const saved = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ serverSession: await serverSession(), body: theirs, base }));
  expect(saved.status).toBe(200);
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-restore]') !== null, 'the offer');
  act(() => (el.querySelector('[data-draft-restore]') as HTMLButtonElement).click());
  await until(() => replyText(el)?.value === theirs, "the other window's words");
  // The paste is still here, still uploading: nothing of it was lost.
  expect(pastedTiles(el).length).toBe(1);
  held.release();
  // Uploaded, it joins the draft beside the other window's words.
  await until(async () => (await serverDraft())?.files?.length === 1, 'the paste saved');
  expect((await serverDraft())!.body).toBe(theirs);
  // Within its 10 s the tile offers Undo, which puts it back as Put back does.
  act(() => (pastedTiles(el)[0]!.querySelector('[data-pasted-undo]') as HTMLButtonElement).click());
  await until(() => pastedTiles(el).length === 0, 'the words back');
  expect(replyText(el)!.value).toBe(`${BEFORE}${LOG}${AFTER} Thanks.`);
  expect(replyText(el)!.selectionStart).toBe((BEFORE + LOG).length);
}, 30_000);

test.skipIf(!hasDom)('one paste a phone sent: the draft and the box keep the others, and the next save never names it again', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, BEFORE + AFTER, BEFORE.length);
  const held = holdUploads();
  expect(paste(text, LOG)).toBe(true);
  // Still uploading: a restart would lose it, so the guard asks.
  expect(unsentReply()).not.toBeNull();
  held.release();
  // Uploaded and saved in the draft: a restart loses nothing, the guard asks nothing.
  await until(async () => (await serverDraft())?.files?.length === 1, 'the first paste saved');
  await until(() => unsentReply() === null, 'the guard at rest');
  const second = `${LOG}second\n`;
  text.setSelectionRange((BEFORE + AFTER).length, (BEFORE + AFTER).length);
  expect(paste(text, second)).toBe(true);
  await until(async () => (await serverDraft())?.files?.length === 2, 'both pastes saved');
  await until(() => unsentReply() === null, 'the guard at rest again');
  const [first, kept] = (await serverDraft())!.files!.map((file) => file.upload_id);

  // A phone's Send carries the first paste: its upload is no longer pending, and the server's draft drops it.
  await phoneSend([first!]);
  // The next save here changes the words only: the draft keeps the second paste, and the box follows the draft (the
  // first paste is an attachment of the phone's reply now, not this box's to send again).
  type(replyText(el)!, `${BEFORE}${AFTER} Thanks.`);
  await until(async () => (await serverDraft())?.body === `${BEFORE}${AFTER} Thanks.`, 'the words saved');
  expect((await serverDraft())!.files?.map((file) => file.upload_id)).toEqual([kept!]);
  await until(() => pastedTiles(el).length === 1, 'the sent paste out of the box');
  await until(() => unsentReply() === null, 'the guard at rest after the phone sent one');
  const before = posted.length;
  type(replyText(el)!, `${BEFORE}${AFTER} Thanks!`);
  await until(async () => (await serverDraft())?.body === `${BEFORE}${AFTER} Thanks!`, 'one more key saved');
  expect(posted.slice(before).some((p) => JSON.stringify(p.body).includes(first!))).toBe(false);
  expect((await serverDraft())!.files?.map((file) => file.upload_id)).toEqual([kept!]);
}, 30_000);

test.skipIf(!hasDom)('a Put back that cannot read the paste says so, and the tile and the words stay', async () => {
  // Another window's draft names a paste; reading its words back then fails (the Inbox cannot answer).
  const upload = await uploadAsOther('pasted-text-gone.txt', LOG);
  const saved = await loopback(
    `/api/inbox/threads/${world.waiting}/draft`,
    'POST',
    JSON.stringify({ serverSession: await serverSession(), body: BEFORE + AFTER, base: null, files: [{ upload_id: upload.upload_id, pasted: { at: BEFORE.length, preview: 'The gone paste' } }] }),
  );
  expect(saved.status).toBe(200);
  failTextReads = true;
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => replyBox(el) !== null && pastedTiles(el).length === 1, 'the box and its tile');
  act(() => (pastedTiles(el)[0]!.querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  await until(() => !!pastedTiles(el)[0]?.querySelector('[role="alert"]'), 'the error');
  expect(pastedTiles(el)[0]!.querySelector('[role="alert"]')!.textContent).toContain('could not be read back');
  expect(pastedTiles(el).length).toBe(1);
  expect(replyText(el)!.value).toBe(BEFORE + AFTER);
}, 30_000);

test.skipIf(!hasDom)('a draft brought back with a CRLF paste: Put back gives the box `\\n` line ends, the caret right after them', async () => {
  const upload = await uploadAsOther('pasted-text-crlf.txt', LOG.replace(/\n/g, '\r\n'));
  const saved = await loopback(
    `/api/inbox/threads/${world.waiting}/draft`,
    'POST',
    JSON.stringify({ serverSession: await serverSession(), body: BEFORE + AFTER, base: null, files: [{ upload_id: upload.upload_id, pasted: { at: BEFORE.length, preview: 'The CRLF log' } }] }),
  );
  expect(saved.status).toBe(200);
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => replyBox(el) !== null && pastedTiles(el).length === 1, 'the box and its tile');
  act(() => (pastedTiles(el)[0]!.querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  await until(() => pastedTiles(el).length === 0, 'the words back');
  expect(replyText(el)!.value).toBe(BEFORE + LOG + AFTER);
  expect(replyText(el)!.selectionStart).toBe((BEFORE + LOG).length);
}, 30_000);

test.skipIf(!hasDom)("the phone's long paste, taken into this box after this window changed the words, goes back where the phone put it", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, 'Hello world');
  await until(async () => (await serverDraft())?.body === 'Hello world', 'the words saved');
  // The phone pastes its log between "Hello " and "world" (a tile: the words do not change).
  const log = await uploadAsOther('pasted-text-phone.txt', LOG);
  const base = (await serverDraft())!.updated_at;
  const saved = await loopback(
    `/api/inbox/threads/${world.waiting}/draft`,
    'POST',
    JSON.stringify({ serverSession: await serverSession(), body: 'Hello world', base, base_body: 'Hello world', files_add: [{ upload_id: log.upload_id, pasted: { at: 6, preview: 'log' } }], files_remove: [], files_place: [] }),
  );
  expect(saved.status).toBe(200);
  // Before this window hears of it, the person puts "Oh. " in front: the save lands (its own words), and the box takes the tile.
  type(replyText(el)!, 'Oh. Hello world', 0);
  await until(async () => (await serverDraft())?.body === 'Oh. Hello world', 'the words saved');
  await until(() => pastedTiles(el).length === 1, "the phone's tile in the box");
  act(() => (pastedTiles(el)[0]!.querySelector('[data-pasted-put-back]') as HTMLButtonElement).click());
  await until(() => pastedTiles(el).length === 0, 'the words back');
  expect(replyText(el)!.value).toBe('Oh. Hello ' + LOG + 'world');
}, 30_000);

/** The save that adds a long paste is held on its way until `release()`. */
function holdPasteSave() {
  let release = () => {};
  const wait = new Promise<void>((done) => (release = done));
  const state = { held: false };
  gate = { match: (path, body) => path.includes('/draft') && !state.held && body.includes('"files_add":[{') && (state.held = true), wait };
  return { held: () => state.held, release: () => ((gate = null), release()) };
}
/** Another window saves the words alone (over loopback), a step after this window's last save. */
async function phoneWords(body: string, baseBody: string) {
  const base = (await serverDraft())!.updated_at;
  const phone = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ serverSession: await serverSession(), body, base, base_body: baseBody, files_add: [], files_remove: [], files_place: [] }));
  expect(phone.status).toBe(200);
}
const settle = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

test.skipIf(!hasDom)("a long paste here while the phone shortens the words: its save goes in at its place in the phone's words, never refused for the old one", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  const LONG = 'Here is a longer sentence before the log: ';
  type(text, LONG);
  await until(async () => (await serverDraft())?.body === LONG, 'the words saved');
  const slow = holdPasteSave();
  expect(paste(replyText(el)!, LOG)).toBe(true);
  await until(slow.held, 'the paste save held');
  await phoneWords('Hi', LONG);
  statuses.length = 0;
  slow.release();
  await until(async () => (await serverDraft())?.files?.length === 1, 'the paste saved');
  await settle(800);
  expect(statuses).not.toContain(422);
  const draft = (await serverDraft())!;
  expect(draft.body).toBe('Hi');
  // Its place was the end of the old words: the end of the phone's.
  expect(draft.files!.map((file) => file.pasted?.at)).toEqual([2]);
  expect(replyText(el)!.value).toBe('Hi');
  expect(unsentReply()).toBeNull();
  // The next key keeps the tile where the box shows it.
  type(replyText(el)!, 'Hi there');
  await until(async () => (await serverDraft())?.body === 'Hi there', 'the next words saved');
  expect((await serverDraft())!.files!.map((file) => file.pasted?.at)).toEqual([2]);
}, 30_000);

test.skipIf(!hasDom)("a long paste here while the phone puts words in front: it goes in where it was in the words, moved with them", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, 'Hello world', 6);
  await until(async () => (await serverDraft())?.body === 'Hello world', 'the words saved');
  const slow = holdPasteSave();
  expect(paste(replyText(el)!, LOG)).toBe(true);
  await until(slow.held, 'the paste save held');
  await phoneWords('Oh. Hello world', 'Hello world');
  slow.release();
  await until(async () => (await serverDraft())?.files?.length === 1, 'the paste saved');
  await settle(800);
  const draft = (await serverDraft())!;
  expect(draft.body).toBe('Oh. Hello world');
  // Between "Hello " and "world", in the phone's words too.
  expect(draft.files!.map((file) => file.pasted?.at)).toEqual([10]);
  // Put back puts the text there.
  act(() => (pastedTiles(el)[0]!.querySelector('.ib-pt-act') as HTMLButtonElement).click());
  await until(() => pastedTiles(el).length === 0, 'the words back');
  expect(replyText(el)!.value).toBe('Oh. Hello ' + LOG + 'world');
}, 30_000);
