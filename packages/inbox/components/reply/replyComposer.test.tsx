/**
 * The reply box's controller (useReplyComposer.tsx) under a fake host: its own uploader, draft store and send, no
 * Inbox. Failures this catches: a Send that reaches the host while a file uploads (from the button or ⌘Enter); a draft
 * save that lands after the Send cleared the draft, or runs while it is out; words or files lost to a Send that
 * failed, or left in the box after one that went; a double press sending twice; two boxes on one thread sharing
 * mentions; and, with `browserStorage: false`, anything written to localStorage or sessionStorage. Then the rules of
 * replyComposerHost.ts's note: no discard after a conflict (another window's draft), no store call after a good Send
 * that carried a file, a conflict reaching the host and resolved through `handle.draft`, a reload taking newer words
 * only into an untouched box, a read-only box while a Send is out, a thread change carrying nothing across, a discard
 * that never answers, a host's upload refusal, no fetch of the box's own, an empty Send the host carries content for,
 * the same result for an unchanged box from press to press, when "Not saved" shows, and `to` as the picker shows it.
 *
 * Assertions compare strings and numbers, never elements (a failed `expect(element)` can take bun down).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DraftFileUploader, ReplyDraftSaveInput, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import { INBOX_DRAFT_BODY_MAX, type InboxReplyDraft, type InboxUpload } from '@plannotator/core/inbox-types';
import type { ReplyComposerHandle } from './useReplyComposer';
import type { ReplyComposerHost, ReplyDraftConflict, ReplySendResult } from './replyComposerHost';
import type { RecipientRow } from '../../replyRecipients';

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

/** The last box mounted: its host changed as a host would change it (another thread, another choice of recipients). */
let rehost: (over: Partial<ReplyComposerHost>) => void = () => {};
function Box({ host, out }: { host: ReplyComposerHost; out: { current: ReplyComposerHandle } }) {
  const [over, setOver] = useState<Partial<ReplyComposerHost>>({});
  rehost = setOver;
  const { box, handle } = useReplyComposer({ ...host, ...over });
  out.current = handle;
  return (
    <div className="pn-inbox" data-box={over.threadId ?? host.threadId}>
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

/** A store that refuses a save made on a version it no longer holds (`draft_conflict`), as a server does; every call kept. */
function strictStore() {
  const drafts = new Map<string, InboxReplyDraft>();
  const calls: string[] = [];
  let clock = 0;
  const put = (threadId: string, body: string) => {
    clock += 1;
    const draft: InboxReplyDraft = { v: 1, thread_id: threadId, body, created_at: STAMP, updated_at: new Date(Date.UTC(2026, 10, 2, 11, 0, clock)).toISOString() };
    drafts.set(threadId, draft);
    return draft;
  };
  const store: ReplyDraftStore = {
    read: async (threadId) => drafts.get(threadId) ?? null,
    save: async (threadId, input: ReplyDraftSaveInput) => {
      calls.push(`save ${threadId.slice(-1)} ${JSON.stringify(input.body)}`);
      const held = drafts.get(threadId) ?? null;
      if ((held?.updated_at ?? null) !== input.base) throw Object.assign(new Error('This reply changed in another window since you opened it.'), { code: 'draft_conflict', details: { draft: held } });
      return { draft: put(threadId, input.body) };
    },
    discard: async (threadId, options) => {
      calls.push(`discard ${threadId.slice(-1)} ${options?.base ?? null}`);
      drafts.delete(threadId);
    },
  };
  return { store, drafts, calls, elsewhere: put };
}

const SAVED = REPLY_DRAFT_SAVE_MS + 150;
const LONG = 15_000;
const discards = (calls: readonly string[]) => calls.filter((call) => call.startsWith('discard'));

/** Words saved, then another window saves its own, then the box's next save is refused: the conflict. */
async function raiseConflict(el: HTMLElement, s: ReturnType<typeof strictStore>) {
  typeIn(el, 'Mine first.');
  await wait(SAVED);
  s.elsewhere(THREAD, 'Theirs, from another window.');
  typeIn(el, 'Mine first, and more.');
  await wait(SAVED);
}

test.skipIf(!hasDom)('a conflict keeps the words, pauses saving and reaches the host with the store\'s refusal', async () => {
  const s = strictStore();
  const out = fakeSend();
  const heard: ReplyDraftConflict[] = [];
  const { el, handle } = mount(host({ send: out.send, draftStore: s.store, uploader: fakeUploader().uploader, onDraftConflict: (conflict) => heard.push(conflict) }));
  await wait(30);
  await raiseConflict(el, s);
  expect(field(el).value).toBe('Mine first, and more.');
  expect(handle.current.draft.conflict?.mine).toBe('Mine first, and more.');
  expect(handle.current.draft.conflict?.theirs?.body ?? null).toBe('Theirs, from another window.');
  expect(heard.length).toBe(1);
  expect((heard[0]!.refusal as { code?: string; details?: { draft?: InboxReplyDraft } }).details?.draft?.body ?? null).toBe('Theirs, from another window.');
  // Saving waits for the person's choice; no empty "not saved" line is drawn.
  const calls = s.calls.length;
  typeIn(el, 'Mine first, and more, and more.');
  await wait(SAVED);
  expect(s.calls.length).toBe(calls);
  expect(el.querySelector('[data-reply-note]') === null).toBe(true);
}, LONG);

test.skipIf(!hasDom)('a Send after a conflict clears no draft: result.draft is null, no discard runs, the other window\'s draft stays', async () => {
  const s = strictStore();
  const out = fakeSend();
  const { el } = mount(host({ send: out.send, draftStore: s.store, uploader: fakeUploader().uploader }));
  await wait(30);
  await raiseConflict(el, s);
  pressSend(el);
  await wait(60);
  expect(out.calls[0]!.result.draft).toBe(null);
  await act(async () => out.ends[0]!.resolve());
  await wait(60);
  expect(discards(s.calls)).toEqual([]);
  expect(s.drafts.get(THREAD)?.body ?? null).toBe('Theirs, from another window.');
}, LONG);

test.skipIf(!hasDom)('after a conflict Keep mine saves the box\'s words over the newer draft; Discard mine takes the other window\'s in', async () => {
  const s = strictStore();
  const { el, handle } = mount(host({ send: fakeSend().send, draftStore: s.store, uploader: fakeUploader().uploader }));
  await wait(30);
  await raiseConflict(el, s);
  act(() => handle.current.draft.keepMine());
  await wait(150);
  expect(handle.current.draft.conflict).toBe(null);
  expect(s.drafts.get(THREAD)?.body ?? null).toBe('Mine first, and more.');
  typeIn(el, 'Mine, kept.');
  await wait(SAVED);
  expect(s.drafts.get(THREAD)?.body ?? null).toBe('Mine, kept.');
  s.elsewhere(THREAD, 'Theirs again.');
  typeIn(el, 'Mine, kept, and more.');
  await wait(SAVED);
  expect(handle.current.draft.conflict?.mine ?? null).toBe('Mine, kept, and more.');
  act(() => handle.current.draft.takeTheirs());
  await wait(30);
  expect(handle.current.draft.conflict).toBe(null);
  expect(field(el).value).toBe('Theirs again.');
}, LONG);

test.skipIf(!hasDom)('reload: an untouched box takes newer words from another device; an edited one raises the conflict instead', async () => {
  const s = strictStore();
  const { el, handle } = mount(host({ send: fakeSend().send, draftStore: s.store, uploader: fakeUploader().uploader }));
  await wait(30);
  typeIn(el, 'From this computer.');
  await wait(SAVED);
  s.elsewhere(THREAD, 'From the phone.');
  await act(async () => handle.current.draft.reload());
  await wait(30);
  expect(field(el).value).toBe('From the phone.');
  expect(handle.current.draft.conflict).toBe(null);
  typeIn(el, 'From the phone, edited here.');
  s.elsewhere(THREAD, 'From the phone, again.');
  await act(async () => handle.current.draft.reload());
  await wait(SAVED);
  expect(field(el).value).toBe('From the phone, edited here.');
  expect(handle.current.draft.conflict?.theirs?.body ?? null).toBe('From the phone, again.');
}, LONG);

test.skipIf(!hasDom)('a save that did not land draws no empty line; the host\'s own line shows when it gives one', async () => {
  const bare = mount(host({ send: fakeSend().send, draftStore: fakeStore({ refuse: true }).store, uploader: fakeUploader().uploader }));
  await wait(30);
  typeIn(bare.el, 'Not saved yet.');
  await wait(SAVED);
  expect(bare.handle.current.draft.failed).toBe(true);
  expect(bare.el.querySelector('[data-reply-note]') === null).toBe(true);
  const slotted = mount(host({ send: fakeSend().send, draftStore: fakeStore({ refuse: true }).store, uploader: fakeUploader().uploader, slots: { draftStamp: <span data-host-stamp="">Not saved</span> } }));
  await wait(30);
  typeIn(slotted.el, 'Not saved yet.');
  await wait(SAVED);
  expect(slotted.el.querySelectorAll('[data-reply-note] [data-host-stamp]').length).toBe(1);
}, LONG);

test.skipIf(!hasDom)('"Not saved": a failed save says it while the box holds words or a file, not once it is emptied, never beside a conflict (words too long to save included)', async () => {
  const stamp = { draftStamp: <span data-host-stamp="">Not saved</span> };
  const stamps = (el: HTMLElement) => el.querySelectorAll('[data-reply-note] [data-host-stamp]').length;
  const failing = mount(host({ send: fakeSend().send, draftStore: fakeStore({ refuse: true }).store, uploader: fakeUploader().uploader, slots: stamp }));
  await wait(30);
  typeIn(failing.el, 'Words that never land.');
  await wait(SAVED);
  expect(stamps(failing.el)).toBe(1);
  // Every word deleted: the save still fails, the box holds nothing, and nothing is said.
  typeIn(failing.el, '');
  await wait(SAVED);
  expect(failing.handle.current.draft.failed).toBe(true);
  expect(stamps(failing.el)).toBe(0);
  // A file, no words: the box holds something again.
  const input = failing.el.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [notes('a.txt')] });
  act(() => void input.dispatchEvent(new Event('change', { bubbles: true })));
  await wait(30);
  expect(tiles(failing.el)).toBe(1);
  expect(stamps(failing.el)).toBe(1);
  // A conflict, then words longer than a draft holds: the conflict's own line says it, and "Not saved" does not.
  const s = strictStore();
  const conflicted = mount(host({ send: fakeSend().send, draftStore: s.store, uploader: fakeUploader().uploader, slots: stamp }));
  await wait(30);
  await raiseConflict(conflicted.el, s);
  expect(conflicted.handle.current.draft.conflict === null).toBe(false);
  typeIn(conflicted.el, 'x'.repeat(INBOX_DRAFT_BODY_MAX + 1));
  await wait(SAVED);
  expect(conflicted.handle.current.draft.conflict === null).toBe(false);
  expect(conflicted.handle.current.draft.tooLong).toBe(true);
  expect(stamps(conflicted.el)).toBe(0);
}, LONG);

