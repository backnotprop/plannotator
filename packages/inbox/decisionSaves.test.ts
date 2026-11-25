/**
 * Decision mode saves its answers with the thread's machinery (decisions/saves.ts). The rule: the moment the person
 * types or picks, it is a draft, and it is never lost. A refused save keeps the words on the card and goes again; a
 * Send that still cannot save them sends nothing; another window's answer landing first is saved over quietly; words
 * inside their pause go with a keepalive as the page goes; closing with a save out shows the words in the thread.
 */
import { expect, test } from 'bun:test';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError, InboxHeldError, type MachineView, type OutboxView } from './api';
import type { HeldThread } from './data/apply/record';
import { createDecisionSaves, withPendingAnswers, type DecisionPick, type DecisionSavesDeps } from './decisions/saves';

const ID = 'msg_A/q1';
const answer = (other: string, selected: string[] = ['other']): QuestionAnswer => ({ selected, other }) as QuestionAnswer;
const saved = (revision: number, a: QuestionAnswer | null): InboxQuestion => ({ message_id: 'msg_A', key: 'q1', state: a ? 'picked' : 'open', revision, answer: a }) as unknown as InboxQuestion;
const broken = () => new InboxApiError(503, 'unavailable', 'The Inbox did not answer.');
const conflict = (revision: number) => new InboxApiError(409, 'question_revision_conflict', `Question q1 changed since you read it (revision ${revision}).`, null, null, null, revision);

/** A fake picks route: answers each call with `respond`, and records what was asked. */
function harness(respond: (save: DecisionPick, n: number) => Promise<{ questions: InboxQuestion[] }>) {
  const calls: DecisionPick[] = [];
  const failed: string[] = [];
  let pending: ReadonlyMap<string, QuestionAnswer | null> = new Map();
  const timers: (() => void)[] = [];
  const deps: DecisionSavesDeps = {
    pick: (save) => {
      calls.push(save);
      return respond(save, calls.length);
    },
    known: () => 1,
    onPending: (next) => (pending = next),
    onSaved: () => {},
    onFailed: (_id, error) => failed.push(error),
    onChanged: () => {},
    timers: { set: (run) => timers.push(run), clear: () => {} },
  };
  const saves = createDecisionSaves(deps);
  return { saves, calls, failed, pending: () => pending, timers };
}

test('a refused save keeps the answer on the card, and the next wait saves it again', async () => {
  const words = answer('Ship it on Friday', []);
  const h = harness(async (save, n) => {
    if (n === 1) throw broken();
    return { questions: [saved(save.revision + 1, save.answer)] };
  });
  h.saves.change(ID, words, null);
  expect(await h.saves.settled()).toBe(false);
  // The first try was refused: the person was told, and the words are still the card's.
  expect(h.failed).toEqual(['The Inbox did not answer.']);
  expect(h.pending().get(ID)).toEqual(words);
  // The next wait (a Send, closing, a reload) saves them again.
  expect(await h.saves.settled()).toBe(true);
  expect(h.calls.map((c) => c.answer)).toEqual([words, words]);
  expect(h.pending().has(ID)).toBe(false);
});

test('an answer that cannot be saved stays on the card and stops the Send', async () => {
  const words = answer('Ship it on Friday', []);
  const h = harness(async () => {
    throw broken();
  });
  h.saves.change(ID, words, null);
  await Promise.resolve();
  await Promise.resolve();
  expect(h.pending().get(ID)).toEqual(words);
  // Send saves first; still refused, nothing may go (null), and the words are still the card's.
  expect(await h.saves.forSend()).toBeNull();
  expect(h.pending().get(ID)).toEqual(words);
  // A reload's wait says the same: not saved.
  expect(await h.saves.settled()).toBe(false);
});

test("another window's answer landing first is saved over quietly, at the revision the Inbox holds", async () => {
  const pick = answer('', ['b']);
  const h = harness(async (save, n) => {
    if (n === 1) throw conflict(7);
    return { questions: [saved(save.revision + 1, save.answer)] };
  });
  h.saves.change(ID, pick, null);
  expect(await h.saves.settled()).toBe(true);
  expect(h.calls.map((c) => c.revision)).toEqual([1, 7]);
  // No refusal on screen, and the pick is not taken back.
  expect(h.failed).toEqual([]);
  expect(h.calls.at(-1)!.answer).toEqual(pick);
});

test('words inside their typing pause go with a keepalive as the page goes', async () => {
  const h = harness(async (save) => ({ questions: [saved(save.revision + 1, save.answer)] }));
  // A pick first, then words typed into it: the words wait for their pause.
  const picked = answer('', ['other']);
  h.saves.change(ID, picked, null);
  expect(await h.saves.settled()).toBe(true);
  const typed = answer('because the tests pass');
  expect(h.saves.change(ID, typed, picked).typed).toBe(true);
  expect(h.calls).toHaveLength(1);
  h.saves.leave();
  expect(await h.saves.settled()).toBe(true);
  expect(h.calls.at(-1)).toMatchObject({ answer: typed, keepalive: true });
});

