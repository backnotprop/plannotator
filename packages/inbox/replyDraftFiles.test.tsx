/**
 * Files attached to a reply box are part of its draft (the owner, 2026-11-02:
 * "ideally it just syncs"): the whole window (InboxApp) over a REAL Inbox
 * server in a temp data dir (its own process, tests/helpers/inbox-dom-server.ts),
 * its fetches and uploads carried to it over loopback. What is proved:
 *  - a file attached with the paperclip is saved in the draft beside the
 *    words: Cancel keeps it (Edit draft brings its tile back), and so does a
 *    reload;
 *  - another window's file comes into a box with no edits, and a file it
 *    removed goes; two windows adding files at once both keep theirs, with no
 *    "Keep mine / Discard" line, which only different words bring;
 *  - saves carry the box's file changes, not its list: a save held on its way
 *    (a slow phone link) keeps the other window's file; a file attached or
 *    removed meanwhile stays so, in the box and the draft; a file the other
 *    window adds, swaps or removes meanwhile is followed; a save refused twice
 *    keeps both phone files; Keep mine never brings back a file the phone took
 *    out; an added file whose upload is gone is left out, with no loop, and an
 *    older save never lands after a newer one; a file change whose save gets
 *    no answer waits for the next save (the restart guard asks); Discard and
 *    Discard mine drop waiting file changes. After each step the box's tiles
 *    are the saved draft's files;
 *  - a file still uploading when Cancel closes the box lands in the draft
 *    once in (the restart guard asks meanwhile), and the foot's Send carries
 *    it; so does one when the pane is given another thread, or closes;
 *  - Discard drops the files with the words, and a file still uploading (in
 *    the box, or landing from an earlier Cancel) joins no draft.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { INBOX_DRAFT_BODY_MAX, type InboxMessage, type InboxReplyDraft, type InboxThread, type InboxUpload } from '@plannotator/core/inbox-types';

import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
/** The update control's restart guard: what a restart would lose (null: nothing). */
const { unsentReply } = (hasDom ? await import('./unsent') : {}) as typeof import('./unsent');
const { flushBeforeReload } = (hasDom ? await import('./stalePage') : {}) as typeof import('./stalePage');
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const image = (name: string, extra = 0) => new File([Uint8Array.from([...PNG, extra])], name, { type: 'image/png' });

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

/** A POST that `match`es waits for `wait` before it reaches the Inbox. */
let gate: { match: (path: string, body: string) => boolean; wait: Promise<void> } | null = null;
let offline = false;
/** The save landed, but its answer is lost on the way back (when this answers true). */
let dropAnswer: ((path: string, body: string) => Promise<boolean>) | null = null;

