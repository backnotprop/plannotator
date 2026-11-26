/**
 * Assertions compare booleans, numbers and strings, never elements (a failed `expect(element)` can take the test
 * process down instead of failing the test).
 *
 * A reply typed in a linked computer's thread is that thread's draft, kept on the thread's own computer (mark
 * `reply-drafts`; docs/agent-guides/inbox-machines.md, "Reply drafts"), with the guarantees a local draft has: typing is a
 * draft, it outlives leaving the thread and a new page, two computers typing at once show the conflict line and never
 * overwrite, a sleeping computer gets the words once when it wakes, and a Send clears it there for good.
 *
 * The thread pane over this Inbox's real forward for drafts (packages/server/inbox-machine-drafts.ts, holding drafts
 * in a temp folder) and a stand-in for the other computer's door holding its drafts with the store's compare-and-set
 * (`base`, `base_body`). The other computer is online or asleep on cue. An older Plannotator there (no mark) keeps
 * today's behaviour: nothing is sent, the words are kept in this page and the leave guard asks; once it updates, those
 * words are saved there once.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyReplyDraftFileOps } from '@plannotator/core/inbox-reply-draft';
import type { InboxAuthor, InboxDraftFile, InboxMessageWire, InboxProject, InboxReplyDraft, InboxThread, InboxUpload } from '@plannotator/core/inbox-types';
import type { MachineView } from './api';
import type { Signal } from './signal';
import { createMachineDrafts, type DraftPeer } from '../server/inbox-machine-drafts';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { replyDraftUnsaved, resetReplyDraftPageForTests } = (hasDom ? await import('./replyDraft') : {}) as typeof import('./replyDraft');
const { unsentReply } = (hasDom ? await import('./unsent') : {}) as typeof import('./unsent');
const { createSignal } = (hasDom ? await import('./signal') : {}) as typeof import('./signal');
const { rememberMachine, resetMachineRoutes, setSelfMachine } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MINI = `ibx_01K${'0'.repeat(22)}M`;
const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_a', name: 'Codex' };
/** A thread on this computer, and one on the Mini. */
const HERE = 'msg_01M6RF0000000000000000001';
const FAR = 'msg_01M6RF0000000000000000002';
const MINI_VIEW: MachineView = { id: MINI, name: 'Mini', self: false, state: 'online', since: '2026-11-02T09:00:00.000Z', reason: null, version: '0.29.5', address: null, both_ways: true, waiting: 0 };

const threadOf = (id: string, subject: string): InboxThread => ({
  thread_id: id,
  project: PROJECT,
  subject,
  thread_name: null,
  resolved_at: null,
  messages: [
    { id, project_id: PROJECT.id, thread_id: id, reply_to: null, author: A, subject, body: 'The retry loop backs off two, four and eight seconds.', created_at: '2026-11-02T10:01:00.000Z', resolved_at: null, idempotency_key: null } as InboxMessageWire,
  ],
});

/** The Mini: its drafts, its uploads, and every draft write that reached its door. */
let mini: { drafts: Map<string, InboxReplyDraft>; uploads: Map<string, InboxUpload>; writes: { route: string; body: string; status: number }[]; lastKey: Map<string, string>; clock: number };
/** Every reply the window sent to the Mini. */
let replies: Record<string, unknown>[] = [];
/** Draft requests that went to this computer's own draft routes (a far thread's never should). */
let localDraftCalls: string[] = [];
let here = '';
let peer: DraftPeer & { state: string; list: NonNullable<DraftPeer['list']> };
let forward: ReturnType<typeof createMachineDrafts>;
let root: Root | null = null;
let host: HTMLElement | null = null;
/** The Mini takes uploads but gives no answer to a draft write (it is held here), while true. */
let draftPostsFail = false;
/** The Mini refuses a draft write (422), while true. */
let draftPostsRefused = false;
/** The next draft save waits for this before it reaches the Mini (`saveHeld` once it does). */
let saveGate: Promise<void> | null = null;
let saveHeld = false;
let savedFetch: typeof fetch;
let savedXhr: typeof XMLHttpRequest;
let signal: Signal;

const stamp = () => new Date(Date.UTC(2026, 10, 2, 11, 0, (mini.clock += 1))).toISOString();

/**
 * The Mini's door for a thread's draft, as its store answers (inbox-reply-drafts.ts): the compare-and-set on `base`, or
 * on the words (`base_body`); a Discard must name `base` (inbox-devices.ts `requires`) and takes the draft only while it
 * is still that version. Its door keeps no answer of a draft write (`carries: "draft"`): a save sent again under the
 * key of the save that made the draft is answered with that draft, nothing written again (the store's `last_key`);
 * anything else is the compare-and-set again.
 */
