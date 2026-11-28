/**
 * The reason under an action item's "Can't do it…" in decision mode is a draft like every answer (reasonDrafts.ts):
 * it used to live only in the card's own state, so Previous, Next, Escape or Close lost it without a word.
 */
import { expect, test } from 'bun:test';
import { commentDrafts, createReasonDrafts, reasonDraftKey, type ReasonStore } from './decisions/reasonDrafts';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

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

// A linked computer's thread kept its reasons there, through the append-only outbox: one held entry per typing pause
// while it was away, and a held reason overwrote what was typed on that computer. Now they are this Inbox's own
// drafts, named by that computer, and never go to it; its own threads keep theirs as before.
test("a linked computer's thread keeps its reasons on this Inbox, named by that computer, never sent there", async () => {
  const laptop = 'ibx_01JZ0000000000000000000000';
  rememberMachine(['msg_far'], laptop);
  const sent: { url: string; body: Record<string, unknown> | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    return Response.json({ draft: { text: 'Blocked on review' } });
  }) as typeof fetch;
  try {
    const key = reasonDraftKey(ID);
    expect(await commentDrafts.read('msg_far', key)).toBe('Blocked on review');
    await commentDrafts.write('msg_far', key, 'Blocked on review by Bob Tully', false);
    await commentDrafts.write('msg_far', key, 'Blocked until Friday', false);
    await commentDrafts.read(T, key);
    expect(sent.map((s) => s.url)).toEqual([
      `/api/inbox/threads/msg_far/comment-draft?key=${encodeURIComponent(key)}&machine=${laptop}`,
      '/api/inbox/threads/msg_far/comment-draft',
      '/api/inbox/threads/msg_far/comment-draft',
      `/api/inbox/threads/${T}/comment-draft?key=${encodeURIComponent(key)}`,
    ]);
    expect(sent.slice(1, 3).map((s) => [s.body?.machine, s.body?.text, s.body?.force])).toEqual([
      [laptop, 'Blocked on review by Bob Tully', true],
      [laptop, 'Blocked until Friday', true],
    ]);
  } finally {
    globalThis.fetch = real;
    resetMachineRoutes();
  }
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
