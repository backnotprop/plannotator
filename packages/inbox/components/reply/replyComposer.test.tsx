/**
 * The reply box's controller (useReplyComposer.tsx) under a fake host: its own uploader, draft store and send, no
 * Inbox. Failures this catches: a Send that reaches the host while a file uploads (from the button or ⌘Enter); a draft
 * save that lands after the Send cleared the draft, or runs while it is out; words or files lost to a Send that
 * failed, or left in the box after one that went; a double press sending twice; two boxes on one thread sharing
 * mentions; and, with `browserStorage: false`, anything written to localStorage or sessionStorage.
 *
 * Assertions compare strings and numbers, never elements (a failed `expect(element)` can take bun down).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DraftFileUploader, ReplyDraftSaveInput, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import type { InboxReplyDraft, InboxUpload } from '@plannotator/core/inbox-types';
import type { ReplyComposerHandle } from './useReplyComposer';
import type { ReplyComposerHost, ReplySendResult } from './replyComposerHost';

const hasDom = typeof document !== 'undefined';
const { ReplyBox } = (hasDom ? await import('./ReplyBox') : {}) as typeof import('./ReplyBox');
const { useReplyComposer, UPLOADING_LINE } = (hasDom ? await import('./useReplyComposer') : {}) as typeof import('./useReplyComposer');
const { REPLY_DRAFT_SAVE_MS } = (hasDom ? await import('../../replyDraft') : {}) as typeof import('../../replyDraft');
const { mentionTakerOpen } = (hasDom ? await import('../../threadMentions') : {}) as typeof import('../../threadMentions');

const THREAD = 'msg_01M6RF00000000000000000001';
const OTHER = 'msg_01M6RF00000000000000000002';
const STAMP = '2026-11-02T10:10:00.000Z';
const upload = (id: string, name: string): InboxUpload => ({ upload_id: id, name, size: 9, kind: 'text', sha256: 'a'.repeat(64), created_at: STAMP });

/** A host's store: one draft per thread; every save and discard it was asked for, in order. */
function fakeStore(opts: { refuse?: boolean } = {}) {
  const drafts = new Map<string, InboxReplyDraft>();
  const saves: string[] = [];
  const discards: (string | null | undefined)[] = [];
  let clock = 0;
  const store: ReplyDraftStore = {
    read: async (threadId) => drafts.get(threadId) ?? null,
    save: async (threadId, input: ReplyDraftSaveInput) => {
      saves.push(input.body);
      if (opts.refuse) throw new TypeError('Failed to fetch');
      clock += 1;
      const draft: InboxReplyDraft = { v: 1, thread_id: threadId, body: input.body, created_at: STAMP, updated_at: new Date(Date.UTC(2026, 10, 2, 11, 0, clock)).toISOString() };
      drafts.set(threadId, draft);
      return { draft };
    },
    discard: async (threadId, options) => {
      discards.push(options?.base);
      drafts.delete(threadId);
    },
  };
  return { store, drafts, saves, discards };
}

/** A host's uploader: each upload held until the test lets it end. */
function fakeUploader() {
  const finish: ((upload: InboxUpload) => void)[] = [];
  const uploader: DraftFileUploader = { upload: () => new Promise<InboxUpload>((resolve) => finish.push(resolve)), readText: async () => '' };
  return { uploader, finish };
}

/** A host's send: every call, each held until the test ends it. */
function fakeSend() {
  const calls: { result: ReplySendResult; savesThen: number }[] = [];
  const ends: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let savesNow = () => 0;
  const send = (result: ReplySendResult) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ result, savesThen: savesNow() });
      ends.push({ resolve, reject });
    });
  return { send, calls, ends, watch: (saves: () => number) => (savesNow = saves) };
}

function Box({ host, out }: { host: ReplyComposerHost; out: { current: ReplyComposerHandle } }) {
  const { box, handle } = useReplyComposer(host);
  out.current = handle;
  return (
    <div className="pn-inbox" data-box={host.threadId}>
      <ReplyBox {...box.props} />
    </div>
  );
}

let roots: { root: Root; el: HTMLElement }[] = [];
afterEach(() => {
  for (const { root, el } of roots) {
    act(() => root.unmount());
    el.remove();
  }
  roots = [];
});

const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

function mount(host: ReplyComposerHost): { el: HTMLElement; handle: { current: ReplyComposerHandle } } {
  const out = { current: null as unknown as ReplyComposerHandle };
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<Box host={host} out={out} />));
  roots.push({ root, el });
  return { el, handle: out };
}

