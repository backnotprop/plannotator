/**
 * The reason under an action item's "Can't do it…" in decision mode is a draft like every answer (reasonDrafts.ts):
 * it used to live only in the card's own state, so Previous, Next, Escape or Close lost it without a word.
 */
import { expect, test } from 'bun:test';
import { createReasonDrafts, reasonDraftKey, type ReasonStore } from './decisions/reasonDrafts';

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
