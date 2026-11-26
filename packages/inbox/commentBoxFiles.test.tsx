/**
 * Files on a file's own comment row (the owner, 2026-11-22: "I need to be able to attach images to this comment box
 * on top of files/artifacts"; commentFiles.tsx), in the window against a real Inbox (tests/helpers/inbox-dom-server.ts,
 * its `open-in` world), the image open in full screen on the card's Comment tab:
 *
 * - the reply box's paperclip sits after the pencil; a picture chosen with it shows as the reply box's tile, × takes
 *   it out, and the Reply tab keeps its own paperclip and files (none of the comment's);
 * - a paste of a screenshot into the comment's field and a drop on the card attach to the comment, not the reply;
 * - Comment saves the picture (and any other file) on the comment as `images` entries naming their uploads; the
 *   Send carries them as the reply's attachments and the feedback names them beside the comment;
 * - the comment's words and pictures wait when the file closes and come back with it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { resetComposerState } = (hasDom ? await import('./fullScreenComposer') : {}) as typeof import('./fullScreenComposer');

setDefaultTimeout(30_000);

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const VIEW_COOKIE = 'plannotator-inbox-file-view';

type World = { project: string; openIn: { thread: string; ids: Record<string, string> } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
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

const TESTS = 4;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308060000009d74c6e10000000d49444154789c636060000000040001f61738550000000049454e44ae426082', 'hex');
const image = (name: string) => new File([PNG], name, { type: 'image/png' });

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
let savedXhr: unknown;

beforeAll(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-comment-files-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'open-in'], {
    env: {
      ...process.env,
      DOM_TESTS: '0',
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_TAILSCALE: '',
      HOME: dir,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    },
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
  document.cookie = `${VIEW_COOKIE}=; path=/; max-age=0`;
  resetComposerState();
  posted = [];
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
  document.cookie = `${VIEW_COOKIE}=; path=/; max-age=0`;
  resetComposerState();
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

/** The window, on the thread with `name` open full screen. */
async function renderFull(name: string) {
  window.location.hash = `#thread=${world.openIn.thread}&file=${world.openIn.ids[name]}&view=full`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector(`[data-attachment-pane="${world.openIn.ids[name]}"][data-full-view]`) !== null, `${name} full screen`);
  await until(() => card() !== null, 'the composer');
  return host;
}

const card = () => host!.querySelector<HTMLElement>('[data-fcomp]');
const radio = (which: 'comment' | 'reply') => card()!.querySelector<HTMLButtonElement>(`[role="radio"][data-fcomp-mode="${which}"]`)!;
const replyField = () => card()?.querySelector<HTMLTextAreaElement>('[data-fcomp-field] textarea') ?? null;
const commentField = () => host!.querySelector<HTMLTextAreaElement>('[data-fcomp-comment-slot] [data-image-composer] textarea');
const click = async (el: HTMLElement) => act(async () => el.click());
const tiles = (scope: ParentNode | null | undefined) => (scope ? [...scope.querySelectorAll<HTMLElement>('[data-compose-file]')] : []);
/** The comment's paperclip and tiles; the reply's (the Reply tab's, and the thread's box behind full screen). */
const commentClip = () => card()?.querySelector<HTMLInputElement>('input[type="file"][data-comment-attach]') ?? null;
const commentFiles = () => card()?.querySelector('[data-comment-files]') ?? null;
const replyClip = () => card()?.querySelector<HTMLInputElement>('input[type="file"][data-fcomp-attach]') ?? null;
const replyFiles = () => [...tiles(card()?.querySelector('[data-fcomp-files]')), ...tiles(host!.querySelector('.ib-rbox [data-reply-files]'))];
const saveComment = () => card()!.querySelector<HTMLButtonElement>('[data-image-comment-save]')!;
const textFile = (name: string) => new File(['The footer padding, measured at 375 px.\n'], name, { type: 'text/plain' });

function type(text: HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Choose `files` with an `<input type="file">` (the paperclip). */
function choose(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** A drag event on `target` carrying `files` (a drag from the file manager). True when the page took it. */
function drag(target: Element, type: 'dragover' | 'drop', files: File[]): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'], dropEffect: 'none', getData: () => '' } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** A paste of `files` (a screenshot) on `target`. True when the browser's own paste was prevented. */
function pasteFiles(target: HTMLElement, files: File[]): boolean {
  const items = files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file }));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items, types: items.map((i) => i.type), getData: () => '' } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** A key in full screen (→ and ← step files). */
async function press(key: 'ArrowRight' | 'ArrowLeft') {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  });
}

const allDone = (scope: ParentNode | null) => tiles(scope).length > 0 && tiles(scope).every((t) => t.getAttribute('data-compose-file') === 'done');
const names = (scope: ParentNode | null) => tiles(scope).map((t) => t.getAttribute('data-compose-file-name'));