function typeIn(el: HTMLElement, words: string) {
  const text = el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    setter.call(text, words);
    text.setSelectionRange(words.length, words.length);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const field = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
const pressSend = (el: HTMLElement) => act(() => el.querySelector<HTMLButtonElement>('[data-reply-send]')!.click());
const chord = (el: HTMLElement) => act(() => void field(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })));
const errorOf = (el: HTMLElement) => el.querySelector('.ib-error')?.textContent ?? '';
const tiles = (el: HTMLElement) => el.querySelectorAll('[data-reply-files] [data-compose-file]').length;
const notes = (name: string) => new File(['the notes'], name, { type: 'text/plain' });

function host(over: Partial<ReplyComposerHost> & Pick<ReplyComposerHost, 'send' | 'draftStore' | 'uploader'>): ReplyComposerHost {
  return { threadId: THREAD, browserStorage: false, placeholder: 'Write to harbor', replyToNames: 'harbor', ...over };
}

test.skipIf(!hasDom)('a Send while a file uploads never reaches the host, from the button or from the chord', async () => {
  const store = fakeStore();
  const up = fakeUploader();
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: store.store, uploader: up.uploader }));
  await wait(30);
  typeIn(el, 'Notes attached.');
  act(() => handle.current.addFiles([notes('notes.txt')] as unknown as FileList));
  await wait(30);
  pressSend(el);
  chord(el);
  await act(async () => void (await handle.current.send()));
  await wait(30);
  expect(out.calls.length).toBe(0);
  expect(errorOf(el)).toBe(UPLOADING_LINE);
  up.finish[0]!(upload('upl_01', 'notes.txt'));
  await wait(30);
  chord(el);
  await wait(30);
  expect(out.calls.length).toBe(1);
  expect(out.calls[0]!.result.files).toEqual(['upl_01']);
  expect(out.calls[0]!.result.body).toBe('Notes attached.');
});

test.skipIf(!hasDom)('the waiting save goes before the host sends, none runs while it is out, none brings the draft back after', async () => {
  const store = fakeStore();
  const out = fakeSend();
  out.watch(() => store.saves.length);
  const { el } = mount(host({ send: out.send, draftStore: store.store, uploader: fakeUploader().uploader }));
  await wait(30);
  // Typed, and Send pressed inside the pause.
  typeIn(el, 'Ship it on Friday.');
  pressSend(el);
  await wait(30);
  expect(out.calls.length).toBe(1);
  expect(out.calls[0]!.savesThen).toBe(1);
  expect(store.saves).toEqual(['Ship it on Friday.']);
  const version = store.drafts.get(THREAD)!.updated_at;
  expect(out.calls[0]!.result.draft).toBe(version);
  // A key typed while it is out is not saved (the words are the Send's).
  typeIn(el, 'Ship it on Friday. And more.');
  await wait(REPLY_DRAFT_SAVE_MS + 150);
  expect(store.saves.length).toBe(1);
  await act(async () => out.ends[0]!.resolve());
  await wait(REPLY_DRAFT_SAVE_MS + 150);
  expect(store.discards).toEqual([version]);
  expect(store.drafts.has(THREAD)).toBe(false);
  expect(store.saves.length).toBe(1);
  expect(field(el).value).toBe('');
});

test.skipIf(!hasDom)('a Send that fails keeps the words and files and says the host\'s line; one that goes empties the box', async () => {
  const store = fakeStore();
  const up = fakeUploader();
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: store.store, uploader: up.uploader }));
  await wait(30);
  typeIn(el, 'The report is attached.');
  act(() => handle.current.addFiles([notes('report.txt')] as unknown as FileList));
  await wait(30);
  up.finish[0]!(upload('upl_02', 'report.txt'));
  await wait(30);
  const tilesBefore = tiles(el);
  expect(tilesBefore > 0).toBe(true);
  pressSend(el);
  await wait(30);
  await act(async () => out.ends[0]!.reject(new Error('The space is read-only. Ask its owner.')));
  await wait(30);
  expect(errorOf(el)).toBe('The space is read-only. Ask its owner.');
  expect(field(el).value).toBe('The report is attached.');
  expect(tiles(el)).toBe(tilesBefore);
  expect(store.discards.length).toBe(0);
  // Typing again saves again (the Send gave the draft back).
  const saved = store.saves.length;
  typeIn(el, 'The report is attached. Again.');
  await wait(REPLY_DRAFT_SAVE_MS + 150);
  expect(store.saves.length).toBe(saved + 1);
  pressSend(el);
  await wait(30);
  expect(out.calls.length).toBe(2);
  expect(out.calls[1]!.result.files).toEqual(['upl_02']);
  await act(async () => out.ends[1]!.resolve());
  await wait(30);
  expect(field(el).value).toBe('');
  expect(tiles(el)).toBe(0);
  expect(errorOf(el)).toBe('');
  expect(store.drafts.has(THREAD)).toBe(false);
});