test.skipIf(!hasDom)('after a good Send that carried a file: with sendClearsDraft no store call at all; without it one discard at the saved version', async () => {
  for (const clears of [true, false]) {
    const s = strictStore();
    const up = fakeUploader();
    const out = fakeSend();
    // A host whose send clears the draft does it on its server, as the Inbox's clear_draft does.
    const send = (result: ReplySendResult) => out.send(result).then(() => void (clears && s.drafts.delete(THREAD)));
    const { el, handle } = mount(host({ send, draftStore: s.store, uploader: up.uploader, sendClearsDraft: clears }));
    await wait(30);
    typeIn(el, 'With a file.');
    act(() => handle.current.addFiles([notes('notes.txt')] as unknown as FileList));
    await wait(30);
    up.finish[0]!(upload(clears ? 'upl_11' : 'upl_12', 'notes.txt'));
    await wait(SAVED);
    pressSend(el);
    await wait(30);
    const version = s.drafts.get(THREAD)!.updated_at;
    const before = s.calls.length;
    await act(async () => out.ends[0]!.resolve());
    // Long enough for a save queued after the Send to have run.
    await wait(REPLY_DRAFT_SAVE_MS + 400);
    expect(s.calls.slice(before)).toEqual(clears ? [] : [`discard 1 ${version}`]);
    expect(field(el).value).toBe('');
    expect(tiles(el)).toBe(0);
  }
}, LONG);

