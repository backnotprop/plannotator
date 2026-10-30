/**
 * Full screen's composer (approval "inbox-fullscreen-composer", 2A, round 4)
 * through the whole window: InboxApp over a REAL Inbox server in a temp data
 * dir (its own process, tests/helpers/inbox-dom-server.ts in its `open-in`
 * mode, whose thread carries page.html and shot.png), its fetches carried
 * over loopback.
 *
 * Proves: the tabs switch between the image's own comment row and the
 * thread's reply; the reply is the thread's one draft (typed in the card it
 * is saved and the thread's box holds it; typed in the box the card shows
 * it); minimize and restore move focus and are kept for the thread across
 * files; Hide (») makes the card inert; an HTML page is Reply only; Send from
 * the card refuses as the thread's Send does (nothing to send, the server
 * refusing) and keeps the words, and a Send that goes clears them and the
 * draft while full screen stays. Files: the Reply tab's paperclip (the reply
 * box's, first in its toolbar; none on the Comment tab), a paste and a drop on
 * the card attach to the reply box's own files, shown in both places, and the
 * card's Send carries them.
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
/** The reply route answers this refusal instead of reaching the server (null: it reaches it). */
let refuseReply: { status: number; body: Record<string, unknown> } | null = null;

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

const TESTS = 11;

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-fscomposer-dom-')));
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
  refuseReply = null;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    if (refuseReply && method === 'POST' && path.endsWith('/reply')) {
      return new Response(JSON.stringify(refuseReply.body), { status: refuseReply.status, headers: { 'Content-Type': 'application/json' } });
    }
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

async function openFull(name: string) {
  await act(async () => {
    window.location.hash = `#thread=${world.openIn.thread}&file=${world.openIn.ids[name]}&view=full`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => host!.querySelector(`[data-attachment-pane="${world.openIn.ids[name]}"][data-full-view]`) !== null, `${name} full screen`);
}

const card = () => host!.querySelector<HTMLElement>('[data-fcomp]');
const pill = () => host!.querySelector<HTMLButtonElement>('[data-fcomp-pill]');
const radio = (which: 'comment' | 'reply') => card()!.querySelector<HTMLButtonElement>(`[role="radio"][data-fcomp-mode="${which}"]`)!;
const replyField = () => card()?.querySelector<HTMLTextAreaElement>('[data-fcomp-field] textarea') ?? null;
const threadBox = () => host!.querySelector<HTMLTextAreaElement>('.ib-rbox textarea');
const click = async (el: HTMLElement) => act(async () => el.click());

function type(text: HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function draftOnServer(): Promise<string | null> {
  const answer = await loopback(`/api/inbox/threads/${world.openIn.thread}/draft`);
  return (JSON.parse(answer.text) as { draft: { body: string } | null }).draft?.body ?? null;
}

const tiles = (scope: ParentNode | null) => (scope ? [...scope.querySelectorAll<HTMLElement>('[data-compose-file]')] : []);
const clip = () => card()?.querySelector<HTMLInputElement>('input[type="file"][data-fcomp-attach]') ?? null;
const threadFiles = () => host!.querySelector('.ib-rbox [data-reply-files]');
const cardFiles = () => card()?.querySelector('[data-fcomp-files]') ?? null;

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

const commentField = () => host!.querySelector<HTMLTextAreaElement>('[data-fcomp-comment-slot] [data-image-composer] textarea');
const stepGuard = () => host!.querySelector<HTMLElement>('[data-step-guard]');

/** → in full screen: the next file of the thread. */
async function stepNext() {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
  });
}