/** Uploads wait for `release()` while set: a file still uploading. */
let heldUploads: { promise: Promise<void>; release: () => void } | null = null;
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
      if (heldUploads) await heldUploads.promise;
      if (this.aborted) return;
      const bytes = Buffer.from(await file.arrayBuffer());
      const answer = await loopback(this.path, 'POST', bytes, { 'Content-Type': 'application/octet-stream' });
      if (this.aborted) return;
      this.upload.onprogress?.({ loaded: bytes.length, total: bytes.length, lengthComputable: true });
      this.status = answer.status;
      this.responseText = answer.text;
      this.onload?.();
    })().catch(() => this.onerror?.());
  }
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-reply-draft-files-dom-')));
  // The DOM server keeps its own scratch HOME under the data dir: nothing here names one.
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '34'], {
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
    // The link is down for drafts: no answer.
    if (offline && path.includes('/draft')) throw new TypeError('Failed to fetch');
    // A save the test holds on its way (a slow phone link): it reaches the Inbox once released.
    if (gate && method === 'POST' && gate.match(path, body ?? '')) await gate.wait;
    const answer = await loopback(path, method, body);
    if (dropAnswer && method === 'POST' && (await dropAnswer(path, body ?? ''))) throw new TypeError('Failed to fetch');
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
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

afterEach(() => {
  if (!hasDom) return;
  heldUploads?.release();
  gate = null;
  offline = false;
  dropAnswer = null;
  unmount();
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  (globalThis as Record<string, unknown>).XMLHttpRequest = savedXhr;
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
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

function type(text: HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.setSelectionRange(words.length, words.length);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The reply box's paperclip, given files as its picker would. */
function attach(el: HTMLElement, files: File[]) {
  const input = replyBox(el)!.querySelector<HTMLInputElement>('input[type="file"][data-reply-attach]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const replyBox = (el: HTMLElement) => el.querySelector('.ib-rbox') as HTMLElement | null;
const replyText = (el: HTMLElement) => replyBox(el)?.querySelector('textarea') as HTMLTextAreaElement | null;
/** The box's tiles, by name, with their state (`uploading`, `done`, `refused`). */
const tiles = (el: HTMLElement) =>
  [...(replyBox(el)?.querySelectorAll<HTMLElement>('[data-reply-files] [data-compose-file]') ?? [])].map((t) => `${t.getAttribute('data-compose-file-name')}:${t.getAttribute('data-compose-file')}`);

async function openReply(el: HTMLElement): Promise<HTMLTextAreaElement> {
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 1, 'the question');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the reply box');
  return replyText(el)!;
}

async function serverDraft(thread = world.waiting): Promise<InboxReplyDraft | null> {
  return (JSON.parse((await loopback(`/api/inbox/threads/${thread}/draft`)).text) as { draft: InboxReplyDraft | null }).draft;
}
/** Another thread open in this window (the hash, as a row or a link sets it). */
async function goTo(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
const settle = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const draftNames = async () => ((await serverDraft())?.files ?? []).map((file) => file.name);

async function serverSession(): Promise<string> {
  return (JSON.parse((await loopback('/api/inbox/health')).text) as { serverSession: string }).serverSession;
}

/** Another window (or the phone's window) uploads a file and saves the draft, over loopback, never through this window. */
async function uploadAsOther(name: string, extra: number): Promise<InboxUpload> {
  const answer = await loopback(`/api/inbox/uploads?name=${name}&serverSession=${await serverSession()}`, 'POST', Buffer.from(Uint8Array.from([...PNG, extra])), {
    'Content-Type': 'application/octet-stream',
  });
  return (JSON.parse(answer.text) as { upload: InboxUpload }).upload;
}
async function saveAsOther(body: string, files: string[], base: string | null) {
  const answer = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ serverSession: await serverSession(), body, base, files, all_files: true }));
  expect(answer.status).toBe(200);
}

test.skipIf(!hasDom)('a file attached with the paperclip is in the draft: Cancel keeps it and Edit draft brings its tile back; a reload brings it back too', async () => {
  let el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, 'See the chart.');
  attach(el, [image('chart.png')]);
  await until(async () => (await serverDraft())?.body === 'See the chart.' && (await draftNames()).join() === 'chart.png', 'the draft with the file');
  expect(tiles(el)).toEqual(['chart.png:done']);
  // Saved in the draft: a restart would lose nothing.
  await until(() => unsentReply() === null, 'the guard at rest');

  // Cancel: the box closes, the draft keeps the file; Edit draft brings the tile back beside the words.
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  expect(await draftNames()).toEqual(['chart.png']);
  act(() => button(el, 'Edit draft').click());
  await until(() => tiles(el).join() === 'chart.png:done', 'the tile back');
  expect(replyText(el)!.value).toBe('See the chart.');

  // A reload: the window again, the box back with its words and the tile.
  unmount();
  el = await renderApp(`#thread=${world.waiting}`);
  await until(() => replyBox(el) !== null && tiles(el).join() === 'chart.png:done', 'the box and its tile after a reload');
  expect(replyText(el)!.value).toBe('See the chart.');
  // The tile's × removes it from the draft; the words stay.
  act(() => (replyBox(el)!.querySelector('[data-compose-file] .ib-cp-fx') as HTMLButtonElement).click());
  await until(async () => (await serverDraft())?.files === undefined, 'the file out of the draft');
  expect((await serverDraft())?.body).toBe('See the chart.');
}, 30_000);

test.skipIf(!hasDom)("another window's file comes into a box with no edits, and goes when it removes it; two windows adding at once both keep theirs, with no conflict line", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, 'Both shots');
  await until(async () => (await serverDraft())?.body === 'Both shots', 'the words saved');

  // The other window adds its shot to the same words before this window hears of it; this window attaches its own.
  const theirs = await uploadAsOther('theirs.png', 1);
  await saveAsOther('Both shots', [theirs.upload_id], (await serverDraft())!.updated_at);
  attach(el, [image('mine.png', 2)]);
  // This window's save was a step behind: its added file joins the other window's, both kept, the box shows both.
  await until(async () => (await draftNames()).join() === 'theirs.png,mine.png', 'both files in the draft');
  await until(() => tiles(el).sort().join() === 'mine.png:done,theirs.png:done', 'both tiles in the box');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
  expect((await serverDraft())!.body).toBe('Both shots');

  // The other window removes its shot: the box, with no edits since, follows.
  const now = (await serverDraft())!;
  await saveAsOther('Both shots', [now.files!.find((f) => f.name === 'mine.png')!.upload_id], now.updated_at);
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => tiles(el).join() === 'mine.png:done', 'their tile gone');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();

  // Different words do bring the line; Keep mine keeps the other window's file beside mine.
  const extra = await uploadAsOther('extra.png', 3);
  const before = (await serverDraft())!;
  await saveAsOther('Their words', [...before.files!.map((f) => f.upload_id), extra.upload_id], before.updated_at);
  type(replyText(el)!, 'My words');
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict line');
  act(() => (el.querySelector('[data-draft-keep-mine]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft())?.body === 'My words', 'my words saved');
  expect(await draftNames()).toEqual(['mine.png', 'extra.png']);
  await until(() => tiles(el).sort().join() === 'extra.png:done,mine.png:done', 'the merged tiles');
}, 30_000);

test.skipIf(!hasDom)("a file still uploading when Cancel closes the box lands in the draft once in, and the foot's Send carries it", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, 'The log is attached.');
  await until(async () => (await serverDraft())?.body === 'The log is attached.', 'the words saved');
  const held = holdUploads();
  attach(el, [image('slow.png', 4)]);
  expect(tiles(el)).toEqual(['slow.png:uploading']);
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  // Not in the draft yet: a restart would lose it, so the guard asks.
  expect(unsentReply()).not.toBeNull();
  held.release();
  await until(async () => (await draftNames()).join() === 'slow.png', 'the file in the draft');
  expect((await serverDraft())!.body).toBe('The log is attached.');
  await until(() => unsentReply() === null, 'the guard at rest');

  // The foot's Send (the box closed) carries the words and the file; the draft is done.
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Send'), "the foot's Send");
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  await until(async () => (await serverDraft()) === null, 'the draft done');
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: InboxMessage[] } };
  const sent = model.thread.messages.at(-1)!;
  expect(sent.body.startsWith('The log is attached.')).toBe(true);
  expect(sent.attachments!.map((a) => a.name)).toEqual(['slow.png']);
}, 30_000);