test.skipIf(!hasDom)('Discard with a file in the box makes one discard and no save after it', async () => {
  const s = strictStore();
  const up = fakeUploader();
  const { el, handle } = mount(host({ send: fakeSend().send, draftStore: s.store, uploader: up.uploader }));
  await wait(30);
  typeIn(el, 'Thrown away.');
  act(() => handle.current.addFiles([notes('notes.txt')] as unknown as FileList));
  await wait(30);
  up.finish[0]!(upload('upl_13', 'notes.txt'));
  await wait(SAVED);
  const version = s.drafts.get(THREAD)!.updated_at;
  const before = s.calls.length;
  act(() => el.querySelector<HTMLButtonElement>('[data-reply-discard]')!.click());
  await wait(REPLY_DRAFT_SAVE_MS + 400);
  expect(s.calls.slice(before)).toEqual([`discard 1 ${version}`]);
  expect(field(el).value).toBe('');
}, LONG);

test.skipIf(!hasDom)('while a Send is out the field is read-only and a mention asked for does not go in; it takes keys again after', async () => {
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: strictStore().store, uploader: fakeUploader().uploader }));
  await wait(30);
  typeIn(el, 'Slow send.');
  pressSend(el);
  await wait(30);
  expect(field(el).readOnly).toBe(true);
  act(() => handle.current.mentions.requestMention(THREAD, [{ id: OTHER, title: 'Rate limit' }]));
  await wait(30);
  expect(field(el).value).toBe('Slow send.');
  expect(handle.current.mentions.mentionsFor(THREAD, field(el).value).length).toBe(0);
  await act(async () => out.ends[0]!.reject(new Error('Not sent.')));
  await wait(30);
  expect(field(el).readOnly).toBe(false);
  expect(field(el).value).toBe('Slow send.');
}, LONG);