function miniDoor(route: string, method: string, body: Record<string, unknown> = {}): Response {
  const match = /^threads\/([^/]+)\/draft(\/delete)?$/.exec(route);
  if (!match) return Response.json({ code: 'device_route_not_found' }, { status: 404 });
  const thread = match[1]!;
  const current = mini.drafts.get(thread) ?? null;
  if (method === 'GET') return Response.json({ draft: current });
  if (match[2] && !('base' in body)) return Response.json({ error: 'base: required here.', code: 'validation_error', field: 'base' }, { status: 422 });
  const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : null;
  if (!match[2] && key && current && mini.lastKey.get(thread) === key) return Response.json({ draft: current });
  const conflict = { status: 409, json: { error: 'This reply changed in another window since you opened it.', code: 'draft_conflict', draft: current } };
  let out: { status: number; json: unknown };
  if (match[2]) {
    if (current && current.updated_at !== body.base) out = conflict;
    else {
      mini.drafts.delete(thread);
      mini.lastKey.delete(thread);
      out = { status: 200, json: { ok: true, deleted: current !== null } };
    }
  } else {
    const base = (body.base as string | null | undefined) ?? null;
    if ((current?.updated_at ?? null) !== base && !(current && typeof body.base_body === 'string' && current.body === body.base_body)) out = conflict;
    else {
      const add = ((body.files_add as { upload_id: string }[] | undefined) ?? []).flatMap((ref) => (mini.uploads.has(ref.upload_id) ? [mini.uploads.get(ref.upload_id)!] : []));
      const files = applyReplyDraftFileOps<InboxDraftFile>(current?.files ?? [], { add, remove: (body.files_remove as string[] | undefined) ?? [], place: [] });
      const words = String(body.body ?? '');
      if (words.trim() === '' && files.length === 0) {
        mini.drafts.delete(thread);
        mini.lastKey.delete(thread);
      } else {
        const at = stamp();
        mini.drafts.set(thread, { v: 1, thread_id: thread, body: words, created_at: current?.created_at ?? at, updated_at: at, ...(files.length > 0 ? { files } : {}) });
        if (key) mini.lastKey.set(thread, key);
        else mini.lastKey.delete(thread);
      }
      out = { status: 200, json: { draft: mini.drafts.get(thread) ?? null } };
    }
  }
  mini.writes.push({ route, body: String(body.body ?? ''), status: out.status });
  return Response.json(out.json, { status: out.status });
}

/** The Mini's own window saves the thread's draft (on the draft it holds), and its stream tells this Inbox. */
async function typedOnTheMini(thread: string, words: string) {
  const answer = miniDoor(`threads/${thread}/draft`, 'POST', { body: words, base: mini.drafts.get(thread)?.updated_at ?? null, files_add: [], files_remove: [], files_place: [] });
  expect(answer.status).toBe(200);
  forward.farChanged(MINI, thread);
  await act(async () => signal.emit());
}

/** The linked machines as the merged list says them: the Mini with `marks`. */
function linked(marks: string[]) {
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Studio' },
    { id: MINI, name: 'Mini', marks, list_cursor: 3, state: peer?.state ?? 'online' },
  ]);
  if (peer) peer.list = { marks, rows: [] };
}

/** An upload as XHR sends it (uploadFile): to the Mini through the forward while it is online, refused while it sleeps. */
class FakeXhr {
  status = 0;
  responseText = '';
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = '';
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  abort() {}
  send(file: File) {
    setTimeout(() => {
      if (!this.url.startsWith(`/api/inbox/m/${MINI}/uploads`) || peer.state !== 'online') {
        this.status = 503;
        this.responseText = JSON.stringify({ error: 'Mini cannot be reached now.', code: 'machine_offline' });
      } else {
        const upload: InboxUpload = { upload_id: `upl_${mini.uploads.size + 1}`, name: file.name, size: file.size, kind: 'text', sha256: String(mini.uploads.size + 1).repeat(64).slice(0, 64), created_at: '2026-11-02T10:00:00.000Z' };
        mini.uploads.set(upload.upload_id, upload);
        forward.noteUpload(Response.json({ upload }));
        this.status = 200;
        this.responseText = JSON.stringify({ upload });
      }
      this.onload?.();
    }, 5);
  }
}