test('closing with a save out puts the words on the thread card at once', () => {
  const words = answer('Ship it on Friday', []);
  const message = { id: 'msg_A', questions: [saved(3, null), { ...saved(3, null), key: 'q2' }] } as unknown as InboxMessageWire;
  const held = { serverSession: 's', cursor: 1, thread: { thread_id: 'msg_A', messages: [message] } } as unknown as HeldThread;
  const after = withPendingAnswers(held, new Map([[ID, words]]));
  const [q1, q2] = after.thread.messages[0]!.questions!;
  expect(q1).toMatchObject({ answer: words, state: 'picked', revision: 3 });
  // The other question is untouched, and nothing pending keeps the same thread.
  expect(q2!.answer).toBeNull();
  expect(withPendingAnswers(held, new Map())).toBe(held);
});

/** A pick held for the linked computer the thread lives on (the forward's `202`), under outbox key `key`. */
const outboxEntry = (key: string, state: OutboxView['state'], notice: OutboxView['notice'] = null): OutboxView => ({
  key,
  machine: 'ibx_01JZ0000000000000000000000',
  route: 'messages/msg_A/picks',
  state,
  queued_at: '',
  settled_at: null,
  status: null,
  answer: state === 'refused' ? { error: 'That question was replaced.' } : null,
  notice,
  dismissed: false,
});
const heldBy = (key: string) => new InboxHeldError(outboxEntry(key, 'queued'), { name: 'Studio', state: 'offline' } as MachineView);

// Decision mode kept a held pick drawn and its revision raised for good: a pick the other computer then refused stayed
// on the card as if saved, and the next pick on that question went at a revision that computer never had. The rule is
// now the thread's own (heldPicks.ts).
test('a pick held for a linked computer: the next goes on top; delivered, it stands; refused, the card goes back and says why', async () => {
  const h = harness(async (save, n) => {
    if (n <= 2) throw heldBy(`k${n}`);
    return { questions: [saved(save.revision + 1, save.answer)] };
  });
  const first = answer('', ['a']);
  const second = answer('', ['b']);
  h.saves.change(ID, first, null);
  expect(await h.saves.settled()).toBe(true);
  h.saves.change(ID, second, first);
  expect(await h.saves.settled()).toBe(true);
  // Held in order: the second goes at the revision the first makes there.
  expect(h.calls.map((c) => c.revision)).toEqual([1, 2]);
  expect(h.pending().get(ID)).toEqual(second);
  // With no `onHeld`, the waiting words go to `onFailed` (the dialog passes `onHeld`).
  expect(h.failed.splice(0)).toEqual(['Waiting for Studio: this applies when Studio is back.', 'Waiting for Studio: this applies when Studio is back.']);
  // Both still held, in order: a Send made while Studio is away carries them (decisions/farThread.ts).
  expect(h.saves.heldPicks().map((p) => [p.answer, p.revision])).toEqual([
    [first, 1],
    [second, 2],
  ]);
  // The first lands; the second is refused there: it is unpicked, the person is told, and the revision it would have
  // made is given back: the next pick goes at what this window holds (a conflict there is saved over), never at 3.
  h.saves.settleHeld([outboxEntry('k1', 'delivered'), outboxEntry('k2', 'refused', { kind: 'refused', at: '' })]);
  expect(h.pending().has(ID)).toBe(false);
  expect(h.saves.heldPicks()).toEqual([]);
  expect(h.failed).toEqual(['Pick not saved. Not delivered: That question was replaced.']);
  h.saves.change(ID, first, null);
  expect(await h.saves.settled()).toBe(true);
  expect(h.calls.at(-1)!.revision).toBe(1);
  // An entry settles once: told again, it changes nothing.
  h.saves.settleHeld([outboxEntry('k2', 'refused', { kind: 'refused', at: '' })]);
  expect(h.failed).toHaveLength(1);
});

test('a held pick says it waits (not that it failed), and the Send it precedes is not stopped', async () => {
  const held: string[] = [];
  const calls: DecisionPick[] = [];
  const saves = createDecisionSaves({
    pick: async (save) => {
      calls.push(save);
      throw heldBy('k1');
    },
    known: () => 1,
    onPending: () => {},
    onSaved: () => {},
    onFailed: () => held.push('failed'),
    onHeld: (_id, words) => held.push(words),
    onChanged: () => {},
  });
  saves.change(ID, answer('', ['a']), null);
  const release = await saves.forSend();
  expect(release).not.toBeNull();
  release!();
  expect(held).toEqual(['Waiting for Studio: this applies when Studio is back.']);
});

test('a held pick delivered there: the card draws it from the thread again, so a later change there shows', async () => {
  const h = harness(async () => {
    throw heldBy('k1');
  });
  const picked = answer('', ['a']);
  h.saves.change(ID, picked, null);
  expect(await h.saves.settled()).toBe(true);
  expect(h.pending().get(ID)).toEqual(picked);
  h.saves.settleHeld([outboxEntry('k1', 'sending')]);
  expect(h.pending().get(ID)).toEqual(picked);
  h.saves.settleHeld([outboxEntry('k1', 'delivered')]);
  expect([h.pending().has(ID), h.saves.heldPicks(), h.failed.slice(1)]).toEqual([false, [], []]);
});