function sendKey(text: HTMLTextAreaElement) {
  act(() => {
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
}

test.skipIf(!hasDom)('the tabs switch between the image’s comment row and the reply, a radio group with one pick; focus goes to the field', async () => {
  await renderFull('shot.png');
  const group = card()!.querySelector('[role="radiogroup"]')!;
  expect(group.querySelectorAll('[role="radio"]').length).toBe(2);
  // No draft: Comment first, the image's own comment row inside the card.
  expect(radio('comment').getAttribute('aria-checked')).toBe('true');
  expect(radio('reply').getAttribute('aria-checked')).toBe('false');
  expect(radio('comment').tabIndex).toBe(0);
  expect(radio('reply').tabIndex).toBe(-1);
  expect(card()!.querySelector('[data-image-composer] textarea')).not.toBeNull();
  expect(replyField()).toBeNull();
  expect(host!.querySelector('.ib-imgcompose')).toBeNull();

  await click(radio('reply'));
  expect(radio('reply').getAttribute('aria-checked')).toBe('true');
  // The comment row stays drawn, hidden (its words are kept): the reply field shows.
  expect(card()!.querySelector('[data-image-composer]')!.closest('[hidden]')).not.toBeNull();
  expect(document.activeElement).toBe(replyField());
  // Empty: Send is dimmed.
  expect(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!.disabled).toBe(true);

  // Arrows move the pick (a radio group's own keys).
  await act(async () => {
    radio('reply').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  });
  expect(radio('comment').getAttribute('aria-checked')).toBe('true');
});

test.skipIf(!hasDom)('the card’s reply is the thread’s one draft: typed in the card it is saved and the box holds it; typed in the box the card shows it', async () => {
  await renderFull('shot.png');
  await click(radio('reply'));
  type(replyField()!, 'Keep the footer, pad the form.');
  await until(async () => (await draftOnServer()) === 'Keep the footer, pad the form.', 'the draft saved');
  // The thread's box opened behind full screen with the same words, without taking focus from the card.
  expect(threadBox()?.value).toBe('Keep the footer, pad the form.');
  expect(document.activeElement).toBe(replyField());
  expect(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!.disabled).toBe(false);

  type(threadBox()!, 'Keep the footer, pad the form by 96 px.');
  expect(replyField()!.value).toBe('Keep the footer, pad the form by 96 px.');
  await until(async () => (await draftOnServer()) === 'Keep the footer, pad the form by 96 px.', 'the box’s words saved');
});

test.skipIf(!hasDom)('minimize leaves the pill with focus on it, kept for the thread across files; the pill gives the card back with focus in its field', async () => {
  await renderFull('shot.png');
  await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-minimize]')!);
  expect(card()).toBeNull();
  expect(document.activeElement).toBe(pill());
  expect(pill()!.textContent).toContain('Comment on this image');
  expect(pill()!.getAttribute('aria-label')).toBe('Show the composer: Comment on this image');

  // Another file of the thread: still minimized (HTML is Reply only, so its pill names the reply).
  await openFull('page.html');
  await until(() => pill() !== null, 'the pill on the page');
  expect(card()).toBeNull();
  expect(pill()!.textContent).toMatch(/^Reply to /);

  await click(pill()!);
  expect(card()).not.toBeNull();
  expect(document.activeElement).toBe(replyField());

  // Words waiting: the pill says "Reply draft".
  type(replyField()!, 'A draft.');
  await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-minimize]')!);
  expect(pill()!.textContent).toContain('Reply draft');
});

test.skipIf(!hasDom)('Hide (») takes the card out with the toolbar: inert until the tools show again; an HTML page is Reply only', async () => {
  await renderFull('page.html');
  // HTML: no tabs, the reply field.
  expect(card()!.querySelector('[role="radiogroup"]')).toBeNull();
  expect(card()!.textContent).toMatch(/Reply to /);
  expect(replyField()).not.toBeNull();

  expect(card()!.inert).toBe(false);
  await click(host!.querySelector<HTMLButtonElement>('[data-full-view-hide]')!);
  expect(host!.querySelector('[data-attachment-pane]')!.getAttribute('data-tools')).toBe('tucked');
  expect(card()!.inert).toBe(true);
  await click(host!.querySelector<HTMLButtonElement>('[data-full-view-handle]')!);
  await click(host!.querySelector<HTMLButtonElement>('[data-full-view-hide]')!);
  await until(() => host!.querySelector('[data-full-view-dock]')?.getAttribute('data-bar') === 'pinned', 'the tools pinned');
  expect(card()!.inert).toBe(false);
});

