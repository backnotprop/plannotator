/**
 * The reason under an action item's "Can't do it…" in decision mode is a draft like every answer (reasonDrafts.ts):
 * it used to live only in the card's own state, so Previous, Next, Escape or Close lost it without a word.
 */
import { expect, test } from 'bun:test';
import { createReasonDrafts, reasonDraftKey, type ReasonStore } from './decisions/reasonDrafts';
import { InboxHeldError, type MachineView } from './api';

const T = 'msg_T';
const ID = 'msg_A/a1';

/** A store standing in for the thread's comment drafts; `refuse` makes writes fail. */
function fakeStore() {
  const saved = new Map<string, string>();
  const writes: { text: string; keepalive: boolean }[] = [];
  let refuse = false;
  const store: ReasonStore = {
    read: async (_thread, key) => saved.get(key) ?? null,
    write: async (_thread, key, text, keepalive) => {
      writes.push({ text, keepalive });
      if (refuse) throw new Error('offline');
      if (text) saved.set(key, text);
      else saved.delete(key);
    },
  };
  return { store, saved, writes, refuse: (on: boolean) => (refuse = on) };
}

function drafts(store: ReasonStore, failed: string[] = []) {
  const timers: (() => void)[] = [];
  let texts: ReadonlyMap<string, string> = new Map();
  const reasons = createReasonDrafts({ store, onChange: (next) => (texts = next), onFailed: (m) => failed.push(m), timers: { set: (run) => timers.push(run), clear: () => {} } });
  return { reasons, texts: () => texts, pause: () => timers.splice(0).forEach((run) => run()) };
}

test('a reason typed is saved after its pause and comes back when the dialog opens again', async () => {
  const s = fakeStore();
  const first = drafts(s.store);
  first.reasons.type(T, ID, 'The staging box is down');
  expect(first.texts().get(ID)).toBe('The staging box is down');
  first.pause();
  expect(await first.reasons.settled()).toBe(true);
  expect(s.saved.get(reasonDraftKey(ID))).toBe('The staging box is down');
  // A new sitting (the dialog closed and opened again, or another window) reads it back as the card shows.
  const again = drafts(s.store);
  again.reasons.load(T, ID);
  await Promise.resolve();
  await Promise.resolve();
  expect(again.reasons.text(ID)).toBe('The staging box is down');
});

test('a reason that could not be saved stays on the card and goes again at the next wait', async () => {
  const s = fakeStore();
  const failed: string[] = [];
  const d = drafts(s.store, failed);
  s.refuse(true);
  d.reasons.type(T, ID, 'No access to prod');
  expect(await d.reasons.settled()).toBe(false);
  expect(failed).toHaveLength(1);
  expect(d.reasons.text(ID)).toBe('No access to prod');
  s.refuse(false);
  expect(await d.reasons.settled()).toBe(true);
  expect(s.saved.get(reasonDraftKey(ID))).toBe('No access to prod');
});

test('words inside their pause go with a keepalive as the page goes', () => {
  const s = fakeStore();
  const d = drafts(s.store);
  d.reasons.type(T, ID, 'Waiting on legal');
  expect(s.writes).toHaveLength(0);
  d.reasons.leave();
  expect(s.writes).toEqual([{ text: 'Waiting on legal', keepalive: true }]);
});

