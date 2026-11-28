/**
 * Two lines of the Inbox's reply box that its controller (components/reply/useReplyComposer.tsx) now draws for the
 * thread pane the same way it does for any other host:
 *
 * - The line under the box (a Send that did not go, a Send pressed while a file uploads) goes when files come in: a
 *   paste, a drop on the pane, the paperclip (a computer's and a phone's). Another thread and back, it does not come
 *   back. It is one line for the pane, as the Inbox always drew it: the first frame on another thread shows the line
 *   as it was, never that thread's line from an earlier visit.
 * - "Not saved" over a computer's row: shown while a save did not land and the box holds words; never beside a
 *   conflict, whose own line says it.
 *
 * The real thread pane over a scripted Inbox (a stubbed fetch and an upload that never finishes). Assertions compare
 * strings and booleans, never elements. DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import { UPLOADING_LINE } from './sendFailure';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { resetReplyDraftPageForTests } = (hasDom ? await import('./replyDraft') : {}) as typeof import('./replyDraft');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_a', name: 'Codex' };
const ONE = 'msg_01M6RF0000000000000000001';
const TWO = 'msg_01M6RF0000000000000000002';
const REFUSED = 'Too many replies at once; try again.';

const threadOf = (id: string): InboxThread => ({
  thread_id: id,
  project: PROJECT,
  subject: id === ONE ? 'Retry worker' : 'Ledger export',
  thread_name: null,
  resolved_at: null,
  messages: [
    { id, project_id: PROJECT.id, thread_id: id, reply_to: null, author: A, subject: 'Retry worker', body: 'The retry loop backs off two, four and eight seconds.', created_at: '2026-11-02T10:01:00.000Z', resolved_at: null, idempotency_key: null } as InboxMessageWire,
  ],
});

/** An upload that never finishes: its tile stays in the box, uploading. */
class HeldXhr {
  status = 0;
  responseText = '';
  upload = { onprogress: null };
  onload = null;
  onerror = null;
  onabort = null;
  open() {}
  setRequestHeader() {}
  abort() {}
  send() {}
}

/** The scripted Inbox's drafts (a compare-and-set on `updated_at`, as the server's). */
let drafts = new Map<string, InboxReplyDraft>();
let clock = 0;
/** Draft saves do not land while set (no network). */
let savesFail = false;
/** Replies are refused (429, nothing written) while set. */
let refuseReplies = false;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedXhr: typeof XMLHttpRequest;

function saveElsewhere(thread: string, body: string) {
  clock += 1;
  drafts.set(thread, { v: 1, thread_id: thread, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date(Date.UTC(2026, 10, 2, 11, 0, clock)).toISOString() });
}

beforeEach(() => {
  if (!hasDom) return;
  drafts = new Map();
  savesFail = false;
  refuseReplies = false;
  savedFetch = globalThis.fetch;
  savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = HeldXhr as unknown as typeof XMLHttpRequest;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const draftPath = /\/threads\/([^/]+)\/draft$/.exec(path.split('?')[0]!);
    if (draftPath) {
      const thread = decodeURIComponent(draftPath[1]!);
      if (init?.method !== 'POST') return Response.json({ serverSession: 's', draft: drafts.get(thread) ?? null });
      if (savesFail) throw new TypeError('Failed to fetch');
      const input = JSON.parse(String(init.body)) as Record<string, unknown>;
      const current = drafts.get(thread) ?? null;
      if ((current?.updated_at ?? null) !== ((input.base as string | null | undefined) ?? null) && !(current && current.body === input.base_body)) {
        return Response.json({ error: 'The draft changed.', code: 'draft_conflict', draft: current }, { status: 409 });
      }
      if (String(input.body ?? '') === '') {
        drafts.delete(thread);
        return Response.json({ draft: null });
      }
      saveElsewhere(thread, String(input.body));
      return Response.json({ draft: drafts.get(thread) });
    }
    if (/\/draft\/delete$/.test(path)) return Response.json({ ok: true, deleted: true });
    if (/\/messages\/[^/]+\/reply$/.test(path) && init?.method === 'POST') {
      if (refuseReplies) return Response.json({ error: REFUSED, code: 'rate_limited' }, { status: 429 });
      return Response.json({ reply: { id: 'msg_reply' }, questions: [], replayed: false });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  await settle(2);
  globalThis.fetch = savedFetch;
  globalThis.XMLHttpRequest = savedXhr;
  resetReplyDraftPageForTests();
  localStorage.clear();
});

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(1, 10);
  }
}