beforeEach(() => {
  if (!hasDom) return;
  mini = { drafts: new Map(), uploads: new Map(), writes: [], lastKey: new Map(), clock: 0 };
  draftPostsFail = false;
  draftPostsRefused = false;
  saveGate = null;
  saveHeld = false;
  replies = [];
  localDraftCalls = [];
  signal = createSignal();
  here = mkdtempSync(join(tmpdir(), 'plannotator-far-reply-drafts-'));
  peer = {
    id: MINI,
    state: 'online',
    list: { marks: ['reply-drafts'], rows: [] },
    async request(route, _search, init) {
      if (peer.state !== 'online') throw new Error('unreachable');
      if (draftPostsFail && init.method === 'POST') throw new Error('no answer');
      if (draftPostsRefused && init.method === 'POST') return Response.json({ error: 'Not this time.', code: 'validation_error' }, { status: 422 });
      if (saveGate && init.method === 'POST' && !route.endsWith('/delete')) {
        const gate = saveGate;
        saveGate = null;
        saveHeld = true;
        await gate;
      }
      return miniDoor(route, init.method, init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    },
    poke() {},
    refreshList: async () => {},
    listAsked: 0,
    listGen: 0,
  };
  // This Inbox tells its windows when a thread's draft changes as it shows it (`event: drafts`).
  forward = createMachineDrafts({ dataDir: here, peer: () => peer, onChange: () => signal.emit(), retryMs: 60_000 });
  rememberMachine([FAR], MINI);
  savedFetch = globalThis.fetch;
  savedXhr = globalThis.XMLHttpRequest;
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    // This Inbox's forward to the Mini (inbox-machines.ts): a thread's draft goes its own way.
    const far = new RegExp(`^/api/inbox/m/${MINI}/(.+)$`).exec(path)?.[1];
    const draftRoute = far ? /^threads\/([^/]+)\/draft(\/delete)?$/.exec(far) : null;
    if (far && draftRoute) {
      const thread = decodeURIComponent(draftRoute[1]!);
      if (init?.method !== 'POST') {
        const kept = forward.read(peer, thread);
        if (kept) return Response.json(kept);
        if (peer.state !== 'online') return Response.json({ error: 'Mini cannot be reached now.', code: 'machine_offline' }, { status: 503 });
        const answer = await peer.request(far, '', { method: 'GET', headers: {} });
        forward.noteRead(MINI, thread, answer.clone());
        // As inbox-machines.ts: the person's words (or files) the draft there does not hold go with its read.
        const offered = answer.ok ? forward.notLanded(MINI, thread) : null;
        return offered ? Response.json({ ...((await answer.json()) as Record<string, unknown>), not_landed: offered }) : answer;
      }
      delete body.serverSession;
      const answer = await forward.write(peer, thread, !!draftRoute[2], body);
      return 'far' in answer ? answer.far : Response.json(answer.body, { status: answer.status });
    }
    if (far && /^messages\/[^/]+\/reply$/.test(far) && init?.method === 'POST') {
      replies.push(body);
      // The Mini's clear (`clear_draft`): the draft it names by its `updated_at`, or ('') one holding exactly these words.
      const kept = mini.drafts.get(FAR);
      const clear = body.clear_draft;
      if (kept && typeof clear === 'string' && (clear === kept.updated_at || (clear === '' && kept.body.trim() === String(body.words ?? '').trim()))) {
        mini.drafts.delete(FAR);
        mini.lastKey.delete(FAR);
      }
      return Response.json({ reply: { id: 'msg_reply' }, questions: [], replayed: false });
    }
    if (/^\/api\/inbox\/threads\/[^/]+\/draft/.test(path)) {
      localDraftCalls.push(`${init?.method ?? 'GET'} ${path}`);
      return Response.json({ serverSession: 's', draft: null });
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
  for (let i = 0; i < 100 && replyDraftUnsaved(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const left = replyDraftUnsaved();
  globalThis.fetch = savedFetch;
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = savedXhr;
  resetReplyDraftPageForTests();
  localStorage.clear();
  resetMachineRoutes();
  rmSync(here, { recursive: true, force: true });
  if (left) throw new Error('the test left a reply draft save on its way, or words not saved');
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

function draw(id: string, machine: MachineView | null = null) {
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={threadOf(id, id === HERE ? 'Retry worker' : 'Ledger export')} machine={machine} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} draftSignal={signal} />
    </div>,
  );
}

async function open(id = FAR, machine: MachineView | null = null): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(id, machine);
  });
  await settle();
  return host;
}

/** A new page of this browser: nothing this page held in memory or in the browser's storage. */
async function newPage(id = FAR): Promise<HTMLElement> {
  act(() => root?.unmount());
  host?.remove();
  resetReplyDraftPageForTests();
  localStorage.clear();
  return open(id);
}

/** A reload: a new page of this browser, its storage kept (the words an ended tab kept come back from it). */
async function reloadKeepingStorage(marks: string[]): Promise<HTMLElement> {
  act(() => root?.unmount());
  host?.remove();
  resetReplyDraftPageForTests();
  // The ended tab's heartbeat is old: its words are free to take.
  for (const key of Object.keys(localStorage)) if (key.startsWith('plannotator-inbox-reply-kept-alive:')) localStorage.setItem(key, String(Date.now() - 60_000));
  linked(marks);
  return open();
}

/** What browser storage keeps for the far thread: each entry's kind and words. */
const keptFor = (thread: string) =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith('plannotator-inbox-reply-kept:'))
    .map((key) => JSON.parse(localStorage.getItem(key)!) as { thread: string; kind: string; words: string })
    .filter((entry) => entry.thread === thread)
    .map((entry) => `${entry.kind}:${entry.words}`)
    .sort();

