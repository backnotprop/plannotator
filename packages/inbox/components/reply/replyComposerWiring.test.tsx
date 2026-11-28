/**
 * The reply box's controller under a wired host (replyComposerWiring.ts: the Inbox's thread pane hands in its own
 * draft page, mentions, hook options and Send). Failures this catches: the host's Send called twice for one press,
 * or not inside the press (what the host set for the press lost); a second press reaching the host while its Send is
 * out; Discard, attach, a pasted file, a tile's remove or typing getting through while the host's Send (pressed here
 * or started by the host) is out; the chord or Escape not reaching the host's own keys; the controller restoring or
 * saving a draft the host restores and saves itself; the host's draft and files options not reaching the hooks.
 *
 * Assertions compare strings and numbers, never elements (a failed `expect(element)` can take bun down).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DraftFileUploader, ReplyDraftSaveInput, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import type { InboxReplyDraft, InboxUpload } from '@plannotator/core/inbox-types';
import type { ReplyComposerHandle } from './useReplyComposer';
import type { ReplyComposerWiredHost, ReplyComposerWiringView } from './replyComposerWiring';

const hasDom = typeof document !== 'undefined';
const { ReplyBox } = (hasDom ? await import('./ReplyBox') : {}) as typeof import('./ReplyBox');
const { useReplyComposer } = (hasDom ? await import('./useReplyComposer') : {}) as typeof import('./useReplyComposer');
const { createReplyDraftPage, REPLY_DRAFT_SAVE_MS } = (hasDom ? await import('../../replyDraft') : {}) as typeof import('../../replyDraft');
const { createThreadMentions } = (hasDom ? await import('../../threadMentions') : {}) as typeof import('../../threadMentions');

const THREAD = 'msg_01M6RF00000000000000000011';
const STAMP = '2026-11-02T10:10:00.000Z';
const upload = (id: string, name: string): InboxUpload => ({ upload_id: id, name, size: 9, kind: 'text', sha256: 'a'.repeat(64), created_at: STAMP });

function fakeStore(saved?: string) {
  const drafts = new Map<string, InboxReplyDraft>();
  if (saved !== undefined) drafts.set(THREAD, { v: 1, thread_id: THREAD, body: saved, created_at: STAMP, updated_at: STAMP });
  const saves: string[] = [];
  const store: ReplyDraftStore = {
    read: async (threadId) => drafts.get(threadId) ?? null,
    save: async (threadId, input: ReplyDraftSaveInput) => {
      saves.push(input.body);
      const draft: InboxReplyDraft = { v: 1, thread_id: threadId, body: input.body, created_at: STAMP, updated_at: STAMP };
      drafts.set(threadId, draft);
      return { draft };
    },
    discard: async (threadId) => void drafts.delete(threadId),
  };
  return { store, saves };
}

function fakeUploader() {
  const finish: ((upload: InboxUpload) => void)[] = [];
  const uploader: DraftFileUploader = { upload: () => new Promise<InboxUpload>((resolve) => finish.push(resolve)), readText: async () => '' };
  return { uploader, finish };
}

/** What the wired host saw: its Send's calls (with what it set for the press), its own handlers' calls. */
interface Seen {
  sends: string[];
  ends: (() => void)[];
  calls: string[];
  pasted: string[];
}

let setHostSending: (sending: boolean) => void = () => {};
let setRoute: (open: boolean) => void = () => {};

/** A wired host shaped as the Inbox's pane: its own words handler, keys, Discard and Send, drawn through `view()`. */
function WiredBox({ store, uploader, seen, out }: { store: ReplyDraftStore; uploader: DraftFileUploader; seen: Seen; out: { current: ReplyComposerHandle } }) {
  const [page] = useState(() => createReplyDraftPage({ keepInBrowser: false }));
  const [mentions] = useState(() => createThreadMentions({ keepInBrowser: false }));
  const [hostSending, setSending] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [pressNote] = useState(() => ({ current: 'none' }));
  setHostSending = setSending;
  setRoute = setRouteOpen;
  const host: ReplyComposerWiredHost = {
    threadId: THREAD,
    browserStorage: false,
    send: () =>
      new Promise<void>((resolve) => {
        seen.sends.push(pressNote.current);
        seen.ends.push(resolve);
      }),
    wiring: {
      page,
      mentions,
      draft: { store },
      files: { uploader, onPasted: (names) => seen.pasted.push(...names), setText: (text) => composer.handle.replyText.set(text) },
      view: (): ReplyComposerWiringView => ({
        open: true,
        sending: hostSending,
        sendingWords: false,
        slots: { placeholder: 'Write to harbor', replyToNames: 'harbor' },
        errorLine: null,
        draftNotSaved: false,
        change: (text) => {
          seen.calls.push(`change ${text}`);
          composer.handle.replyText.set(text);
        },
        chord: () => {
          seen.calls.push('chord');
          if (routeOpen) return true;
          pressNote.current = 'by chord';
          return false;
        },
        escape: () => seen.calls.push('escape'),
        close: () => seen.calls.push('close'),
        discard: () => {
          seen.calls.push('discard');
          composer.handle.replyText.set('');
        },
        attach: (list) => {
          seen.calls.push(`attach ${list.length}`);
          composer.handle.wired!.files.add(list);
        },
        added: () => seen.calls.push('added'),
      }),
    },
  };
  const composer = useReplyComposer(host);
  out.current = composer.handle;
  pressNote.current = 'none';
  return (
    <div className="pn-inbox">
      <ReplyBox {...composer.box.props} />
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

function mount(saved?: string) {
  const { store, saves } = fakeStore(saved);
  const { uploader, finish } = fakeUploader();
  const seen: Seen = { sends: [], ends: [], calls: [], pasted: [] };
  const out = { current: null as unknown as ReplyComposerHandle };
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<WiredBox store={store} uploader={uploader} seen={seen} out={out} />));
  roots.push({ root, el });
  return { el, seen, saves, finish, handle: out };
}