test.skipIf(!hasDom)('Discard drops the files with the words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  const text = await openReply(el);
  type(text, 'Never mind');
  attach(el, [image('drop-me.png', 5)]);
  await until(async () => (await draftNames()).join() === 'drop-me.png', 'the draft with the file');
  await until(() => el.querySelector('[data-draft-discard]') !== null, 'Discard');
  act(() => (el.querySelector('[data-draft-discard]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft()) === null, 'the draft gone');
  await until(() => replyBox(el) === null, 'the box closed');
  act(() => button(el, 'Reply').click());
  await until(() => replyBox(el) !== null, 'the box again');
  expect(tiles(el)).toEqual([]);
}, 30_000);

test.skipIf(!hasDom)("saves on a slow link (one on its way, one more key behind it) keep the other window's file in the draft (a slow phone link)", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const theirs = await uploadAsOther('theirs.png', 11);
  await saveAsOther('Hi', [theirs.upload_id], (await serverDraft())!.updated_at);
  // This window's next save is held on its way; the box does not show their file yet.
  const slow = holdSaveWhere((body) => body.includes('"Hi there"'));
  type(replyText(el)!, 'Hi there');
  await until(slow.held, 'the save held');
  // One more key while it is out: taken from the box before the box has their file.
  type(replyText(el)!, 'Hi there!');
  await settle(800);
  slow.release();
  await until(async () => (await serverDraft())?.body === 'Hi there!', 'the last words saved');
  await until(() => tiles(el).join() === 'theirs.png:done', 'their tile in the box');
  expect(await draftNames()).toEqual(['theirs.png']);
  expect(await boxMatchesDraft(el)).toBe(true);
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  expect(await draftNames()).toEqual(['theirs.png']);
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
}, 30_000);

/** A draft save is held on its way while `match` (on its JSON body) says so, once, until released. */
function holdSaveWhere(match: (body: string) => boolean) {
  let release = () => {};
  const wait = new Promise<void>((done) => (release = done));
  const state = { held: false };
  gate = { match: (path, body) => path.includes('/draft') && !state.held && match(body) && (state.held = true), wait };
  return {
    held: () => state.held,
    release: () => {
      gate = null;
      release();
    },
  };
}
/** The upload's bytes and record leave the pending store, as a Send elsewhere or the sweep takes them. */
function forgetPendingUpload(uploadId: string) {
  const found = (readdirSync(join(dir!, 'data'), { recursive: true }) as string[]).filter((path) => path.includes('pending') && path.includes(uploadId));
  expect(found.length).toBeGreaterThan(0);
  for (const path of found) rmSync(join(dir!, 'data', path), { recursive: true, force: true });
}
/** Every finished tile in the box is a file of the draft, and the other way round: nothing left for the sweep. */
async function boxMatchesDraft(el: HTMLElement) {
  return tiles(el).map((tile) => tile.replace(/:done$/, '')).sort().join() === (await draftNames()).sort().join();
}

test.skipIf(!hasDom)("a file attached while the save that will be refused is on its way: the draft keeps it beside the other window's, as the box shows", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const theirs = await uploadAsOther('theirs.png', 21);
  await saveAsOther('Hi', [theirs.upload_id], (await serverDraft())!.updated_at);
  // This window's next save (words only) is held: the other window's save is already in, so it will be refused.
  const refused = holdSaveWhere((body) => body.includes('"Hi there"') && !body.includes('upl_'));
  type(replyText(el)!, 'Hi there');
  await until(refused.held, 'the save to be refused held');
  attach(el, [image('mine.png', 22)]);
  await until(() => tiles(el).join() === 'mine.png:done', 'my tile in');
  await settle(800);
  const before = posted.length;
  refused.release();
  await until(async () => (await draftNames()).sort().join() === 'mine.png,theirs.png', 'both files in the draft');
  await until(() => tiles(el).sort().join() === 'mine.png:done,theirs.png:done', 'both tiles in the box');
  await settle(1000);
  expect(await boxMatchesDraft(el)).toBe(true);
  // No save after the release took either file out on its way.
  const saves = posted.slice(before).filter((p) => p.path.endsWith('/draft'));
  for (const save of saves) expect(save.body.files_remove ?? []).toEqual([]);
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  await settle(300);
  expect((await draftNames()).sort()).toEqual(['mine.png', 'theirs.png']);
  expect((await serverDraft())!.body).toBe('Hi there');
}, 30_000);