test.skipIf(!hasDom)('a double press sends once', async () => {
  const store = fakeStore();
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: store.store, uploader: fakeUploader().uploader }));
  await wait(30);
  typeIn(el, 'Once.');
  act(() => {
    el.querySelector<HTMLButtonElement>('[data-reply-send]')!.click();
    el.querySelector<HTMLButtonElement>('[data-reply-send]')!.click();
  });
  chord(el);
  void handle.current.send();
  await wait(30);
  expect(out.calls.length).toBe(1);
  await act(async () => out.ends[0]!.resolve());
  await wait(30);
  expect(out.calls.length).toBe(1);
});

test.skipIf(!hasDom)('two boxes on one thread keep their own mentions: one asked for goes into its own box only', async () => {
  const a = mount(host({ send: fakeSend().send, draftStore: fakeStore().store, uploader: fakeUploader().uploader }));
  const b = mount(host({ send: fakeSend().send, draftStore: fakeStore().store, uploader: fakeUploader().uploader }));
  await wait(30);
  expect(a.handle.current.mentions === b.handle.current.mentions).toBe(false);
  // Each field took the way in on its own scope; the Inbox's has no box open on this thread.
  expect(a.handle.current.mentions.mentionTakerOpen(THREAD)).toBe(true);
  expect(b.handle.current.mentions.mentionTakerOpen(THREAD)).toBe(true);
  expect(mentionTakerOpen(THREAD)).toBe(false);
  typeIn(a.el, 'See ');
  typeIn(b.el, 'See ');
  act(() => a.handle.current.mentions.requestMention(THREAD, [{ id: OTHER, title: 'Rate limit' }]));
  await wait(30);
  expect(field(a.el).value.includes('Rate limit')).toBe(true);
  expect(field(b.el).value).toBe('See ');
  const text = field(a.el).value;
  expect(a.handle.current.mentions.mentionsFor(THREAD, text).map((m) => m.thread_id)).toEqual([OTHER]);
  expect(b.handle.current.mentions.mentionsFor(THREAD, text).length).toBe(0);
});

/** Every write to either store, and both stores' contents. */
function watchStorage() {
  const writes: string[] = [];
  const proto = Storage.prototype;
  const was = { setItem: proto.setItem, removeItem: proto.removeItem, clear: proto.clear };
  proto.setItem = function (key: string, value: string) {
    writes.push(`set ${key}`);
    return was.setItem.call(this, key, value);
  };
  proto.removeItem = function (key: string) {
    writes.push(`remove ${key}`);
    return was.removeItem.call(this, key);
  };
  proto.clear = function () {
    writes.push('clear');
    return was.clear.call(this);
  };
  const snap = () => JSON.stringify([localStorage, sessionStorage].map((s) => Object.fromEntries(Array.from({ length: s.length }, (_, i) => [s.key(i)!, s.getItem(s.key(i)!)]))));
  return { writes, snap, restore: () => Object.assign(proto, was) };
}

/** Type, attach, a draft save refused, a Send refused, then one that goes. */
async function useTheBox(browserStorage: boolean) {
  const store = fakeStore({ refuse: true });
  const up = fakeUploader();
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: store.store, uploader: up.uploader, browserStorage }));
  await wait(30);
  typeIn(el, 'Words a shared computer must not keep.');
  act(() => handle.current.addFiles([notes('notes.txt')] as unknown as FileList));
  await wait(30);
  up.finish[0]!(upload('upl_03', 'notes.txt'));
  await wait(REPLY_DRAFT_SAVE_MS + 150);
  pressSend(el);
  await wait(30);
  await act(async () => out.ends[0]!.reject(new Error('Not sent.')));
  await wait(REPLY_DRAFT_SAVE_MS + 150);
  pressSend(el);
  await wait(30);
  await act(async () => out.ends[1]!.resolve());
  await wait(30);
  return { sends: out.calls.length, saves: store.saves.length };
}

test.skipIf(!hasDom)('with browserStorage false the box writes nothing to localStorage or sessionStorage', async () => {
  localStorage.clear();
  sessionStorage.clear();
  const watch = watchStorage();
  try {
    const before = watch.snap();
    const used = await useTheBox(false);
    expect(used.sends).toBe(2);
    expect(used.saves > 0).toBe(true);
    expect(watch.writes).toEqual([]);
    expect(watch.snap()).toBe(before);
  } finally {
    watch.restore();
  }
});

test.skipIf(!hasDom)('the same use with browserStorage true does write there (the watch sees writes)', async () => {
  localStorage.clear();
  sessionStorage.clear();
  const watch = watchStorage();
  try {
    await useTheBox(true);
    expect(watch.writes.length > 0).toBe(true);
  } finally {
    watch.restore();
    localStorage.clear();
  }
});