test.skipIf(!hasDom)('Send from the card refuses as the thread’s Send does: nothing to send, or the server refusing; the words stay, full screen stays', async () => {
  await renderFull('shot.png');
  await click(radio('reply'));
  // Nothing to send: the thread's own refusal, shown in the card; nothing posted.
  sendKey(replyField()!);
  await until(() => card()!.querySelector('[data-fcomp-error]') !== null, 'the refusal');
  expect(card()!.querySelector('[data-fcomp-error]')!.textContent).toBe('Write a reply or pick an answer first.');
  expect(posted.some((p) => p.path.endsWith('/reply'))).toBe(false);

  // The server refuses: its words, the reply's words kept in the card and as the draft, still full screen.
  type(replyField()!, 'Ship it on Friday.');
  await until(async () => (await draftOnServer()) === 'Ship it on Friday.', 'the draft saved');
  refuseReply = { status: 409, body: { error: 'This thread changed. Read it again before you send.', code: 'conflict' } };
  await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!);
  await until(() => card()!.querySelector('[data-fcomp-error]')?.textContent === 'This thread changed. Read it again before you send.', 'the server’s refusal');
  expect(replyField()!.value).toBe('Ship it on Friday.');
  expect(await draftOnServer()).toBe('Ship it on Friday.');
  expect(host!.querySelector('[data-attachment-pane][data-full-view]')).not.toBeNull();
  expect(replyField()!.readOnly).toBe(false);
});

test.skipIf(!hasDom)('a Send from the card goes: the words leave the card and the draft, full screen stays and the card says it went', async () => {
  await renderFull('shot.png');
  await click(radio('reply'));
  type(replyField()!, 'Looks right. Ship it.');
  await until(async () => (await draftOnServer()) === 'Looks right. Ship it.', 'the draft saved');
  await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!);
  await until(() => card()?.querySelector('[data-fcomp-sent]') != null, 'the Sent line');
  const reply = posted.find((p) => p.path.endsWith('/reply'))!;
  expect(reply.body.words).toBe('Looks right. Ship it.');
  // The Send names the draft its words were saved as, so the server clears that draft.
  expect(typeof reply.body.clear_draft).toBe('string');
  expect(replyField()!.value).toBe('');
  expect(await draftOnServer()).toBeNull();
  expect(host!.querySelector('[data-attachment-pane][data-full-view]')).not.toBeNull();
  // The card stays on Reply, its field keeps focus.
  expect(radio('reply').getAttribute('aria-checked')).toBe('true');
});

