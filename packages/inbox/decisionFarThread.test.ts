/**
 * A Send in decision mode on a linked computer's thread while that computer is away (decisions/farThread.ts): it sends
 * from the thread as the dialog holds it, with every answer the person sees on the cards. What regresses: a pick or an
 * action item's mark held for that computer left out of the reply (it would land there unsent, and the agent never
 * hear it); a held pick named at the revision it was made at, not the one it makes there (refused as replaced once
 * delivered); a mark taken back still sent; a thread of this Inbox, or another failure, sending from what is held.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { OutboxView, ThreadModel } from '@plannotator/core/inbox-wire-models';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError } from './apiError';
import { awayThreadRead, outboxNotApplied, withHeldAnswers } from './decisions/farThread';
import { groupSendTargets } from './decisions/model';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const LAPTOP = 'ibx_01JDZ8Y3V7Q4K2N6P9R5T8W1XA';
const SESSION = 's:claude-code\u0000ses_a';
const chose = (...selected: string[]) => ({ selected }) as unknown as QuestionAnswer;

function question(key: string, extra: Partial<InboxQuestion> = {}): InboxQuestion {
  return {
    key,
    position: 0,
    kind: 'single',
    prompt: `Prompt ${key}?`,
    context: null,
    choices: [
      { label: 'Yes', description: null, recommended: false, settled: false },
      { label: 'No', description: null, recommended: false, settled: false },
    ],
    recommendation: null,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: 'msg_1',
    superseded_by: null,
    ...extra,
  } as InboxQuestion;
}

function model(): ThreadModel {
  const message = {
    id: 'msg_1',
    thread_id: 'msg_t1',
    project_id: 'prj_1',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    subject: null,
    body: '',
    created_at: '2026-11-25T10:00:00.000Z',
    reply_to: null,
    questions: [question('q-1', { state: 'picked', answer: chose('Yes'), revision: 1 }), question('q-2'), question('q-3', { state: 'picked', answer: chose('No'), revision: 2 })],
    actions: [question('a-1', { kind: 'action' }), question('a-2', { kind: 'action', state: 'picked', action_result: { outcome: 'done', note: null, at: '2026-11-25T10:01:00.000Z', by: 'person', staged: true } })],
  } as unknown as InboxMessageWire;
  return { thread: { thread_id: 'msg_t1', messages: [message] } } as unknown as ThreadModel;
}

const away = new InboxApiError(503, 'machine_offline', 'Laptop is asleep.');

afterEach(() => resetMachineRoutes());

describe("a Send on a linked computer's thread while that computer is away", () => {
  test('carries the held picks at the revision they make there, and the held marks, in the order made', () => {
    rememberMachine(['msg_t1', 'msg_1'], LAPTOP);
    const read = awayThreadRead(away, 'msg_t1', model(), {
      picks: [
        { id: 'msg_1/q-2', answer: chose('Yes'), revision: 0 },
        // Two picks on one question: the last one made is what goes.
        { id: 'msg_1/q-2', answer: chose('No'), revision: 1 },
        // An un-pick held: that answer is not sent.
        { id: 'msg_1/q-3', answer: null, revision: 2 },
      ],
      marks: [
        { id: 'msg_1/a-1', mark: { outcome: 'cant', note: 'Bob Tully holds the key' } },
        { id: 'msg_1/a-2', mark: null },
      ],
    });
    expect(read?.[0]).toEqual({ draft: null });
    const [target] = groupSendTargets(read![1].thread, SESSION);
    expect(target!.questions).toEqual([
      { key: 'q-1', revision: 1 },
      { key: 'q-2', revision: 2 },
    ]);
    expect(target!.actions).toEqual([{ key: 'a-1' }]);
    const q2 = read![1].thread.messages[0]!.questions!.find((q) => q.key === 'q-2')!;
    expect(q2.answer).toEqual(chose('No'));
  });

  test('words saved in its reply box go with the answers from the thread, never split from them', () => {
    rememberMachine(['msg_t1'], LAPTOP);
    expect(awayThreadRead(away, 'msg_t1', model(), undefined, '2026-11-25T10:02:00.000Z')?.[0]).toEqual({ draft: { at: '2026-11-25T10:02:00.000Z' } });
    expect(awayThreadRead(away, 'msg_t1', model(), undefined, null)?.[0]).toEqual({ draft: null });
  });

  test('Try again renews the key only for a reply that surely never applied there', () => {
    const entry = (state: OutboxView['state'], notice: OutboxView['notice'] = null) => ({ key: 'k', machine: LAPTOP, route: 'messages/msg_1/reply', state, queued_at: '', settled_at: null, status: null, answer: null, notice, dismissed: false }) as OutboxView;
    expect(['refused', 'cancelled'].map((s) => outboxNotApplied(entry(s as OutboxView['state'])))).toEqual([true, true]);
    expect(outboxNotApplied(entry('dropped', { kind: 'not_delivered', at: '' }))).toBe(true);
    // It may have applied there (parked after tries, dropped once it left), or it still waits: the same key.
    expect(outboxNotApplied(entry('dropped', { kind: 'may_have_been_delivered', at: '' }))).toBe(false);
    expect(['parked', 'queued', 'sending', 'delivered'].map((s) => outboxNotApplied(entry(s as OutboxView['state'])))).toEqual([false, false, false, false]);
    expect(outboxNotApplied(undefined)).toBe(false);
  });

  test('nothing held: the thread as held; a thread of this Inbox or another failure: nothing to send from', () => {
    const held = model();
    expect(withHeldAnswers(held, { picks: [], marks: [] })).toBe(held);
    // This Inbox's own thread never sends from what is held.
    expect(awayThreadRead(away, 'msg_t1', held)).toBeNull();
    rememberMachine(['msg_t1'], LAPTOP);
    expect(awayThreadRead(new InboxApiError(500, 'internal', 'Broke.'), 'msg_t1', held)).toBeNull();
    expect(awayThreadRead(new Error('offline'), 'msg_t1', held)).toBeNull();
    // A held model of another thread is not this one.
    expect(awayThreadRead(away, 'msg_t9', held)).toBeNull();
    expect(awayThreadRead(away, 'msg_t1', null)).toBeNull();
    expect(awayThreadRead(away, 'msg_t1', held)?.[1]).toBe(held);
  });
});