test.skipIf(!hasDom)('a file removed while the save that will be refused is on its way stays removed, in the box and the draft', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  attach(el, [image('old.png', 23)]);
  await until(async () => (await serverDraft())?.body === 'Hi' && (await draftNames()).join() === 'old.png', 'the words and the file saved');
  const old = (await serverDraft())!.files![0]!.upload_id;
  const theirs = await uploadAsOther('theirs.png', 24);
  await saveAsOther('Hi', [old, theirs.upload_id], (await serverDraft())!.updated_at);
  const refused = holdSaveWhere((body) => body.includes('"Hi there"'));
  type(replyText(el)!, 'Hi there');
  await until(refused.held, 'the save to be refused held');
  act(() => (replyBox(el)!.querySelector('[data-compose-file] .ib-cp-fx') as HTMLButtonElement).click());
  await until(() => tiles(el).length === 0, 'my tile removed');
  await settle(800);
  refused.release();
  await until(async () => (await draftNames()).join() === 'theirs.png' && (await serverDraft())?.body === 'Hi there', 'their file alone in the draft');
  await until(() => tiles(el).join() === 'theirs.png:done', 'their tile alone in the box');
  await settle(1000);
  expect(await draftNames()).toEqual(['theirs.png']);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)("a file the other window's draft names whose upload goes meanwhile: the last words land once, with no loop", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const theirs = await uploadAsOther('theirs.png', 31);
  await saveAsOther('Hi', [theirs.upload_id], (await serverDraft())!.updated_at);
  const held = holdTwo((body) => body.includes('"Hi there"'), (body) => body.includes('"Hi there!"'));
  type(replyText(el)!, 'Hi there');
  await until(held.heldA, 'the first save held');
  // One more key while it is out (taken before the box has their file), itself held once the first goes.
  type(replyText(el)!, 'Hi there!');
  await settle(800);
  held.releaseA();
  await until(held.heldB, 'the later save held');
  await until(() => tiles(el).join() === 'theirs.png:done', 'their tile in the box');
  // Their file's upload goes meanwhile.
  forgetPendingUpload(theirs.upload_id);
  const before = posted.length;
  gate = null;
  held.releaseB();
  await until(async () => (await serverDraft())?.body === 'Hi there!', 'the last words saved');
  await settle(1500);
  expect(posted.slice(before).filter((p) => p.path.endsWith('/draft')).length).toBeLessThan(3);
  expect((await serverDraft())?.body).toBe('Hi there!');
  expect(await boxMatchesDraft(el)).toBe(true);
  await until(() => unsentReply() === null, 'the guard at rest');
}, 30_000);

test.skipIf(!hasDom)('a file the other window swaps while this window\'s save is on its way: the draft and the box follow', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const theirs = await uploadAsOther('theirs.png', 41);
  await saveAsOther('Hi', [theirs.upload_id], (await serverDraft())!.updated_at);
  const slow = holdSaveWhere((body) => body.includes('"Hi there"'));
  type(replyText(el)!, 'Hi there');
  await until(slow.held, 'the save held');
  // The other window swaps its file for another before this window's save arrives.
  const swapped = await uploadAsOther('swapped.png', 42);
  await saveAsOther('Hi', [swapped.upload_id], (await serverDraft())!.updated_at);
  slow.release();
  await until(async () => (await serverDraft())?.body === 'Hi there', 'the words saved over theirs');
  await settle(1500);
  expect(await draftNames()).toEqual(['swapped.png']);
  await until(() => tiles(el).join() === 'swapped.png:done', 'the box follows');
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)("a file attached while this window's save is on its way stays, in the box and the draft, beside the other window's", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const theirs = await uploadAsOther('theirs.png', 12);
  await saveAsOther('Hi', [theirs.upload_id], (await serverDraft())!.updated_at);
  const slow = holdSaveWhere((body) => body.includes('"Hi there"') && !body.includes('upl_'));
  type(replyText(el)!, 'Hi there');
  await until(slow.held, 'the save held');
  attach(el, [image('mine.png', 13)]);
  await until(() => tiles(el).join() === 'mine.png:done', 'my tile in');
  await settle(800);
  slow.release();
  await until(async () => (await draftNames()).sort().join() === 'mine.png,theirs.png', 'both files in the draft');
  await until(() => tiles(el).sort().join() === 'mine.png:done,theirs.png:done', 'both tiles in the box');
  await settle(800);
  expect((await draftNames()).sort()).toEqual(['mine.png', 'theirs.png']);
  expect(tiles(el).sort()).toEqual(['mine.png:done', 'theirs.png:done']);
}, 30_000);