/** A paste of `text` (no files) on `target`, as a browser's. */
function pasteText(target: HTMLElement, text: string) {
  act(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: (kind: string) => (kind === 'text/plain' ? text : '') } });
    target.dispatchEvent(event);
  });
}

test.skipIf(!hasDom)('while a Send is out Discard, attach, a tile\'s remove and a pasted file do nothing; a failed Send finds all of it', async () => {
  const s = strictStore();
  const up = fakeUploader();
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: s.store, uploader: up.uploader }));
  await wait(30);
  typeIn(el, 'Keep all of this.');
  act(() => handle.current.addFiles([notes('a.txt')] as unknown as FileList));
  await wait(30);
  up.finish[0]!(upload('upl_14', 'a.txt'));
  await wait(30);
  pressSend(el);
  await wait(30);
  act(() => el.querySelector<HTMLButtonElement>('[data-reply-discard]')!.click());
  act(() => handle.current.addFiles([notes('b.txt')] as unknown as FileList));
  act(() => el.querySelector<HTMLButtonElement>('[aria-label="Remove a.txt"]')!.click());
  act(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [notes('c.txt')], items: [], types: ['Files'], getData: () => '' } });
    el.querySelector('.ib-rbox')!.dispatchEvent(event);
  });
  await wait(30);
  expect(field(el).value).toBe('Keep all of this.');
  expect(tiles(el)).toBe(1);
  expect(up.finish.length).toBe(1);
  await act(async () => out.ends[0]!.reject(new Error('Not sent.')));
  await wait(30);
  expect(field(el).value).toBe('Keep all of this.');
  expect(tiles(el)).toBe(1);
  expect(discards(s.calls)).toEqual([]);
}, LONG);

test.skipIf(!hasDom)('a thread change under one box carries nothing across: the first thread\'s draft keeps its words, the second\'s Send has none', async () => {
  const s = strictStore();
  const out = fakeSend();
  const { el } = mount(host({ send: out.send, draftStore: s.store, uploader: fakeUploader().uploader }));
  await wait(30);
  typeIn(el, 'For thread A only.');
  act(() => rehost({ threadId: OTHER }));
  await wait(SAVED);
  expect(field(el).value).toBe('');
  expect(s.drafts.get(THREAD)?.body ?? null).toBe('For thread A only.');
  typeIn(el, 'For B.');
  pressSend(el);
  await wait(60);
  expect(out.calls.length).toBe(1);
  expect(out.calls[0]!.result.threadId).toBe(OTHER);
  expect(out.calls[0]!.result.body).toBe('For B.');
  expect(s.calls.filter((call) => call.startsWith('save 2') && call.includes('thread A')).length).toBe(0);
  await act(async () => out.ends[0]!.resolve());
  await wait(60);
  act(() => rehost({ threadId: THREAD }));
  await wait(60);
  expect(field(el).value).toBe('For thread A only.');
}, LONG);