const field = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
function typeIn(el: HTMLElement, words: string) {
  const text = field(el);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    setter.call(text, words);
    text.setSelectionRange(words.length, words.length);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (el: HTMLElement, init: KeyboardEventInit) => act(() => void field(el).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
const pressSend = (el: HTMLElement) => act(() => el.querySelector<HTMLButtonElement>('[data-reply-send]')!.click());
const pressDiscard = (el: HTMLElement) => act(() => el.querySelector<HTMLButtonElement>('[data-reply-discard]')!.click());
const tiles = (el: HTMLElement) => el.querySelectorAll('[data-reply-files] [data-compose-file]').length;
const notes = (name: string) => new File(['the notes'], name, { type: 'text/plain' });
function attach(el: HTMLElement, file: File) {
  const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => void input.dispatchEvent(new Event('change', { bubbles: true })));
}

test.skipIf(!hasDom)('one press calls the host’s Send once, inside the press; a second press while it is out does nothing', async () => {
  const { el, seen, handle } = mount();
  typeIn(el, 'ship it');
  expect(seen.calls.join('|')).toBe('change ship it');
  key(el, { key: 'Enter', metaKey: true });
  // The chord went to the host first, and its Send ran in the same press (what the host set for it was still there).
  expect(seen.sends.join('|')).toBe('by chord');
  pressSend(el);
  key(el, { key: 'Enter', ctrlKey: true });
  await act(async () => void (await handle.current.send()));
  expect(seen.sends.length).toBe(1);
  await act(async () => seen.ends[0]!());
  pressSend(el);
  expect(seen.sends.join('|')).toBe('by chord|none');
});

test.skipIf(!hasDom)('the chord the host takes sends nothing; Escape is the host’s', async () => {
  const { el, seen } = mount();
  typeIn(el, 'words');
  act(() => setRoute(true));
  key(el, { key: 'Enter', metaKey: true });
  expect(seen.sends.length).toBe(0);
  key(el, { key: 'Escape' });
  expect(seen.calls.join('|')).toBe('change words|chord|escape');
});

test.skipIf(!hasDom)('while the host’s Send holds the words, Discard, attach, a tile’s remove and typing do nothing', async () => {
  const { el, seen, finish, handle } = mount();
  typeIn(el, 'keep these words');
  attach(el, notes('a.txt'));
  expect(tiles(el)).toBe(1);
  await act(async () => finish[0]!(upload('upl_a', 'a.txt')));
  // A press of the box: the host's Send holds the words and says so (`view().sending`) until it ends.
  pressSend(el);
  expect(seen.sends.length).toBe(1);
  act(() => setHostSending(true));
  expect(field(el).readOnly).toBe(true);
  typeIn(el, 'typed meanwhile');
  pressDiscard(el);
  attach(el, notes('c.txt'));
  act(() => el.querySelector<HTMLButtonElement>('[aria-label="Remove a.txt"]')?.click());
  expect(seen.calls.join('|')).toBe('change keep these words|attach 1');
  expect(handle.current.replyText.get()).toBe('keep these words');
  expect(tiles(el)).toBe(1);
  await act(async () => seen.ends[0]!());
  act(() => setHostSending(false));
  expect(field(el).readOnly).toBe(false);
  pressDiscard(el);
  expect(seen.calls.at(-1)).toBe('discard');
  expect(handle.current.replyText.get()).toBe('');
});

test.skipIf(!hasDom)('the host restores and saves its draft itself: the controller takes in no draft and saves no files on its own', async () => {
  const { el, saves, finish, seen } = mount('words another window kept');
  await wait(REPLY_DRAFT_SAVE_MS + 100);
  expect(field(el).value).toBe('');
  attach(el, notes('a.txt'));
  await act(async () => finish[0]!(upload('upl_a', 'a.txt')));
  await wait(REPLY_DRAFT_SAVE_MS + 100);
  expect(saves.length).toBe(0);
  // The host's files options reached the hook: its own uploader took the file.
  expect(finish.length).toBe(1);
  expect(tiles(el)).toBe(1);
  expect(seen.calls.join('|')).toBe('attach 1');
});