/** A store whose writes wait until the test answers them, in any order. */
function heldStore() {
  const saved = new Map<string, string>();
  const reads: string[] = [];
  const writes: { text: string; answer: (ok: boolean) => void }[] = [];
  const store: ReasonStore = {
    read: async (_thread, key) => {
      reads.push(key);
      return saved.get(key) ?? null;
    },
    write: (_thread, key, text) =>
      new Promise<void>((resolve, reject) => {
        writes.push({
          text,
          answer: (ok) => {
            if (!ok) return reject(new Error('offline'));
            saved.set(key, text);
            resolve();
          },
        });
      }),
  };
  return { store, saved, reads, writes };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

test('two writes of one reason never overlap: the last words land last', async () => {
  const s = heldStore();
  const d = drafts(s.store);
  d.reasons.type(T, ID, 'first words');
  d.pause();
  d.reasons.type(T, ID, 'last words');
  d.reasons.flush();
  // The second write waits for the first: only one is out.
  expect(s.writes.map((w) => w.text)).toEqual(['first words']);
  s.writes[0]!.answer(true);
  await settle();
  expect(s.writes.map((w) => w.text)).toEqual(['first words', 'last words']);
  s.writes[1]!.answer(true);
  await settle();
  expect(s.saved.get(reasonDraftKey(ID))).toBe('last words');
});

test('a write that fails with another waiting behind it: the one behind decides, and a reload is not kept waiting', async () => {
  const s = heldStore();
  const failed: string[] = [];
  const d = drafts(s.store, failed);
  d.reasons.type(T, ID, 'Blocked on legal');
  d.pause();
  d.reasons.type(T, ID, 'Blocked on legal');
  d.pause();
  s.writes[0]!.answer(false);
  await settle();
  s.writes[1]!.answer(true);
  await settle();
  expect(failed).toEqual([]);
  const settled = d.reasons.settled();
  await settle();
  expect(await settled).toBe(true);
});

test('emptying a reason after its mark saved: a failed write is not told, keeps no reload waiting, and goes again', async () => {
  const s = fakeStore();
  const failed: string[] = [];
  const d = drafts(s.store, failed);
  d.reasons.type(T, ID, 'No access to prod');
  d.pause();
  expect(await d.reasons.settled()).toBe(true);
  s.refuse(true);
  d.reasons.clear(T, ID);
  expect(d.reasons.text(ID)).toBe('');
  expect(await d.reasons.settled()).toBe(true);
  expect(failed).toEqual([]);
  s.refuse(false);
  d.reasons.flush();
  await settle();
  expect(s.saved.has(reasonDraftKey(ID))).toBe(false);
});

// It used to be kept on the card only (comment drafts were not forwarded), so a reason typed on a linked computer's
// thread was lost on close, and the person was told nothing. Now it is read and written there, and a write held for
// that computer while it is away is saved: it lands there once it is back.
test('a thread on a linked computer keeps its reason there; one held while that computer is away is saved, not refused', async () => {
  const saved = new Map<string, string>();
  const reads: string[] = [];
  const writes: string[] = [];
  let away = false;
  const outbox = { key: 'k1', machine: 'ibx_01JZ0000000000000000000000', route: 'threads/msg_far/comment-draft', state: 'queued', queued_at: '', settled_at: null, status: null, answer: null, notice: null, dismissed: false } as const;
  const store: ReasonStore = {
    read: async (thread, key) => (reads.push(`${thread} ${key}`), saved.get(key) ?? null),
    write: async (_thread, key, text) => {
      writes.push(text);
      if (away) throw new InboxHeldError(outbox, { name: 'Studio', state: 'offline' } as MachineView);
      saved.set(key, text);
    },
  };
  saved.set(reasonDraftKey(ID), 'Blocked on review');
  const failed: string[] = [];
  const timers: (() => void)[] = [];
  let texts: ReadonlyMap<string, string> = new Map();
  const reasons = createReasonDrafts({ store, onChange: (next) => (texts = next), onFailed: (m) => failed.push(m), timers: { set: (run) => timers.push(run), clear: () => {} } });
  reasons.load('msg_far', ID);
  await settle();
  expect(reads).toEqual([`msg_far ${reasonDraftKey(ID)}`]);
  expect(texts.get(ID)).toBe('Blocked on review');
  away = true;
  reasons.type('msg_far', ID, 'Blocked on review by Bob Tully');
  timers.splice(0).forEach((run) => run());
  expect(await reasons.settled()).toBe(true);
  expect(writes).toEqual(['Blocked on review by Bob Tully']);
  expect(failed).toEqual([]);
  expect(texts.get(ID)).toBe('Blocked on review by Bob Tully');
});

test('a read that lands after the person typed never replaces their words', async () => {
  const s = fakeStore();
  s.saved.set(reasonDraftKey(ID), 'older words');
  const d = drafts(s.store);
  d.reasons.load(T, ID);
  d.reasons.type(T, ID, 'newer words');
  await Promise.resolve();
  await Promise.resolve();
  expect(d.reasons.text(ID)).toBe('newer words');
});