test.skipIf(!hasDom)('a discard that never answers leaves the box free; cancel frees a Send the host gave up on, words kept', async () => {
  const s = strictStore();
  s.store.discard = () => new Promise<void>(() => {});
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: s.store, uploader: fakeUploader().uploader }));
  await wait(30);
  typeIn(el, 'Goes.');
  await wait(SAVED);
  pressSend(el);
  await wait(30);
  await act(async () => out.ends[0]!.resolve());
  await wait(60);
  expect(handle.current.sending).toBe(false);
  expect(el.querySelector<HTMLButtonElement>('[data-reply-send]')!.disabled).toBe(false);
  expect(field(el).readOnly).toBe(false);
  typeIn(el, 'Next reply.');
  await wait(30);
  expect(field(el).value).toBe('Next reply.');
  // A Send the host never settles: it gives up on the press, and the box is free with its words.
  pressSend(el);
  await wait(30);
  expect(out.calls.length).toBe(2);
  expect(handle.current.sending).toBe(true);
  act(() => handle.current.cancel());
  await wait(30);
  expect(handle.current.sending).toBe(false);
  expect(field(el).readOnly).toBe(false);
  expect(field(el).value).toBe('Next reply.');
  pressSend(el);
  await wait(30);
  expect(out.calls.length).toBe(3);
}, LONG);

test.skipIf(!hasDom)('an upload the host refuses shows its own sentence on that tile; the other file and the words still go', async () => {
  const finish: ((done: InboxUpload) => void)[] = [];
  const uploader: DraftFileUploader = {
    upload: (file) =>
      file.name === 'big.bin'
        ? Promise.reject({ message: 'Files over 10 MB cannot be attached here.' })
        : file.name === 'odd.bin'
          ? Promise.reject(new Error('This space takes no files of that kind.'))
          : new Promise<InboxUpload>((resolve) => finish.push(resolve)),
    readText: async () => '',
  };
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: strictStore().store, uploader }));
  await wait(30);
  typeIn(el, 'Three files.');
  act(() => handle.current.addFiles([notes('notes.txt'), new File(['x'], 'big.bin'), new File(['y'], 'odd.bin')] as unknown as FileList));
  await wait(30);
  finish[0]!(upload('upl_20', 'notes.txt'));
  await wait(30);
  const text = el.textContent ?? '';
  expect(text.includes('Files over 10 MB cannot be attached here.')).toBe(true);
  expect(text.includes('This space takes no files of that kind.')).toBe(true);
  pressSend(el);
  await wait(30);
  expect(out.calls.length).toBe(1);
  expect(out.calls[0]!.result.files).toEqual(['upl_20']);
  expect(out.calls[0]!.result.body).toBe('Three files.');
}, LONG);

test.skipIf(!hasDom)('the box fetches nothing of its own: typing, a pasted thread id, a file and a Send call no fetch', async () => {
  const was = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = ((input: unknown) => {
    fetched.push(String(input));
    return Promise.reject(new TypeError('No network in this test.'));
  }) as typeof fetch;
  try {
    const up = fakeUploader();
    const out = fakeSend();
    const { el, handle } = mount(host({ send: out.send, draftStore: strictStore().store, uploader: up.uploader }));
    await wait(30);
    typeIn(el, 'See ');
    pasteText(field(el), 'msg_01M6RF00000000000000000099');
    await wait(60);
    act(() => handle.current.addFiles([notes('notes.txt')] as unknown as FileList));
    await wait(30);
    up.finish[0]!(upload('upl_21', 'notes.txt'));
    await wait(SAVED);
    pressSend(el);
    await wait(30);
    await act(async () => out.ends[0]!.resolve());
    await wait(60);
    expect(out.calls.length).toBe(1);
    expect(fetched).toEqual([]);
  } finally {
    globalThis.fetch = was;
  }
}, LONG);

