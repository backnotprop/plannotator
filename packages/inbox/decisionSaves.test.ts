/**
 * Decision mode saves its answers with the thread's machinery (decisions/saves.ts). The rule: the moment the person
 * types or picks, it is a draft, and it is never lost. A refused save keeps the words on the card and goes again; a
 * Send that still cannot save them sends nothing; another window's answer landing first is saved over quietly; words
 * inside their pause go with a keepalive as the page goes; closing with a save out shows the words in the thread.
 */
import { expect, test } from 'bun:test';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError } from './api';
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