test.skipIf(!hasDom)('the paperclip: none on the Comment tab, first in the Reply tab’s toolbar; a chosen file is the thread box’s file too, and the card’s Send carries it', async () => {
  await renderFull('shot.png');
  // A comment takes no files: no paperclip with the image's comment row.
  expect(clip()).toBeNull();
  await click(radio('reply'));
  // The reply box's own button, first in the card's toolbar, named, the card's 30 px button.
  const input = clip()!;
  expect(input).not.toBeNull();
  const label = input.closest('label')!;
  expect(label.getAttribute('aria-label')).toBe('Attach files');
  expect(label.classList.contains('ib-fvb')).toBe(true);
  expect(card()!.querySelector('[data-fcomp-foot]')!.firstElementChild!.contains(label)).toBe(true);
  // Nothing written yet: Send is dimmed.
  expect(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!.disabled).toBe(true);

  choose(input, [image('footer-375.png')]);
  await until(() => tiles(cardFiles())[0]?.getAttribute('data-compose-file') === 'done', 'the chosen file uploaded, in the card');
  expect(tiles(cardFiles())[0]!.getAttribute('data-compose-file-name')).toBe('footer-375.png');
  // One reply: the thread's box, open behind full screen, holds the same file, and focus stayed in full screen.
  expect(tiles(threadFiles()).map((t) => t.getAttribute('data-compose-file-name'))).toEqual(['footer-375.png']);
  expect(host!.querySelector('[data-attachment-pane][data-full-view]')).not.toBeNull();
  // A file alone is something to send.
  expect(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!.disabled).toBe(false);

  // Words typed in the thread's box ride with it: the card shows them.
  type(threadBox()!, 'The footer at 375 px.');
  expect(replyField()!.value).toBe('The footer at 375 px.');

  await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-send]')!);
  await until(() => card()?.querySelector('[data-fcomp-sent]') != null, 'the Sent line');
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect(replies[0]!.body.words).toBe('The footer at 375 px.');
  expect((replies[0]!.body.uploads as string[]).length).toBe(1);
  // Sent: the tiles go from the card and the box; full screen stays.
  expect(tiles(cardFiles())).toHaveLength(0);
  expect(tiles(threadFiles())).toHaveLength(0);
  expect(host!.querySelector('[data-attachment-pane][data-full-view]')).not.toBeNull();
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.openIn.thread}`)).text) as { thread: { messages: { attachments?: { name: string }[] }[] } };
  expect(model.thread.messages.at(-1)!.attachments?.map((a) => a.name)).toEqual(['footer-375.png']);
});

test.skipIf(!hasDom)('a paste and a drop on the card attach to the reply as on the reply box; a file in the box shows in the card; × takes it from both; files alone make the pill a draft', async () => {
  await renderFull('page.html');
  // HTML is Reply only: the paperclip shows at once.
  expect(clip()).not.toBeNull();
  // A screenshot pasted into the card's field attaches (the browser's own paste prevented: no text in it).
  expect(pasteFiles(replyField()!, [image('pasted.png')])).toBe(true);
  await until(() => tiles(cardFiles()).length === 1, 'the pasted file in the card');
  expect(tiles(threadFiles())).toHaveLength(1);
  // Files dragged over the card: it takes them (dashed), and the drop attaches.
  expect(drag(card()!, 'dragover', [image('dropped.png')])).toBe(true);
  expect(card()!.hasAttribute('data-drop-over')).toBe(true);
  expect(drag(card()!, 'drop', [image('dropped.png')])).toBe(true);
  await until(() => tiles(cardFiles()).length === 2 && tiles(cardFiles()).every((t) => t.getAttribute('data-compose-file') === 'done'), 'both uploads');
  expect(card()!.hasAttribute('data-drop-over')).toBe(false);
  expect(tiles(threadFiles()).map((t) => t.getAttribute('data-compose-file-name'))).toEqual(tiles(cardFiles()).map((t) => t.getAttribute('data-compose-file-name')));

  // × on a tile in the card takes it out of the reply (the box too), focus back in the card's field.
  await click(tiles(cardFiles())[0]!.querySelector<HTMLButtonElement>('button')!);
  expect(tiles(cardFiles())).toHaveLength(1);
  expect(tiles(threadFiles())).toHaveLength(1);
  expect(document.activeElement).toBe(replyField());

  // Files and no words: minimized, the pill still says a reply waits.
  await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-minimize]')!);
  expect(pill()!.textContent).toContain('Reply draft');
});

for (const away of ['the Reply tab', 'minimized'] as const) {
  test.skipIf(!hasDom)(`an image comment not saved yet is kept on ${away}: → asks first, and Keep writing brings the Comment tab back with focus in its words`, async () => {
    await renderFull('shot.png');
    type(commentField()!, 'Too much padding.');
    if (away === 'the Reply tab') await click(radio('reply'));
    else await click(card()!.querySelector<HTMLButtonElement>('[data-fcomp-minimize]')!);
    // Out of sight, still there.
    expect(commentField()!.closest('[hidden]')).not.toBeNull();
    expect(commentField()!.value).toBe('Too much padding.');
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await stepNext();
    await until(() => stepGuard() !== null, 'the "not saved yet" question');
    // The step waited: still on the image.
    expect(host!.querySelector(`[data-attachment-pane="${world.openIn.ids['shot.png']}"]`)).not.toBeNull();
    await click(stepGuard()!.querySelector<HTMLButtonElement>('[data-guard-keep]')!);
    await until(() => document.activeElement === commentField(), 'focus in the comment');
    expect(card()).not.toBeNull();
    expect(radio('comment').getAttribute('aria-checked')).toBe('true');
    expect(commentField()!.closest('[hidden]')).toBeNull();
    expect(commentField()!.value).toBe('Too much padding.');
  });
}

test.skipIf(!hasDom)('a comment saved from the card’s Comment tab is the image’s comment: posted, listed, and the row is clear again', async () => {
  await renderFull('shot.png');
  type(commentField()!, 'The CVC field is under the footer.');
  await click(card()!.querySelector<HTMLButtonElement>('[data-image-comment-save]')!);
  await until(() => posted.some((p) => p.path.endsWith('/api/inbox/annotations')), 'the comment posted');
  const saved = posted.find((p) => p.path.endsWith('/api/inbox/annotations'))!;
  expect(saved.body.attachment_id).toBe(world.openIn.ids['shot.png']);
  expect(JSON.stringify(saved.body.annotation)).toContain('The CVC field is under the footer.');
  await until(() => commentField()!.value === '', 'the row clear');
  // The pane counts it, and the card stays on Comment.
  await until(() => (host!.querySelector('[data-full-view-dock]')?.textContent ?? '').includes('1'), 'the comment counted');
  expect(radio('comment').getAttribute('aria-checked')).toBe('true');
});