const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea');
const conflictShown = (el: HTMLElement) => el.querySelector('[data-draft-conflict]') !== null;
const notSavedShown = (el: HTMLElement) => el.querySelector('[data-draft-failed]') !== null;
const tiles = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.ib-rbox [data-compose-file]')].map((t) => `${t.getAttribute('data-compose-file-name')}:${t.getAttribute('data-compose-file')}`);
const farWrites = () => mini.writes.filter((write) => write.route === `threads/${FAR}/draft`);

async function reply(el: HTMLElement) {
  const button = el.querySelector<HTMLButtonElement>('[data-reply-button]');
  expect(!!button).toBe(true);
  await act(async () => button!.click());
  await settle(2);
  expect(!!box(el)).toBe(true);
}

/** Keys typed at the end of the box's words, as a person types them. */
function typeOn(el: HTMLElement, words: string) {
  const text = box(el)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    const next = text.value + words;
    setter.call(text, next);
    text.setSelectionRange(next.length, next.length);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function discardInBox(el: HTMLElement) {
  const bin = el.querySelector<HTMLButtonElement>('[data-reply-discard]');
  expect(!!bin).toBe(true);
  await act(async () => bin!.click());
  await settle(3);
}

test.skipIf(!hasDom)("typed in the Mini's thread: the draft is saved on the Mini, and it is there after leaving the thread and coming back", async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Words for the Mini thread.');
  await until(() => mini.drafts.get(FAR)?.body === 'Words for the Mini thread.', 'the draft on the Mini');
  expect(localDraftCalls.filter((call) => call.startsWith('POST'))).toEqual([]);
  expect(forward.heldCount(MINI)).toBe(0);
  act(() => draw(HERE));
  await settle();
  act(() => draw(FAR));
  await until(() => box(el)?.value === 'Words for the Mini thread.', 'the draft back in the box');
  expect(replyDraftUnsaved()).toBe(false);
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("typed in the Mini's thread, then a new page (a reload, a closed tab): the draft comes back from the Mini", async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Kept across a reload.');
  await until(() => mini.drafts.get(FAR)?.body === 'Kept across a reload.', 'the draft on the Mini');
  linked(['reply-drafts']);
  const next = await newPage();
  linked(['reply-drafts']);
  await until(() => box(next)?.value === 'Kept across a reload.', 'the draft back in the box');
  await discardInBox(next);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)('typed on both computers at once: the conflict line shows, the Mini keeps its words, and nothing is written over', async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'From the Studio.');
  await until(() => mini.drafts.get(FAR)?.body === 'From the Studio.', 'the first save on the Mini');
  // More words here, and before they are saved the Mini's own window rewrites the draft.
  typeOn(el, ' More from the Studio.');
  await typedOnTheMini(FAR, 'From the Mini.');
  await until(() => conflictShown(el), 'the conflict line');
  await settle(30);
  expect(mini.drafts.get(FAR)?.body).toBe('From the Mini.');
  expect(box(el)!.value).toBe('From the Studio. More from the Studio.');
  expect(unsentReply() !== null).toBe(true);
  // Discard mine: only these words go; the Mini's draft stays and comes into the box.
  await discardInBox(el);
  await until(() => box(el)?.value === 'From the Mini.', "the Mini's words in the box");
  expect(mini.drafts.get(FAR)?.body).toBe('From the Mini.');
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)('the Mini asleep: the words are held here and shown as saved, and when it wakes they land there once', async () => {
  peer.state = 'offline';
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Typed while the Mini sleeps.');
  await until(() => forward.heldCount(MINI) === 1, 'the save held here');
  act(() => draw(HERE));
  await settle();
  act(() => draw(FAR));
  await until(() => box(el)?.value === 'Typed while the Mini sleeps.', 'the held words back in the box');
  typeOn(el, ' And more.');
  await settle(35);
  expect(notSavedShown(el)).toBe(false);
  expect(replyDraftUnsaved()).toBe(false);
  expect(mini.writes.length).toBe(0);
  // It wakes: what waits goes, once.
  peer.state = 'online';
  void forward.drain(MINI);
  await until(() => forward.heldCount(MINI) === 0, 'the held save sent');
  await settle(10);
  expect(mini.drafts.get(FAR)?.body).toBe('Typed while the Mini sleeps. And more.');
  expect(farWrites().length).toBe(1);
  expect(box(el)!.value).toBe('Typed while the Mini sleeps. And more.');
  expect(conflictShown(el)).toBe(false);
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("an older Plannotator on the Mini: nothing is sent, the words stay in this page and the leave guard asks; once it updates they are saved there once", async () => {
  linked(['star']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Words for the older Mini.');
  await settle(35);
  expect(mini.writes.length).toBe(0);
  expect(localDraftCalls.filter((call) => call.startsWith('POST'))).toEqual([]);
  expect(unsentReply() !== null).toBe(true);
  act(() => draw(HERE));
  await settle();
  act(() => draw(FAR));
  await until(() => box(el)?.value === 'Words for the older Mini.', 'the words back in the box');
  expect(unsentReply() !== null).toBe(true);
  // The Mini updates: its list now says it keeps reply drafts.
  await act(async () => linked(['star', 'reply-drafts']));
  await until(() => mini.drafts.get(FAR)?.body === 'Words for the older Mini.', 'the kept words saved on the Mini');
  await settle(35);
  expect(farWrites().filter((write) => write.status === 200).length).toBe(1);
  expect(replyDraftUnsaved()).toBe(false);
  expect(box(el)!.value).toBe('Words for the older Mini.');
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("Send in the Mini's thread: its draft there is cleared, and the sent words never come back", async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Ship the fix.');
  await until(() => mini.drafts.get(FAR)?.body === 'Ship the fix.', 'the draft on the Mini');
  const send = el.querySelector<HTMLButtonElement>('[data-reply-send]');
  expect(!!send).toBe(true);
  await act(async () => send!.click());
  await until(() => replies.length === 1, 'the Send');
  expect(replies[0]!.words).toBe('Ship the fix.');
  expect(typeof replies[0]!.clear_draft).toBe('string');
  await until(() => !mini.drafts.has(FAR), 'the draft cleared on the Mini');
  forward.farChanged(MINI, FAR);
  await act(async () => signal.emit());
  await settle(35);
  act(() => draw(HERE));
  await settle();
  act(() => draw(FAR));
  await settle(6);
  expect(box(el)?.value ?? '').toBe('');
  expect(mini.drafts.has(FAR)).toBe(false);
  expect(farWrites().filter((write) => write.status === 200).map((write) => write.body)).toEqual(['Ship the fix.']);
});

test.skipIf(!hasDom)("a file attached in the Mini's thread goes to the Mini and into its draft; while the Mini sleeps the file is refused plainly and the words are still kept", async () => {
  linked(['reply-drafts']);
  const el = await open(FAR, MINI_VIEW);
  await reply(el);
  typeOn(el, 'The export, attached.');
  const input = el.querySelector<HTMLInputElement>('.ib-rbox input[type="file"][data-reply-attach]');
  expect(!!input).toBe(true);
  Object.defineProperty(input!, 'files', { configurable: true, value: [new File(['a,b\n1,2\n'], 'ledger.csv', { type: 'text/csv' })] });
  act(() => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(() => (mini.drafts.get(FAR)?.files ?? []).some((file) => file.name === 'ledger.csv'), 'the file in the draft on the Mini');
  expect(mini.drafts.get(FAR)?.body).toBe('The export, attached.');
  // Asleep: a new file is refused at once, said on its tile; the words typed meanwhile are held here.
  peer.state = 'offline';
  linked(['reply-drafts']);
  Object.defineProperty(input!, 'files', { configurable: true, value: [new File(['x'], 'later.csv', { type: 'text/csv' })] });
  act(() => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(() => tiles(el).includes('later.csv:refused'), 'the file refused on its tile');
  typeOn(el, ' One more line.');
  await until(() => forward.heldCount(MINI) === 1, 'the words held here');
  peer.state = 'online';
  void forward.drain(MINI);
  await until(() => mini.drafts.get(FAR)?.body === 'The export, attached. One more line.', 'the words on the Mini once it wakes');
  expect((mini.drafts.get(FAR)?.files ?? []).map((file) => file.name)).toEqual(['ledger.csv']);
  // The refused tile is the person's to remove or try again; the draft goes.
  const remove = el.querySelector<HTMLButtonElement>('.ib-rbox [data-compose-file="refused"] button');
  if (remove) await act(async () => remove.click());
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("a file a held draft names that the Mini swept before it landed: the words land, and the file's tile says it was not attached (never dropped unsaid) until it is removed", async () => {
  linked(['reply-drafts']);
  const el = await open(FAR, MINI_VIEW);
  await reply(el);
  // The Mini takes the upload but not the draft's saves: they are held here, the file among them.
  draftPostsFail = true;
  typeOn(el, 'The export, attached.');
  const input = el.querySelector<HTMLInputElement>('.ib-rbox input[type="file"][data-reply-attach]');
  Object.defineProperty(input!, 'files', { configurable: true, value: [new File(['a,b\n1,2\n'], 'ledger.csv', { type: 'text/csv' })] });
  act(() => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(() => tiles(el).includes('ledger.csv:done'), 'the file uploaded to the Mini');
  await until(() => forward.read(peer, FAR)?.draft?.files?.some((file) => file.name === 'ledger.csv') === true, 'the file in the held draft');
  // A day later the Mini swept the upload (no draft there named it), then it takes saves again.
  mini.uploads.clear();
  draftPostsFail = false;
  await act(async () => forward.drain(MINI));
  await until(() => mini.drafts.get(FAR)?.body === 'The export, attached.', 'the words on the Mini');
  expect((mini.drafts.get(FAR)?.files ?? []).length).toBe(0);
  forward.farChanged(MINI, FAR);
  await act(async () => signal.emit());
  await until(() => tiles(el).includes('ledger.csv:refused'), 'the tile refused');
  const said = el.querySelector('.ib-rbox [data-compose-file="refused"] [role="alert"]')?.textContent ?? '';
  expect(said).toBe('Not attached: that file could not be added.');
  expect(box(el)!.value).toBe('The export, attached.');
  // Leaving the thread and coming back still says it.
  act(() => draw(HERE));
  await settle();
  act(() => draw(FAR));
  await until(() => tiles(el).includes('ledger.csv:refused'), 'the tile refused after coming back');
  // Removed by the person: it is not said again.
  const x = el.querySelector<HTMLButtonElement>('.ib-rbox [data-compose-file="refused"] .ib-cp-fx');
  await act(async () => x!.click());
  await settle(3);
  forward.farChanged(MINI, FAR);
  await act(async () => signal.emit());
  await settle(6);
  expect(tiles(el).some((tile) => tile.startsWith('ledger.csv'))).toBe(false);
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("words typed while the Mini's marks are not known (this Inbox restarted) after a save it refused: both kept in browser storage apart; a reload with the Mini back saves the newest there, nothing lost or left to come back", async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  draftPostsRefused = true;
  typeOn(el, 'W1 first words.');
  await until(() => notSavedShown(el), 'Not saved');
  // This Inbox restarted: the Mini's list is not read yet, so it is not known to keep drafts.
  await act(async () => linked([]));
  typeOn(el, ' W2 typed after.');
  await settle(35);
  expect(keptFor(FAR)).toEqual(['failed:W1 first words.', 'remote:W1 first words. W2 typed after.']);
  // The tab is reloaded and the Mini's list read again: the newest words are the box's, and saved there once.
  draftPostsRefused = false;
  const next = await reloadKeepingStorage(['reply-drafts']);
  // The words taken back open the box by themselves (otherwise Reply opens it).
  await settle(6);
  if (!box(next)) await reply(next);
  await until(() => box(next)?.value === 'W1 first words. W2 typed after.', 'the newest words in the box');
  await until(() => mini.drafts.get(FAR)?.body === 'W1 first words. W2 typed after.', 'the newest words on the Mini');
  await settle(35);
  expect(farWrites().filter((write) => write.status === 200).length).toBe(1);
  // Saved there: nothing of either is left in storage to come back on a later page.
  await until(() => keptFor(FAR).length === 0, 'browser storage let go once saved');
  await discardInBox(next);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("Discard while the Mini's marks are not known throws away the draft held here for it: the words do not come back when the Mini wakes", async () => {
  peer.state = 'offline';
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Words to throw away.');
  await until(() => forward.heldCount(MINI) === 1, 'the save held here');
  // Its marks not known for now (this Inbox read no list of it since a restart).
  await act(async () => linked([]));
  await discardInBox(el);
  await settle(6);
  linked(['reply-drafts']);
  peer.state = 'online';
  await act(async () => forward.drain(MINI));
  await settle(10);
  expect(mini.drafts.has(FAR)).toBe(false);
  expect(mini.writes.some((write) => write.body === 'Words to throw away.')).toBe(false);
  act(() => draw(HERE));
  await settle();
  act(() => draw(FAR));
  await settle(6);
  expect(box(el)?.value ?? '').toBe('');
});

for (const choice of ['Keep mine', 'Discard mine'] as const) {
  test.skipIf(!hasDom)(`a held save meets newer words typed on the Mini: the conflict line offers ${choice} beside the Mini's words, and nothing is joined`, async () => {
    linked(['reply-drafts']);
    const el = await open();
    await reply(el);
    typeOn(el, 'Start.');
    await until(() => mini.drafts.get(FAR)?.body === 'Start.', 'the first save on the Mini');
    peer.state = 'offline';
    linked(['reply-drafts']);
    typeOn(el, ' Mine from the Studio.');
    await until(() => forward.read(peer, FAR)?.draft?.body === 'Start. Mine from the Studio.', 'the save held here');
    await typedOnTheMini(FAR, 'Start. Theirs from the Mini.');
    peer.state = 'online';
    linked(['reply-drafts']);
    await act(async () => forward.drain(MINI));
    forward.farChanged(MINI, FAR);
    await act(async () => signal.emit());
    await until(() => conflictShown(el), 'the conflict line');
    expect(box(el)!.value).toBe('Start. Mine from the Studio.');
    expect(mini.drafts.get(FAR)?.body).toBe('Start. Theirs from the Mini.');
    const button = el.querySelector<HTMLButtonElement>(choice === 'Keep mine' ? '[data-draft-keep-mine]' : '[data-draft-conflict] [data-draft-discard]');
    expect(!!button).toBe(true);
    await act(async () => button!.click());
    const want = choice === 'Keep mine' ? 'Start. Mine from the Studio.' : 'Start. Theirs from the Mini.';
    await until(() => mini.drafts.get(FAR)?.body === want && box(el)?.value === want, `${choice} settled`);
    await settle(35);
    expect(conflictShown(el)).toBe(false);
    expect(forward.notLanded(MINI, FAR)).toBe(null);
    // Never both: no joined words, there or here.
    for (const words of [mini.drafts.get(FAR)!.body, box(el)!.value]) expect(words.includes('Mine') && words.includes('Theirs')).toBe(false);
    await discardInBox(el);
    await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
  });
}

test.skipIf(!hasDom)("a held conflict's words after another window saved on the Mini's draft: a new window offers them too, and Keep mine of words edited since settles them for good", async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Start.');
  await until(() => mini.drafts.get(FAR)?.body === 'Start.', 'the first save on the Mini');
  peer.state = 'offline';
  linked(['reply-drafts']);
  typeOn(el, ' Mine from the Studio.');
  await until(() => forward.read(peer, FAR)?.draft?.body === 'Start. Mine from the Studio.', 'the save held here');
  await typedOnTheMini(FAR, 'Start. Theirs from the Mini.');
  peer.state = 'online';
  linked(['reply-drafts']);
  await act(async () => forward.drain(MINI));
  // Another window here, which never showed the conflict, saves on the Mini's draft before it reads again.
  const theirs = mini.drafts.get(FAR)!;
  const other = await forward.write(peer, FAR, false, { body: `${theirs.body} A second window.`, base: theirs.updated_at, files_add: [], files_remove: [], files_place: [] });
  expect('far' in other && other.far.status).toBe(200);
  // A new window opening the thread offers the words too: the box holds them, the conflict line beside the Mini's.
  const next = await newPage();
  await settle(6);
  if (!box(next)) await reply(next);
  await until(() => conflictShown(next), 'the conflict line in a new window');
  expect(box(next)!.value).toBe('Start. Mine from the Studio.');
  // Edited (some words deleted), then Keep mine: those words are the draft, and nothing is offered again.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(box(next)!, 'Start. Mine.');
    box(next)!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => next.querySelector<HTMLButtonElement>('[data-draft-keep-mine]')!.click());
  await until(() => mini.drafts.get(FAR)?.body === 'Start. Mine.', 'Keep mine on the Mini');
  await until(() => forward.notLanded(MINI, FAR) === null, 'the offered words settled');
  const again = await newPage();
  await settle(6);
  if (!box(again)) await reply(again);
  await until(() => box(again)?.value === 'Start. Mine.', 'the kept words in a new window');
  await settle(10);
  expect(conflictShown(again)).toBe(false);
  await discardInBox(again);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

for (const choice of ['Keep mine', 'Discard mine'] as const) {
  test.skipIf(!hasDom)(`a window showing its own conflict when words held for the Mini meet newer words there: after ${choice} on its own, the held words are offered in the box, never let go unseen`, async () => {
    peer.state = 'offline';
    linked(['reply-drafts']);
    const el = await open();
    await reply(el);
    // Words typed here, and before they are saved a closed tab's words for the Mini are held here: this window's own
    // save meets them, so its own conflict shows.
    typeOn(el, 'Gamma typed in this window.');
    const held = await forward.write(peer, FAR, false, { body: 'Alpha from a closed tab.', base: null, files_add: [], files_remove: [], files_place: [] });
    expect('status' in held && held.status).toBe(200);
    await until(() => conflictShown(el), "this window's own conflict");
    expect(box(el)!.value).toBe('Gamma typed in this window.');
    // Newer words on the Mini; it wakes, and the held words meet them there.
    await typedOnTheMini(FAR, 'Beta typed on the Mini.');
    peer.state = 'online';
    linked(['reply-drafts']);
    await act(async () => forward.drain(MINI));
    await until(() => forward.notLanded(MINI, FAR)?.words === 'Alpha from a closed tab.', 'the held words offered');
    forward.farChanged(MINI, FAR);
    await act(async () => signal.emit());
    await settle(10);
    expect(box(el)!.value).toBe('Gamma typed in this window.');
    const button = el.querySelector<HTMLButtonElement>(choice === 'Keep mine' ? '[data-draft-keep-mine]' : '[data-draft-conflict] [data-draft-discard]');
    await act(async () => button!.click());
    // The held words now: in the box, the conflict line beside the Mini's draft; still kept there.
    await until(() => box(el)?.value === 'Alpha from a closed tab.' && conflictShown(el), 'the held words offered in the box');
    const theirs = choice === 'Keep mine' ? 'Gamma typed in this window.' : 'Beta typed on the Mini.';
    expect(mini.drafts.get(FAR)?.body).toBe(theirs);
    expect(forward.notLanded(MINI, FAR)?.words).toBe('Alpha from a closed tab.');
    // Their own choice: Discard mine lets them go, and the Mini's draft comes into the box.
    await act(async () => el.querySelector<HTMLButtonElement>('[data-draft-conflict] [data-draft-discard]')!.click());
    await until(() => forward.notLanded(MINI, FAR) === null && box(el)?.value === theirs, 'the held words let go by the person');
    await settle(10);
    expect(conflictShown(el)).toBe(false);
    await discardInBox(el);
    await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
  });
}

test.skipIf(!hasDom)('two held saves meet newer words on the Mini in a row: the first stays offered, and once the person lets it go the second is offered in the box', async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Start.');
  await until(() => mini.drafts.get(FAR)?.body === 'Start.', 'the first save on the Mini');
  peer.state = 'offline';
  linked(['reply-drafts']);
  typeOn(el, ' First held.');
  await until(() => forward.read(peer, FAR)?.draft?.body === 'Start. First held.', 'the save held here');
  await typedOnTheMini(FAR, 'Start. Mini one.');
  peer.state = 'online';
  linked(['reply-drafts']);
  await act(async () => forward.drain(MINI));
  forward.farChanged(MINI, FAR);
  await act(async () => signal.emit());
  await until(() => conflictShown(el) && box(el)?.value === 'Start. First held.', 'the first held words offered');
  // Another window here, which never showed them, saves on the Mini's draft while it sleeps; the Mini types again.
  peer.state = 'offline';
  linked(['reply-drafts']);
  const one = mini.drafts.get(FAR)!;
  const second = await forward.write(peer, FAR, false, { body: 'Start. Mini one. Second held.', base: one.updated_at, base_body: one.body, files_add: [], files_remove: [], files_place: [] });
  expect('status' in second && second.status).toBe(200);
  await typedOnTheMini(FAR, 'Start. Mini two.');
  peer.state = 'online';
  linked(['reply-drafts']);
  await act(async () => forward.drain(MINI));
  forward.farChanged(MINI, FAR);
  await act(async () => signal.emit());
  await settle(10);
  // The first words are still the ones offered, here and there.
  expect(box(el)!.value).toBe('Start. First held.');
  expect(forward.notLanded(MINI, FAR)?.words).toBe('Start. First held.');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-draft-conflict] [data-draft-discard]')!.click());
  await until(() => box(el)?.value === 'Start. Mini one. Second held.' && conflictShown(el), 'the second held words offered in the box');
  expect(mini.drafts.get(FAR)?.body).toBe('Start. Mini two.');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-draft-keep-mine]')!.click());
  await until(() => mini.drafts.get(FAR)?.body === 'Start. Mini one. Second held.' && forward.notLanded(MINI, FAR) === null, 'Keep mine of the second words');
  await settle(10);
  expect(conflictShown(el)).toBe(false);
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("Discard in the Mini's thread after newer words were typed there that this window never showed: those words stay there and come into view", async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'Words this window saw.');
  await until(() => mini.drafts.get(FAR)?.body === 'Words this window saw.', 'the draft on the Mini');
  // Typed on the Mini, its stream not heard here yet.
  const seen = mini.drafts.get(FAR)!;
  expect(miniDoor(`threads/${FAR}/draft`, 'POST', { body: 'Newer words on the Mini.', base: seen.updated_at, files_add: [], files_remove: [], files_place: [] }).status).toBe(200);
  await discardInBox(el);
  await settle(10);
  expect(mini.drafts.get(FAR)?.body).toBe('Newer words on the Mini.');
  act(() => draw(HERE));
  await settle();
  act(() => draw(FAR));
  await settle(6);
  if (!box(el)) await reply(el);
  await until(() => box(el)?.value === 'Newer words on the Mini.', "the Mini's words in the box");
  await discardInBox(el);
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
});

test.skipIf(!hasDom)("Discard pressed while a save of the box is still on its way to the Mini: the words it lands are gone too, in every window", async () => {
  linked(['reply-drafts']);
  const el = await open();
  await reply(el);
  typeOn(el, 'First.');
  await until(() => mini.drafts.get(FAR)?.body === 'First.', 'the first save on the Mini');
  let release = () => {};
  saveGate = new Promise<void>((done) => (release = done));
  typeOn(el, ' Second.');
  await until(() => saveHeld, 'the next save on its way');
  await discardInBox(el);
  release();
  await until(() => mini.writes.some((write) => write.body === 'First. Second.'), 'the save landing on the Mini');
  await until(() => !mini.drafts.has(FAR), 'Discard reaching the Mini');
  await settle(10);
  expect(box(el)?.value ?? '').toBe('');
  expect(forward.heldCount(MINI)).toBe(0);
});