test.skipIf(!hasDom)('the Comment tab: the paperclip after the pencil; a chosen picture is a tile and × takes it out; the Reply tab keeps its own', async () => {
  await renderFull('shot.png');
  expect(radio('comment').getAttribute('aria-checked')).toBe('true');
  // The reply box's own button, named as it is, after the drawing pencil; none of the reply's on this tab.
  const input = commentClip()!;
  expect(input).not.toBeNull();
  const label = input.closest('label')!;
  expect(label.getAttribute('aria-label')).toBe('Attach files');
  const pencil = card()!.querySelector('[data-markup-open]')!;
  expect(pencil.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(replyClip()).toBeNull();
  // Nothing written: Comment waits.
  expect(saveComment().disabled).toBe(true);

  choose(input, [image('legend-a.png')]);
  await until(() => allDone(commentFiles()), 'the chosen picture uploaded, as a tile in the comment');
  expect(names(commentFiles())).toEqual(['legend-a.png']);
  // A picture alone is a comment; none of it went to the reply.
  expect(saveComment().disabled).toBe(false);
  expect(replyFiles()).toHaveLength(0);

  // × takes it out, focus back in the comment's field.
  await click(tiles(commentFiles())[0]!.querySelector<HTMLButtonElement>('button')!);
  expect(tiles(commentFiles())).toHaveLength(0);
  expect(document.activeElement).toBe(commentField());
  expect(saveComment().disabled).toBe(true);

  // The Reply tab: its own paperclip, as before; the comment's is hidden with its row.
  await click(radio('reply'));
  expect(replyClip()).not.toBeNull();
  expect(commentClip()!.closest('[hidden]')).not.toBeNull();
});

test.skipIf(!hasDom)('a pasted screenshot and a drop on the card attach to the comment, not the reply', async () => {
  await renderFull('shot.png');
  // A screenshot pasted into the comment's field (no text in it: the browser's own paste prevented).
  expect(pasteFiles(commentField()!, [image('image.png')])).toBe(true);
  await until(() => allDone(commentFiles()), 'the pasted picture in the comment');
  expect(names(commentFiles())[0]).toMatch(/^pasted-image-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
  // Files dragged over the card on the Comment tab: it takes them (dashed), and the drop attaches to the comment.
  expect(drag(card()!, 'dragover', [image('dropped-b.png')])).toBe(true);
  expect(card()!.hasAttribute('data-drop-over')).toBe(true);
  expect(drag(card()!, 'drop', [image('dropped-b.png')])).toBe(true);
  await until(() => tiles(commentFiles()).length === 2 && allDone(commentFiles()), 'both pictures in the comment');
  expect(card()!.hasAttribute('data-drop-over')).toBe(false);
  expect(names(commentFiles())[1]).toBe('dropped-b.png');
  expect(replyFiles()).toHaveLength(0);
});

test.skipIf(!hasDom)('Comment keeps the picture and the file on the comment; the Send carries them as the reply’s attachments, named beside the comment', async () => {
  await renderFull('shot.png');
  type(commentField()!, 'The legend is cut off; see my screenshot.');
  choose(commentClip()!, [image('legend-c.png'), textFile('notes-c.txt')]);
  await until(() => tiles(commentFiles()).length === 2 && allDone(commentFiles()), 'both files uploaded');
  await click(saveComment());
  await until(() => posted.some((p) => p.path.endsWith('/annotations')), 'the comment saved');
  const saved = posted.find((p) => p.path.endsWith('/annotations'))!.body.annotation as { text: string; images: { path: string; name: string; kind?: string }[] };
  expect(saved.text).toBe('The legend is cut off; see my screenshot.');
  expect(saved.images).toHaveLength(2);
  expect(saved.images[0]).toEqual({ path: expect.stringMatching(/^upl_[0-9A-Z]{26}\/legend-c\.png$/), name: 'legend-c' });
  expect(saved.images[1]).toEqual({ path: expect.stringMatching(/^upl_[0-9A-Z]{26}\/notes-c\.txt$/), name: 'notes-c.txt', kind: 'file' });
  // Saved: the row is empty again.
  await until(() => tiles(commentFiles()).length === 0 && commentField()!.value === '', 'the row cleared');

  // The Send (from the card's Reply tab) carries both uploads and names them under the comment.
  await click(radio('reply'));
  type(replyField()!, 'One comment on the screenshot.');
  await until(() => !card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!.disabled, 'Send ready');
  await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!);
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the reply');
  const reply = posted.find((p) => p.path.endsWith('/reply'))!.body as { uploads?: string[]; feedback?: string };
  const ids = saved.images.map((i) => i.path.split('/')[0]);
  expect([...(reply.uploads ?? [])].sort()).toEqual([...ids].sort());
  expect(reply.feedback).toContain('> The legend is cut off; see my screenshot.\n**Attached images:**\n- [legend-c] `legend-c.png`\n**Attached files:**\n- [notes-c.txt] `notes-c.txt`\n');
  await until(async () => {
    const model = JSON.parse((await loopback(`/api/inbox/threads/${world.openIn.thread}`)).text) as { thread: { messages: { attachments?: { name: string }[] }[] } };
    return JSON.stringify(model.thread.messages.at(-1)!.attachments?.map((a) => a.name).sort()) === JSON.stringify(['legend-c.png', 'notes-c.txt']);
  }, 'the reply’s attachments');
});

test.skipIf(!hasDom)('the comment’s words and pictures wait when the file closes, and come back with it', async () => {
  await renderFull('shot.png');
  type(commentField()!, 'Crop this tighter.');
  choose(commentClip()!, [image('legend-d.png')]);
  await until(() => allDone(commentFiles()), 'the picture uploaded');
  const shot = world.openIn.ids['shot.png'];
  // → steps to the next file (nothing asks), ← comes back.
  await act(async () => (document.activeElement as HTMLElement | null)?.blur());
  await press('ArrowRight');
  await until(() => host!.querySelector(`[data-attachment-pane="${shot}"]`) === null, 'the next file');
  await press('ArrowLeft');
  await until(() => host!.querySelector(`[data-attachment-pane="${shot}"]`) !== null && commentField() !== null, 'the image again');
  expect(commentField()!.value).toBe('Crop this tighter.');
  expect(names(commentFiles())).toEqual(['legend-d.png']);
  expect(tiles(commentFiles())[0]!.getAttribute('data-compose-file')).toBe('done');
  // Nothing was saved meanwhile.
  expect(posted.some((p) => p.path.endsWith('/annotations'))).toBe(false);
});
