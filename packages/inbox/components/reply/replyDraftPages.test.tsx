/**
 * A host's reply box is handed its draft store and its own page of drafts (replyDraft.ts `createReplyDraftPage`):
 * what one page keeps (a file landing, a Send on its way, words not saved) is never another page's, and the Send
 * guards hold over any store handed in. Failures this catches: page state moved back to the module (two hosts on one
 * page would hold each other's words), a debounced save that recreates the draft a Send just cleared, a save sent
 * while a Send holds the thread.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxReplyDraft, InboxUpload } from '@plannotator/core/inbox-types';
import type { ReplyDraftSaveInput, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';

const hasDom = typeof document !== 'undefined';
const { createReplyDraftPage, REPLY_DRAFT_SAVE_MS } = (hasDom ? await import('../../replyDraft') : {}) as typeof import('../../replyDraft');
type Page = ReturnType<typeof createReplyDraftPage>;
type Draft = ReturnType<Page['useReplyDraft']>;

const THREAD = 'msg_01M6RF0000000000000000001';
const STAMP = '2026-11-02T10:10:00.000Z';

/** A host's store: one draft per thread, every save it was asked for, in order. */
function hostStore() {
  const drafts = new Map<string, InboxReplyDraft>();
  const saves: { threadId: string; body: string }[] = [];
  let clock = 0;
  const store: ReplyDraftStore = {
    read: async (threadId) => drafts.get(threadId) ?? null,
    save: async (threadId, input: ReplyDraftSaveInput) => {
      saves.push({ threadId, body: input.body });
      clock += 1;
      const draft: InboxReplyDraft = { v: 1, thread_id: threadId, body: input.body, created_at: STAMP, updated_at: new Date(Date.UTC(2026, 10, 2, 11, 0, clock)).toISOString() };
      drafts.set(threadId, draft);
      return { draft };
    },
    discard: async (threadId) => {
      drafts.delete(threadId);
    },
  };
  return { store, drafts, saves };
}

const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

let roots: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  for (const { root, host } of roots) {
    act(() => root.unmount());
    host.remove();
  }
  roots = [];
});

/** One box's draft on `page` over `store`, as a host's controller holds it. */
function mount(page: Page, store: ReplyDraftStore): { current: Draft } {
  const out = { current: null as unknown as Draft };
  function Probe() {
    out.current = page.useReplyDraft(THREAD, { store });
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  roots.push({ root, host });
  return out;
}

test.skipIf(!hasDom)('two pages share nothing: a file landing and a Send on its way are their own page\'s', async () => {
  const one = createReplyDraftPage({ keepInBrowser: false });
  const two = createReplyDraftPage({ keepInBrowser: false });
  const a = hostStore();
  const b = hostStore();
  let finish: (upload: InboxUpload) => void = () => {};
  const upload = new Promise<InboxUpload>((resolve) => (finish = resolve));
  const landed = one.landInReplyDraft(THREAD, upload, a.store);
  expect(one.replyDraftUnsaved()).toBe(true);
  expect(two.replyDraftUnsaved()).toBe(false);
  // A Send on its way on page one holds page one's late words only: page two's land at once.
  const ends = one.replySendStarts(THREAD);
  await two.landWordsInReplyDraft(THREAD, 'Said on two.', b.store);
  expect(b.drafts.get(THREAD)?.body).toBe('Said on two.');
  expect(a.saves).toEqual([]);
  finish({ upload_id: 'upl_01', name: 'export.csv', size: 2048, kind: 'file', sha256: 'a'.repeat(64), created_at: STAMP });
  await landed;
  ends();
  expect(a.saves.map((s) => s.threadId)).toEqual([THREAD]);
  expect(one.replyDraftUnsaved()).toBe(false);
  expect(b.saves.length).toBe(1);
});

test.skipIf(!hasDom)('a page that keeps nothing in the browser writes no localStorage', async () => {
  localStorage.clear();
  const page = createReplyDraftPage({ keepInBrowser: false });
  const { store } = hostStore();
  const refusing: ReplyDraftStore = { ...store, save: async () => Promise.reject(new TypeError('Failed to fetch')) };
  const draft = mount(page, refusing);
  await wait(30);
  act(() => draft.current.save('Words that do not land.'));
  await wait(REPLY_DRAFT_SAVE_MS + 200);
  expect(page.replyDraftUnsaved()).toBe(true);
  expect(localStorage.length).toBe(0);
});

test.skipIf(!hasDom)('Send over a host\'s store: the waiting save goes first, none runs while it sends, none after it cleared the draft', async () => {
  const page = createReplyDraftPage({ keepInBrowser: false });
  const { store, saves, drafts } = hostStore();
  const draft = mount(page, store);
  await wait(30);
  // Typed, and Send pressed inside the pause: the claim saves the waiting words now, and cancels the timer.
  act(() => draft.current.save('Ship it on Friday.'));
  let claimed: string | null | undefined;
  await act(async () => {
    claimed = await draft.current.claim();
  });
  expect(saves.map((s) => s.body)).toEqual(['Ship it on Friday.']);
  expect(claimed).toBe(drafts.get(THREAD)!.updated_at);
  // While the Send holds the thread, a key typed is not saved.
  act(() => draft.current.save('Ship it on Friday. Typed while sending.'));
  await wait(REPLY_DRAFT_SAVE_MS + 150);
  expect(saves.length).toBe(1);
  // The Send carried the words and the host cleared the draft: nothing queued before brings it back.
  drafts.delete(THREAD);
  act(() => draft.current.sent());
  await wait(REPLY_DRAFT_SAVE_MS + 150);
  expect(saves.length).toBe(1);
  expect(drafts.has(THREAD)).toBe(false);
  expect(page.replyDraftUnsaved()).toBe(false);
});