test.skipIf(!hasDom)('Discard after a Cancel that left an upload running: the file does not come back as a draft', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Words first');
  await until(async () => (await serverDraft())?.body === 'Words first', 'the words saved');
  const held = holdUploads();
  attach(el, [image('slow.png', 7)]);
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  act(() => button(el, 'Edit draft').click());
  await until(() => el.querySelector('[data-draft-discard]') !== null, 'Discard');
  act(() => (el.querySelector('[data-draft-discard]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft()) === null, 'the draft gone');
  held.release();
  await settle(1500);
  expect(await serverDraft()).toBeNull();
  await until(() => unsentReply() === null, 'the guard at rest');
}, 30_000);

test.skipIf(!hasDom)('Discard while a file uploads in the box: it joins no draft once in', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Throw this away');
  await until(async () => (await serverDraft())?.body === 'Throw this away', 'the words saved');
  const held = holdUploads();
  attach(el, [image('slow.png', 8)]);
  expect(tiles(el)).toEqual(['slow.png:uploading']);
  await until(() => el.querySelector('[data-draft-discard]') !== null, 'Discard');
  act(() => (el.querySelector('[data-draft-discard]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft()) === null, 'the draft gone');
  held.release();
  await settle(1500);
  expect(await serverDraft()).toBeNull();
}, 30_000);

test.skipIf(!hasDom)("a file still uploading when the pane is given another thread lands in the first thread's draft", async () => {
  // The pane itself, given one thread and then another in place (a host that keeps the pane while the next
  // thread is ready; this Inbox's window shows a wait between the two, the pane-close case below).
  const other = worlds.pop()!;
  const read = async (id: string) => (JSON.parse((await loopback(`/api/inbox/threads/${id}`)).text) as { thread: InboxThread }).thread;
  const [first, next] = [await read(world.waiting), await read(other.waiting)];
  host = document.createElement('div');
  document.body.appendChild(host);
  const el = host;
  const draw = (t: InboxThread) =>
    act(() =>
      root!.render(
        <ThreadPane thread={t} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />,
      ),
    );
  act(() => {
    root = createRoot(el);
  });
  draw(first);
  type(await openReply(el), 'Logs to follow.');
  await until(async () => (await serverDraft())?.body === 'Logs to follow.', 'the words saved');
  const held = holdUploads();
  attach(el, [image('switch.png', 9)]);
  expect(tiles(el)).toEqual(['switch.png:uploading']);
  draw(next);
  await until(() => el.querySelector(`section.ib-pane[data-thread-id="${other.waiting}"]`) !== null && replyBox(el) === null, 'the other thread in the pane');
  expect(unsentReply()).not.toBeNull();
  held.release();
  await until(async () => (await draftNames()).join() === 'switch.png', "the file in the first thread's draft");
  expect((await serverDraft())!.body).toBe('Logs to follow.');
  expect(await serverDraft(other.waiting)).toBeNull();
  await until(() => unsentReply() === null, 'the guard at rest');
}, 30_000);

test.skipIf(!hasDom)("a file still uploading when the thread pane closes lands in that thread's draft", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Closing the pane.');
  await until(async () => (await serverDraft())?.body === 'Closing the pane.', 'the words saved');
  const held = holdUploads();
  attach(el, [image('closing.png', 10)]);
  expect(tiles(el)).toEqual(['closing.png:uploading']);
  await goTo('');
  await until(() => el.querySelector('section.ib-pane') === null, 'the pane closed');
  held.release();
  await until(async () => (await draftNames()).join() === 'closing.png', 'the file in the draft');
  expect((await serverDraft())!.body).toBe('Closing the pane.');
}, 30_000);

/** Two saves held in turn: the first matching `a`, then the first matching `b`, each until its own release. */
function holdTwo(a: (body: string) => boolean, b: (body: string) => boolean) {
  let releaseA = () => {};
  const waitA = new Promise<void>((done) => (releaseA = done));
  let releaseB = () => {};
  const waitB = new Promise<void>((done) => (releaseB = done));
  const state = { a: false, b: false, wait: waitA };
  gate = {
    match: (path, body) => {
      if (!path.endsWith('/draft')) return false;
      if (!state.a && a(body)) return ((state.a = true), (state.wait = waitA), true);
      if (state.a && !state.b && b(body)) return ((state.b = true), (state.wait = waitB), true);
      return false;
    },
    get wait() {
      return state.wait;
    },
  };
  return { heldA: () => state.a, heldB: () => state.b, releaseA, releaseB };
}

test.skipIf(!hasDom)("a save refused twice (the phone adds a file, then another, while this window's saves are on their way) keeps both phone files", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const p1 = await uploadAsOther('p1.png', 51);
  await saveAsOther('Hi', [p1.upload_id], (await serverDraft())!.updated_at);
  const held = holdTwo((body) => body.includes('"Hi there"'), (body) => body.includes('"Hi there!"'));
  type(replyText(el)!, 'Hi there');
  await until(held.heldA, 'the first save held');
  type(replyText(el)!, 'Hi there!');
  await settle(800);
  held.releaseA();
  await until(held.heldB, 'the second save held');
  // The phone adds another file before the second save arrives.
  const p2 = await uploadAsOther('p2.png', 52);
  const now = (await serverDraft())!;
  await saveAsOther(now.body, [...(now.files ?? []).map((file) => file.upload_id), p2.upload_id], now.updated_at);
  gate = null;
  held.releaseB();
  await until(async () => (await serverDraft())?.body === 'Hi there!', 'the last words saved');
  await until(() => tiles(el).sort().join() === 'p1.png:done,p2.png:done', 'both phone tiles in the box');
  expect((await draftNames()).sort()).toEqual(['p1.png', 'p2.png']);
  expect(await boxMatchesDraft(el)).toBe(true);
  // One more key, then Cancel: both stay.
  type(replyText(el)!, 'Hi there!!');
  await until(async () => (await serverDraft())?.body === 'Hi there!!', 'one more key saved');
  expect((await draftNames()).sort()).toEqual(['p1.png', 'p2.png']);
  expect(await boxMatchesDraft(el)).toBe(true);
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  await settle(300);
  expect((await draftNames()).sort()).toEqual(['p1.png', 'p2.png']);
}, 30_000);

test.skipIf(!hasDom)('Keep mine after the phone changed the words and took its file out does not bring the file back', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const p1 = await uploadAsOther('p1.png', 61);
  await saveAsOther('Hi', [p1.upload_id], (await serverDraft())!.updated_at);
  const held = holdTwo((body) => body.includes('"Hi there"'), (body) => body.includes('"Hi there!"'));
  type(replyText(el)!, 'Hi there');
  await until(held.heldA, 'the first save held');
  type(replyText(el)!, 'Hi there!');
  await settle(800);
  held.releaseA();
  await until(held.heldB, 'the second save held');
  // The phone rewrites the words and takes its photo out.
  await saveAsOther('Phone words', [], (await serverDraft())!.updated_at);
  gate = null;
  held.releaseB();
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict line');
  act(() => (el.querySelector('[data-draft-keep-mine]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft())?.body === 'Hi there!', 'my words saved');
  await settle(1000);
  expect(await draftNames()).toEqual([]);
  expect(tiles(el)).toEqual([]);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('a save refused for a file gone meanwhile never lands after newer words: the last words are saved, the file dropped', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  attach(el, [image('g.png', 71)]);
  await until(async () => (await serverDraft())?.body === 'Hi' && (await draftNames()).join() === 'g.png', 'saved with the file');
  const g = (await serverDraft())!.files![0]!.upload_id;
  const held = holdSaveWhere((body) => body.includes('"Hi a"'));
  type(replyText(el)!, 'Hi a');
  await until(held.held, 'the save held');
  act(() => (replyBox(el)!.querySelector('[data-compose-file] .ib-cp-fx') as HTMLButtonElement).click());
  type(replyText(el)!, 'Hi ab');
  await settle(800);
  forgetPendingUpload(g);
  const before = posted.length;
  held.release();
  await until(async () => (await serverDraft())?.body === 'Hi ab', 'the last words saved');
  await settle(1000);
  expect((await serverDraft())?.body).toBe('Hi ab');
  expect(await draftNames()).toEqual([]);
  expect(await boxMatchesDraft(el)).toBe(true);
  expect(posted.slice(before).filter((p) => p.path.endsWith('/draft')).length).toBeLessThan(5);
  await until(() => unsentReply() === null, 'the guard at rest');
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  expect((await serverDraft())?.body).toBe('Hi ab');
}, 30_000);

test.skipIf(!hasDom)('a file whose save gets no answer waits for the next save: the restart guard asks until one lands it', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  await until(() => unsentReply() === null, 'the guard at rest');
  offline = true;
  attach(el, [image('late.png', 81)]);
  await until(() => tiles(el).join() === 'late.png:done', 'the tile in');
  type(replyText(el)!, 'Hi there');
  await settle(1500);
  expect((await serverDraft())?.body).toBe('Hi');
  expect(await draftNames()).toEqual([]);
  expect(unsentReply()).not.toBeNull();
  // The box closed (its own save gets no answer either): the file change still waits, and the guard still asks.
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  await settle(1500);
  expect(unsentReply()).not.toBeNull();
  offline = false;
  act(() => button(el, 'Edit draft').click());
  await until(() => replyBox(el) !== null, 'the box again');
  // The tile is back with the draft's words: this window's file not saved yet.
  expect(tiles(el)).toEqual(['late.png:done']);
  type(replyText(el)!, 'Hi there!');
  await until(async () => (await serverDraft())?.body === 'Hi there!' && (await draftNames()).join() === 'late.png', 'the words and the file saved');
  await until(() => tiles(el).join() === 'late.png:done', 'the tile back in the box');
  expect(await boxMatchesDraft(el)).toBe(true);
  await until(() => unsentReply() === null, 'the guard at rest');
}, 30_000);

test.skipIf(!hasDom)('Discard mine drops the file this window attached during the conflict: it never lands later', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  await saveAsOther('Phone words', [], (await serverDraft())!.updated_at);
  attach(el, [image('mine.png', 95)]);
  await until(() => tiles(el).join() === 'mine.png:done', 'my tile in');
  type(replyText(el)!, 'Hi mine');
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict line');
  act(() => (el.querySelector('[data-draft-conflict] [data-draft-discard]') as HTMLButtonElement).click());
  await until(() => replyText(el)?.value === 'Phone words', "the other window's words in the box");
  expect(tiles(el)).toEqual([]);
  await until(() => unsentReply() === null, 'the guard at rest');
  type(replyText(el)!, 'Phone words!');
  await until(async () => (await serverDraft())?.body === 'Phone words!', 'the next words saved');
  await settle(800);
  expect(await draftNames()).toEqual([]);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('Discard drops a file change that is still waiting for a save: the next draft starts without it', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  offline = true;
  attach(el, [image('waiting.png', 97)]);
  await until(() => tiles(el).join() === 'waiting.png:done', 'the tile in');
  type(replyText(el)!, 'Hi there');
  await settle(1500);
  offline = false;
  expect(unsentReply()).not.toBeNull();
  act(() => (el.querySelector('[data-draft-discard]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft()) === null, 'the draft gone');
  await until(() => unsentReply() === null, 'the guard at rest');
  type(await openReply(el), 'New words');
  await until(async () => (await serverDraft())?.body === 'New words', 'the new words saved');
  await settle(800);
  expect(await draftNames()).toEqual([]);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('a save refused for words its unanswered save left behind never lands after the newer save queued behind it', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  // A save gets no answer and never landed.
  offline = true;
  type(replyText(el)!, 'Hi a');
  await settle(1500);
  offline = false;
  expect((await serverDraft())?.body).toBe('Hi');
  // The other window adds a file (the same words): the next save here is refused, its known words behind.
  const theirs = await uploadAsOther('theirs.png', 91);
  await saveAsOther('Hi', [theirs.upload_id], (await serverDraft())!.updated_at);
  const slow = holdSaveWhere((body) => body.includes('"Hi ab"'));
  type(replyText(el)!, 'Hi ab');
  await until(slow.held, 'the save held');
  // A newer save queues behind it.
  type(replyText(el)!, 'Hi abc');
  await settle(800);
  const before = posted.length;
  slow.release();
  await until(async () => (await serverDraft())?.body === 'Hi abc', 'the newest words saved');
  await settle(1500);
  expect((await serverDraft())?.body).toBe('Hi abc');
  expect(await draftNames()).toEqual(['theirs.png']);
  await until(() => tiles(el).join() === 'theirs.png:done', 'their tile in the box');
  expect(await boxMatchesDraft(el)).toBe(true);
  expect(posted.slice(before).filter((p) => p.path.endsWith('/draft')).length).toBeLessThan(4);
}, 30_000);

test.skipIf(!hasDom)("a file attached here while the phone changes the words is no conflict: the box takes the phone's words and the draft keeps the file", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  // The save of the attach (words unchanged here) is on its way over a slow link.
  const slow = holdSaveWhere((body) => body.includes('"files_add":[{'));
  attach(el, [image('mine.png', 101)]);
  await until(slow.held, 'the file save held');
  // Meanwhile the phone rewrites the words (this window has not typed since 'Hi').
  await saveAsOther('Phone words', [], (await serverDraft())!.updated_at);
  slow.release();
  await until(async () => (await draftNames()).join() === 'mine.png', 'my file in the draft');
  await until(() => replyText(el)?.value === 'Phone words', "the phone's words in the box");
  await settle(800);
  expect(el.querySelector('[data-draft-conflict]') !== null).toBe(false);
  expect((await serverDraft())?.body).toBe('Phone words');
  expect(await draftNames()).toEqual(['mine.png']);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('a removal whose save got no answer goes with the Send: the removed file does not come back as a draft', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Here it is');
  attach(el, [image('old.png', 102)]);
  await until(async () => (await draftNames()).join() === 'old.png', 'saved with the file');
  // The link drops; the person takes the file out (its save gets no answer, the removal waits).
  offline = true;
  act(() => (replyBox(el)!.querySelector('[data-compose-file] .ib-cp-fx') as HTMLButtonElement).click());
  await settle(1500);
  offline = false;
  expect(tiles(el)).toEqual([]);
  // Back online, Send at once (no key typed since).
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  await settle(1500);
  expect(await serverDraft()).toBeNull();
}, 30_000);

test.skipIf(!hasDom)("the stale page's reload saves a file change still waiting first, and waits while it cannot", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Here it is');
  attach(el, [image('stale.png', 105)]);
  await until(async () => (await draftNames()).join() === 'stale.png', 'saved with the file');
  offline = true;
  act(() => (replyBox(el)!.querySelector('[data-compose-file] .ib-cp-fx') as HTMLButtonElement).click());
  await settle(1500);
  // The box closed (Cancel), its removal still waiting: no link, so the reload waits.
  act(() => button(el, 'Cancel').click());
  await until(() => replyBox(el) === null, 'the box closed');
  expect(await flushBeforeReload()).toBe(false);
  offline = false;
  // Back: the reload saves the removal first, then goes.
  expect(await flushBeforeReload()).toBe(true);
  expect(await draftNames()).toEqual([]);
  expect((await serverDraft())?.body).toBe('Here it is');
}, 30_000);

test.skipIf(!hasDom)('the phone removes a file whose save landed here without an answer: the next save does not bring it back', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  let done = false;
  dropAnswer = async (path, body) => {
    if (done || !path.includes('/draft') || !body.includes('"files_add":[{')) return false;
    done = true;
    // Landed. Before this window reads it back, the phone takes the file out.
    const now = (await serverDraft())!;
    await saveAsOther('Hi', [], now.updated_at);
    return true;
  };
  attach(el, [image('f.png', 103)]);
  await until(() => done, 'the save landed, its answer lost');
  await settle(800);
  dropAnswer = null;
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  type(replyText(el)!, 'Hi!');
  await until(async () => (await serverDraft())?.body === 'Hi!', 'the next words saved');
  await settle(800);
  expect(await draftNames()).toEqual([]);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)("an attach with no answer that never reached the Inbox is not counted as saved by a read-back of the same words", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  // The save of the attach never reaches the Inbox; the read-back does (the same words, the same version).
  let lost = false;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!lost && (init?.method ?? 'GET') === 'POST' && String(input).endsWith('/draft') && String(init?.body ?? '').includes('"files_add":[{')) {
      lost = true;
      throw new TypeError('Failed to fetch');
    }
    return saved(input, init);
  }) as typeof fetch;
  attach(el, [image('kept.png', 104)]);
  await until(() => lost, 'the save lost');
  await settle(1000);
  globalThis.fetch = saved;
  expect(tiles(el)).toEqual(['kept.png:done']);
  type(replyText(el)!, 'Hi!');
  await until(async () => (await serverDraft())?.body === 'Hi!' && (await draftNames()).join() === 'kept.png', 'the file saved with the next words');
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)("a key typed while the attach's save is on its way, then the phone changes the words: the conflict shows, and the phone's words stay in the draft", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const slow = holdSaveWhere((body) => body.includes('"files_add":[{'));
  attach(el, [image('mine.png', 201)]);
  await until(slow.held, 'the file save held');
  // A key typed during that round trip: its save is queued behind the file's.
  type(replyText(el)!, 'Hi!');
  await settle(700);
  await saveAsOther('Phone words', [], (await serverDraft())!.updated_at);
  slow.release();
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  await settle(800);
  expect((await serverDraft())?.body).toBe('Phone words');
  expect(replyText(el)?.value).toBe('Hi!');
  // Keep mine puts the person's words over the phone's, with the file.
  act(() => button(el, 'Keep mine').click());
  await until(async () => (await serverDraft())?.body === 'Hi!' && (await draftNames()).join() === 'mine.png', 'mine kept, with the file');
}, 30_000);

test.skipIf(!hasDom)("two files attached one after the other while the phone changes the words: the box and the draft both take the phone's words, with both files", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const slow = holdSaveWhere((body) => body.includes('"files_add":[{'));
  attach(el, [image('a.png', 211)]);
  await until(slow.held, 'the first file save held');
  attach(el, [image('b.png', 212)]);
  await until(() => tiles(el).includes('b.png:done'), 'b uploaded');
  await settle(700);
  await saveAsOther('Phone words', [], (await serverDraft())!.updated_at);
  slow.release();
  await until(async () => (await draftNames()).sort().join() === 'a.png,b.png', 'both files saved');
  await settle(800);
  expect(replyText(el)?.value).toBe('Phone words');
  expect((await serverDraft())?.body).toBe('Phone words');
  expect(el.querySelector('[data-draft-conflict]') !== null).toBe(false);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('an attach whose save never reached the Inbox while the phone saved the same words with its own file: the file is not dropped', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const theirs = await uploadAsOther('theirs.png', 221);
  let lost = false;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!lost && (init?.method ?? 'GET') === 'POST' && String(input).endsWith('/draft') && String(init?.body ?? '').includes('"files_add":[{')) {
      lost = true;
      // Never reached the Inbox. Meanwhile the phone saved: the same words, its own file (a new version).
      await saveAsOther('Hi', [theirs.upload_id], (await serverDraft())!.updated_at);
      throw new TypeError('Failed to fetch');
    }
    return saved(input, init);
  }) as typeof fetch;
  attach(el, [image('kept.png', 222)]);
  await until(() => lost, 'the save lost');
  await settle(1200);
  globalThis.fetch = saved;
  expect(tiles(el)).toContain('kept.png:done');
  type(replyText(el)!, 'Hi!');
  await until(async () => (await serverDraft())?.body === 'Hi!', 'the next words saved');
  await settle(800);
  expect((await draftNames()).sort()).toEqual(['kept.png', 'theirs.png']);
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)("Send while an attach's save is on its way and the phone changed the words: the Send does not clear the phone's words", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const slow = holdSaveWhere((body) => body.includes('"files_add":[{'));
  attach(el, [image('mine.png', 231)]);
  await until(slow.held, 'the file save held');
  await saveAsOther('Phone words', [], (await serverDraft())!.updated_at);
  act(() => button(el, 'Send').click());
  await settle(300);
  slow.release();
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  await settle(1500);
  expect((await serverDraft())?.body).toBe('Phone words');
}, 30_000);