test.skipIf(!hasDom)('an empty box sends only when the host says it carries something else (answers in extra)', async () => {
  let answers = 0;
  const out = fakeSend();
  const { el } = mount(host({ send: out.send, draftStore: strictStore().store, uploader: fakeUploader().uploader, extra: () => ({ answers }), hasOtherContent: () => answers > 0 }));
  await wait(30);
  pressSend(el);
  await wait(30);
  expect(out.calls.length).toBe(0);
  answers = 2;
  pressSend(el);
  await wait(30);
  expect(out.calls.length).toBe(1);
  expect(out.calls[0]!.result.body).toBe('');
  expect(out.calls[0]!.result.files).toEqual([]);
  expect(out.calls[0]!.result.extra).toEqual({ answers: 2 });
}, LONG);

test.skipIf(!hasDom)('an unchanged box hands the host the same Send from press to press; one character changes it', async () => {
  const up = fakeUploader();
  const out = fakeSend();
  const { el, handle } = mount(host({ send: out.send, draftStore: strictStore().store, uploader: up.uploader, replyTo: 'line_01', extra: () => ({ route: 'live' }) }));
  await wait(30);
  typeIn(el, 'Same words.');
  act(() => handle.current.addFiles([notes('a.txt'), notes('b.txt')] as unknown as FileList));
  await wait(30);
  up.finish[1]!(upload('upl_31', 'b.txt'));
  up.finish[0]!(upload('upl_30', 'a.txt'));
  await wait(SAVED);
  for (let press = 0; press < 3; press += 1) {
    pressSend(el);
    await wait(30);
    await act(async () => out.ends[press]!.reject(new Error('Not sent.')));
    await wait(SAVED);
  }
  // What names the message (all but the draft's version, which a store moves with each save).
  const message = ({ draft: _version, ...rest }: ReplySendResult) => rest;
  expect(out.calls.length).toBe(3);
  expect(message(out.calls[1]!.result)).toEqual(message(out.calls[0]!.result));
  expect(message(out.calls[2]!.result)).toEqual(message(out.calls[0]!.result));
  expect(out.calls[0]!.result.files).toEqual(['upl_30', 'upl_31']);
  typeIn(el, 'Same words!');
  pressSend(el);
  await wait(30);
  expect(out.calls[3]!.result.body).toBe('Same words!');
  expect(out.calls[3]!.result.files).toEqual(['upl_30', 'upl_31']);
}, LONG);

const row = (session: string, label: string): RecipientRow => ({ session, host: null, label, short: label, state: 'live' });

test.skipIf(!hasDom)('`to` is who the picker shows, at most maxRecipients, and follows the host\'s choice when it changes', async () => {
  const rows = [row('ses_a', 'Ada'), row('ses_b', 'Bob')];
  const out = fakeSend();
  const { el } = mount(host({ send: out.send, draftStore: strictStore().store, uploader: fakeUploader().uploader, recipients: { rows, chosen: ['ses_a', 'ses_b', 'ses_gone'], maxRecipients: 1 } }));
  await wait(30);
  typeIn(el, 'To one.');
  pressSend(el);
  await wait(30);
  expect(out.calls[0]!.result.to).toEqual(['ses_a']);
  await act(async () => out.ends[0]!.resolve());
  await wait(30);
  act(() => rehost({ recipients: { rows, chosen: ['ses_b'] } }));
  await wait(30);
  typeIn(el, 'To Bob.');
  pressSend(el);
  await wait(30);
  expect(out.calls[1]!.result.to).toEqual(['ses_b']);
}, LONG);

test.skipIf(!hasDom)('opening the box through the handle puts the caret in the field', async () => {
  const { el, handle } = mount(host({ send: fakeSend().send, draftStore: strictStore().store, uploader: fakeUploader().uploader }));
  await wait(30);
  field(el).blur();
  expect(document.activeElement === field(el)).toBe(false);
  act(() => handle.current.open());
  await wait(30);
  expect(document.activeElement === field(el)).toBe(true);
}, LONG);