/**
 * The line under the box at each commit of `draw`, read in a layout effect: after React wrote the page and before
 * the pane's own effects ran (its arrival on another thread sets the line in an effect, which may run after a paint).
 */
let committed: (string | null)[] = [];
function Commits() {
  useLayoutEffect(() => {
    committed.push(host ? line(host) : null);
  });
  return null;
}

let phoneNow = false;
function draw(id: string) {
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={threadOf(id)} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phoneNow} />
      <Commits />
    </div>,
  );
}

/** The pane on thread ONE with its reply box open. */
async function open(phone = false): Promise<HTMLElement> {
  phoneNow = phone;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(ONE);
  });
  await settle();
  const button = host.querySelector<HTMLButtonElement>('[data-reply-button]');
  expect(!!button).toBe(true);
  await act(async () => button!.click());
  await settle(2);
  expect(!!field(host)).toBe(true);
  return host;
}

const field = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea');
/** The line under the box, as a person reads it (null: none). */
const line = (el: HTMLElement) => el.querySelector('.ib-error[role="alert"]')?.textContent ?? null;
const tiles = (el: HTMLElement) => el.querySelectorAll('.ib-rbox [data-compose-file]').length;
const notes = (name: string) => new File(['the notes'], name, { type: 'text/plain' });

function typeOn(el: HTMLElement, words: string) {
  const text = field(el)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    const next = text.value + words;
    setter.call(text, next);
    text.setSelectionRange(next.length, next.length);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pressSend(el: HTMLElement) {
  const send = el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]');
  expect(!!send).toBe(true);
  await act(async () => send!.click());
  await settle(2);
}
async function paperclip(el: HTMLElement, file: File) {
  const input = el.querySelector<HTMLInputElement>('.ib-rbox input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle(1);
}
async function paste(el: HTMLElement, file: File) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const items = [{ kind: 'file', type: file.type, getAsFile: () => file }];
  Object.defineProperty(event, 'clipboardData', { value: { files: [file], items, types: ['Files'], getData: () => '' } });
  await act(async () => void field(el)!.dispatchEvent(event));
  await settle(1);
}
/** Files dropped on the thread, outside the box: the pane takes them. */
async function dropOnPane(el: HTMLElement, file: File) {
  const pane = el.querySelector('section')!;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file], types: ['Files'], dropEffect: 'none', getData: () => '' } });
    await act(async () => void pane.dispatchEvent(event));
  }
  await settle(1);
}

test.skipIf(!hasDom)('a computer: the line a Send left goes when files come in, by a paste, a drop on the pane or the paperclip', async () => {
  const el = await open();
  typeOn(el, 'Ship the retry change.');
  await paperclip(el, notes('a.txt'));
  expect(tiles(el)).toBe(1);
  // The file is still on its way: Send says so, and the box keeps everything.
  await pressSend(el);
  expect(line(el)).toBe(UPLOADING_LINE);
  await paste(el, notes('b.txt'));
  expect(tiles(el)).toBe(2);
  expect(line(el)).toBe(null);
  await pressSend(el);
  expect(line(el)).toBe(UPLOADING_LINE);
  await dropOnPane(el, notes('c.txt'));
  expect(tiles(el)).toBe(3);
  expect(line(el)).toBe(null);
  await pressSend(el);
  expect(line(el)).toBe(UPLOADING_LINE);
  await paperclip(el, notes('d.txt'));
  expect(tiles(el)).toBe(4);
  expect(line(el)).toBe(null);
  expect(field(el)!.value).toBe('Ship the retry change.');
});

test.skipIf(!hasDom)('a phone: the paperclip clears the line too', async () => {
  const el = await open(true);
  typeOn(el, 'From the phone.');
  await paperclip(el, notes('a.txt'));
  await pressSend(el);
  expect(line(el)).toBe(UPLOADING_LINE);
  await paperclip(el, notes('b.txt'));
  expect(tiles(el)).toBe(2);
  expect(line(el)).toBe(null);
});