test.skipIf(!hasDom)("a file that finished uploading while the words are too long to save stays when an earlier save's answer comes, and lands once they are short again", async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  type(await openReply(el), 'Hi');
  await until(async () => (await serverDraft())?.body === 'Hi', 'the words saved');
  const slow = holdSaveWhere((body) => body.includes('"Hi there"'));
  type(replyText(el)!, 'Hi there');
  await until(slow.held, 'the words save held');
  // Words longer than a draft holds: not saved, so the file finished now is in no save yet (`heldOf`).
  type(replyText(el)!, 'x'.repeat(INBOX_DRAFT_BODY_MAX + 1));
  attach(el, [image('late.png', 241)]);
  await until(() => tiles(el).includes('late.png:done'), 'the file uploaded');
  await settle(700);
  // The earlier save's answer: the box takes the draft's files, and keeps the tile no save named yet.
  slow.release();
  await until(async () => (await serverDraft())?.body === 'Hi there', 'the earlier save landed');
  await settle(500);
  expect(tiles(el)).toEqual(['late.png:done']);
  type(replyText(el)!, 'Hi there, see this');
  await until(async () => (await serverDraft())?.body === 'Hi there, see this' && (await draftNames()).join() === 'late.png', 'the file saved with the words');
  expect(await boxMatchesDraft(el)).toBe(true);
}, 30_000);