test.skipIf(!hasDom)('a refused Send: its line stays until files come in; another thread and back, it does not come back', async () => {
  refuseReplies = true;
  const el = await open();
  typeOn(el, 'Refused the first time.');
  await pressSend(el);
  await until(() => line(el) !== null, 'the refused Send\'s line');
  const refused = line(el)!;
  expect(refused.includes(REFUSED)).toBe(true);
  expect(field(el)!.value).toBe('Refused the first time.');
  // To another thread and back: the line was this visit's, and goes with it.
  act(() => draw(TWO));
  await settle();
  expect(line(el)).toBe(null);
  act(() => draw(ONE));
  await settle();
  expect(line(el)).toBe(null);
  // Refused again, then a paste: the line goes, the words stay.
  if (!field(el)) {
    await act(async () => el.querySelector<HTMLButtonElement>('[data-reply-button]')!.click());
    await settle(2);
  }
  await pressSend(el);
  await until(() => line(el) !== null, 'the line again');
  await paste(el, notes('b.txt'));
  expect(line(el)).toBe(null);
  expect(field(el)!.value).toBe('Refused the first time.');
});

test.skipIf(!hasDom)('one line for the pane: the first frame on another thread shows the line as it was, never that thread\'s line from an earlier visit', async () => {
  refuseReplies = true;
  const el = await open();
  typeOn(el, 'Refused the first time.');
  await pressSend(el);
  await until(() => line(el) !== null, 'the refused Send\'s line');
  const refused = line(el)!;
  // To the other thread: its first frame still shows the line there was, then the arrival sets the thread's own.
  committed = [];
  act(() => draw(TWO));
  expect(committed.length).toBe(1);
  expect(committed[0]).toBe(refused);
  await settle();
  expect(line(el)).toBe(null);
  // On the other thread, a Send while a file uploads: a line of its own.
  if (!field(el)) {
    await act(async () => el.querySelector<HTMLButtonElement>('[data-reply-button]')!.click());
    await settle(2);
  }
  typeOn(el, 'For the export.');
  await paperclip(el, notes('a.txt'));
  await pressSend(el);
  expect(line(el)).toBe(UPLOADING_LINE);
  // Back: the first frame shows that line still, not the refused one left on this thread at the last visit.
  committed = [];
  act(() => draw(ONE));
  expect(committed.length).toBe(1);
  expect(committed[0]).toBe(UPLOADING_LINE);
  await settle();
  expect(line(el)).toBe(null);
});

test.skipIf(!hasDom)('a computer: "Not saved" over the row while a save did not land, never beside a conflict', async () => {
  const el = await open();
  typeOn(el, 'Older words.');
  await until(() => drafts.get(ONE)?.body === 'Older words.', 'the first save');
  savesFail = true;
  typeOn(el, ' Newer words.');
  await until(() => el.querySelector('[data-reply-note] [data-draft-failed]') !== null, '"Not saved" over the row');
  // Another device saves while this one cannot: back on the thread, the conflict shows, and only it.
  act(() => draw(TWO));
  await settle();
  savesFail = false;
  saveElsewhere(ONE, 'The iPad wrote this.');
  act(() => draw(ONE));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  await settle(4);
  expect(el.querySelector('[data-reply-note]') === null).toBe(true);
  expect(field(el)?.value ?? '').toBe('Older words. Newer words.');
});

test.skipIf(!hasDom)('a computer: a save that did not land, then every word deleted: the empty box says nothing; words again, it says "Not saved"', async () => {
  const el = await open();
  savesFail = true;
  typeOn(el, 'Words that never land.');
  await until(() => el.querySelector('[data-reply-note] [data-draft-failed]') !== null, '"Not saved" over the row');
  const text = field(el)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, '');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(30);
  expect(el.querySelector('[data-reply-note]') === null).toBe(true);
  typeOn(el, 'Back again.');
  await until(() => el.querySelector('[data-reply-note] [data-draft-failed]') !== null, '"Not saved" again');
  savesFail = false;
  typeOn(el, ' Saved now.');
  await until(() => drafts.get(ONE)?.body === 'Back again. Saved now.', 'the save once the Inbox answers');
  await until(() => el.querySelector('[data-reply-note]') === null, '"Not saved" gone');
});
