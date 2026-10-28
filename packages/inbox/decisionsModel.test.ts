/**
 * Decision mode's queue, pure (packages/inbox/decisions/model.ts): the
 * projection folded in without reordering or undoing a saved pick, Later,
 * Previous, when a session's reply may go, and which replies a Send makes.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxDecision, InboxListRow, InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import {
  afterSendOf,
  answerWords,
  choiceAnswer,
  emptyQueue,
  groupHalfAnswered,
  freshPicks,
  holdSeconds,
  nextGroupSend,
  pauseHold,
  restartHold,
  startHold,
  DECISION_HOLD_MS,
  type GroupSend,
  type GroupSendFacts,
  groupKeyOf,
  groupReady,
  groupSendTargets,
  headLine,
  mergeDecisions,
  nextId,
  previousId,
  putOff,
  skipAnswer,
  swipeChoices,
  swipeHint,
  answerNeedsConfirm,
  confirmLabel,
  sessionChips,
} from './decisions/model';

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
    message_id: 'msg_a',
    superseded_by: null,
    ...extra,
  };
}

function decision(id: string, session: string, thread = 'msg_t1', extra: Partial<InboxQuestion> = {}): InboxDecision {
  const [message, key] = id.split('/') as [string, string];
  return {
    id,
    question: question(key, { message_id: message, ...extra }),
    message: { id: message, created_at: '2026-10-24T10:00:00.000Z', author: { kind: 'agent', host: 'claude-code', session, name: null }, excerpt: null },
    pictures: { inline: [], attachments: [] },
    thread: { id: thread, subject: 'Refunds', thread_name: null, project: { id: 'prj_1', name: 'billing' }, section: 'waiting' },
    session: { key: `s:claude-code\u0000${session}`, host: 'claude-code', session, name: null, wakes: true },
  };
}

const A1 = decision('msg_a/q-1', 'ses_a');
const A2 = decision('msg_a/q-2', 'ses_a');
const B1 = decision('msg_b/q-3', 'ses_b', 'msg_t2');

describe('the queue', () => {
  test('folds the projection in: order kept, new ones at the end, the ones that left marked', () => {
    let q = mergeDecisions(emptyQueue(), [A1, A2]);
    expect(q.order).toEqual([A1.id, A2.id]);
    expect(q.current).toBe(A1.id);
    q = mergeDecisions(q, [B1, A2]);
    expect(q.order).toEqual([A1.id, A2.id, B1.id]);
    expect(q.gone.get(A1.id)).toBe('closed');
    // A decision a reply of this sitting carried reads as sent; one that left otherwise reads as closed.
    const sent = mergeDecisions(mergeDecisions(emptyQueue(), [A1, A2, B1]), [B1], new Set([A1.id]));
    expect(sent.gone.get(A1.id)).toBe('sent');
    expect(sent.gone.get(A2.id)).toBe('closed');
  });

  test('a read older than a saved pick, or one that crossed a pick on its way, never undoes it', () => {
    let q = mergeDecisions(emptyQueue(), [A1]);
    const picked = { ...A1, question: { ...A1.question, state: 'picked' as const, revision: 1, answer: choiceAnswer(A1.question, ['Yes'], '') } };
    q = mergeDecisions(q, [picked]);
    q = mergeDecisions(q, [A1]);
    expect(q.cache.get(A1.id)!.question.state).toBe('picked');
    // Optimistic (revision 0 still) but the pick is on its way.
    const optimistic = mergeDecisions(emptyQueue(), [{ ...A1, question: { ...A1.question, state: 'picked' } }]);
    expect(mergeDecisions(optimistic, [A1], new Set(), new Set([A1.id])).cache.get(A1.id)!.question.state).toBe('picked');
    expect(mergeDecisions(optimistic, [A1]).cache.get(A1.id)!.question.state).toBe('open');
  });

  test('Later puts a decision at the end, and it comes back once the rest are handled', () => {
    let q = mergeDecisions(emptyQueue(), [A1, A2, B1]);
    q = putOff(q, A1.id);
    expect(q.order).toEqual([A2.id, B1.id, A1.id]);
    expect(q.current).toBe(A2.id);
    const handled = (d: InboxDecision) => ({ ...d, question: { ...d.question, state: 'picked' as const, revision: 1 } });
    q = mergeDecisions(q, [A1, handled(A2), handled(B1)]);
    expect(nextId(q, B1.id)).toBe(A1.id);
    // A put off and still open keeps its session's reply back.
    expect(groupReady(q, groupKeyOf(A1))).toBe(false);
    expect(groupHalfAnswered(q, groupKeyOf(A1))).toBe(true);
    expect(groupReady(q, groupKeyOf(B1))).toBe(true);
    expect(previousId(q, A1.id)).toBe(B1.id);
    expect(headLine({ ...q, current: A1.id })).toBe('3 of 3 · 1 agent waiting');
  });

  test('two sessions of one agent get chips that read apart: the later ones say "another session"', () => {
    const C1 = decision('msg_c/q-4', 'ses_c');
    const q = mergeDecisions(emptyQueue(), [A1, B1, C1]);
    expect(sessionChips(q).map((c) => c.name)).toEqual(['Claude Code', 'Claude Code (another session)', 'Claude Code (another session 3)']);
    // One session of each agent: the names as they are.
    expect(sessionChips(mergeDecisions(emptyQueue(), [A1, A2])).map((c) => c.name)).toEqual(['Claude Code']);
  });

  test('a group of action items alone sends nothing (the actions route sends those)', () => {
    const act = decision('msg_c/a-1', 'ses_c', 'msg_t3', { kind: 'action', state: 'picked' });
    const q = mergeDecisions(emptyQueue(), [act]);
    expect(groupReady(q, groupKeyOf(act))).toBe(false);
  });
});

describe("a group's send state", () => {
  const facts = (over: Partial<GroupSendFacts> = {}): GroupSendFacts => ({ ready: true, touched: true, draft: false, open: true, now: 1000, ...over });

  test('a group the person answered in this sitting starts a 5 s Hold; its first value is 5', () => {
    const next = nextGroupSend({ kind: 'waiting' }, facts());
    expect(next).toEqual({ kind: 'hold', until: 1000 + DECISION_HOLD_MS, paused: null });
    // Whatever clock the first render read (an old one, before the Hold began), it shows 5, never more.
    expect(holdSeconds(next as Extract<GroupSend, { kind: 'hold' }>, 1000)).toBe(5);
    expect(holdSeconds(next as Extract<GroupSend, { kind: 'hold' }>, 1000 - 5000)).toBe(5);
    expect(holdSeconds(next as Extract<GroupSend, { kind: 'hold' }>, 1000 + 4200)).toBe(1);
  });

  test('a group ready before this sitting (Keep as a draft) never sends by itself: Held · Send', () => {
    expect(nextGroupSend({ kind: 'waiting' }, facts({ touched: false }))).toEqual({ kind: 'held', by: 'untouched' });
    // Touched later, it starts its Hold; held by the person, it stays held.
    expect(nextGroupSend({ kind: 'held', by: 'untouched' }, facts()).kind).toBe('hold');
    expect(nextGroupSend({ kind: 'held', by: 'person' }, facts())).toEqual({ kind: 'held', by: 'person' });
    // Undo took back the only answer given in this sitting: the Hold gives way to Held · Send.
    expect(nextGroupSend({ kind: 'hold', until: 9, paused: null }, facts({ touched: false }))).toEqual({ kind: 'held', by: 'untouched' });
  });

  test('a thread with a reply draft never sends from here, touched or not', () => {
    expect(nextGroupSend({ kind: 'waiting' }, facts({ draft: true }))).toEqual({ kind: 'draft', held: false });
    expect(nextGroupSend({ kind: 'hold', until: 9, paused: null }, facts({ draft: true }))).toEqual({ kind: 'draft', held: false });
    // The draft goes: a Hold the person pressed before it is kept; otherwise a touched group starts its Hold.
    const held = nextGroupSend({ kind: 'held', by: 'person' }, facts({ draft: true }));
    expect(held).toEqual({ kind: 'draft', held: true });
    expect(nextGroupSend(held, facts())).toEqual({ kind: 'held', by: 'person' });
    expect(nextGroupSend({ kind: 'draft', held: false }, facts()).kind).toBe('hold');
    expect(nextGroupSend({ kind: 'draft', held: false }, facts({ touched: false }))).toEqual({ kind: 'held', by: 'untouched' });
  });

  test('a failed reply with nothing left to send is just waiting', () => {
    expect(nextGroupSend({ kind: 'failed', error: 'x' }, facts({ ready: false }))).toEqual({ kind: 'waiting' });
  });

  test('a sent group whose follow-up the person answered goes round again', () => {
    const sent: GroupSend = { kind: 'sent', at: '2026-10-24T10:00:00.000Z' };
    expect(nextGroupSend(sent, facts({ ready: false }))).toBe(sent);
    expect(nextGroupSend(sent, facts()).kind).toBe('hold');
    // A failed send waits for Try again.
    expect(nextGroupSend({ kind: 'failed', error: 'x' }, facts()).kind).toBe('failed');
  });

  test('a Hold pauses while tucked and runs on from where it was; a pick restarts it', () => {
    const hold = startHold(1000, true);
    const paused = pauseHold(hold, false, 3000);
    expect(paused).toEqual({ kind: 'hold', until: hold.kind === 'hold' ? hold.until : 0, paused: 3000 });
    // Tucked for a minute: still 3 s left once back.
    expect(pauseHold(paused, true, 63_000)).toEqual({ kind: 'hold', until: 66_000, paused: null });
    expect(restartHold(hold, 4000, true)).toEqual({ kind: 'hold', until: 9000, paused: null });
    // A Hold that starts while tucked starts paused.
    expect(startHold(1000, false)).toEqual({ kind: 'hold', until: 6000, paused: 5000 });
  });

  test('the answers a reply already carried do not make a group ready again', () => {
    const picked = (d: InboxDecision) => ({ ...d, question: { ...d.question, state: 'picked' as const, revision: 1 } });
    const q = mergeDecisions(emptyQueue(), [picked(A1), picked(A2)]);
    expect(groupReady(q, groupKeyOf(A1))).toBe(true);
    expect(groupReady(q, groupKeyOf(A1), new Set([A1.id, A2.id]))).toBe(false);
    expect(freshPicks(q, groupKeyOf(A1), new Set([A1.id]))).toEqual([A2.id]);
  });
});

describe('the Send', () => {
  const agent = (id: string, session: string, questions: InboxQuestion[]): InboxMessageWire =>
    ({ id, thread_id: 'msg_t1', project_id: 'prj_1', author: { kind: 'agent', host: 'claude-code', session, name: null }, subject: null, body: '', created_at: '2026-10-24T10:00:00.000Z', reply_to: null, questions }) as unknown as InboxMessageWire;
  test("is the thread's own Send targets, kept to the group's session and to replies that carry an answer", () => {
    const thread = {
      thread_id: 'msg_t1',
      messages: [
        agent('msg_1', 'ses_a', [question('q-1', { message_id: 'msg_1', state: 'picked', revision: 2 })]),
        agent('msg_2', 'ses_b', [question('q-2', { message_id: 'msg_2', state: 'picked', revision: 1 })]),
        agent('msg_3', 'ses_a', [question('q-3', { message_id: 'msg_3', state: 'picked', revision: 1 })]),
      ],
    } as unknown as InboxThread;
    const targets = groupSendTargets(thread, 's:claude-code\u0000ses_a');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.message.id).toBe('msg_3');
    expect(targets[0]!.questions).toEqual([{ message_id: 'msg_1', key: 'q-1', revision: 2 }, { key: 'q-3', revision: 1 }]);
    expect(groupSendTargets(thread, 's:claude-code\u0000ses_z')).toEqual([]);
  });

  test('after it: Sending (or Queued, Saved), Delivered, Working, Replied', () => {
    const row = (extra: Partial<InboxListRow>) => ({ last_author: 'person', last_agent_at: '2026-10-24T10:00:00.000Z', delivery: null, sent: null, ...extra }) as unknown as InboxListRow;
    const at = '2026-10-24T10:05:00.000Z';
    expect(afterSendOf(row({}), at, null)).toBe('sending');
    expect(afterSendOf(row({ delivery: { state: 'queued' } as InboxListRow['delivery'] }), at, true)).toBe('queued');
    expect(afterSendOf(row({ delivery: { state: 'saved' } as InboxListRow['delivery'] }), at, null)).toBe('saved');
    expect(afterSendOf(row({ delivery: { state: 'delivered' } as InboxListRow['delivery'] }), at, false)).toBe('delivered');
    expect(afterSendOf(row({ delivery: { state: 'delivered' } as InboxListRow['delivery'] }), at, true)).toBe('working');
    expect(afterSendOf(row({ last_author: 'agent', last_agent_at: '2026-10-24T10:06:00.000Z' }), at, true)).toBe('replied');
  });
});

describe('answers', () => {
  test('in the person\'s words, and a swipe only for a two-way choice', () => {
    expect(answerWords(choiceAnswer(A1.question, ['Yes'], 'soon'))).toBe('Yes');
    expect(answerWords(skipAnswer(A1.question, ''))).toBe('Skipped');
    expect(skipAnswer(A1.question, 'later').note).toBe('later');
    expect(swipeChoices(A1.question)).toEqual(['Yes', 'No']);
    expect(swipeChoices({ ...A1.question, kind: 'multi' })).toBeNull();
  });

  test("a picked label's markdown reads as its words on the stamp; the answer keeps the label as written", () => {
    const linked = { ...A1.question, choices: [{ label: '[15% off](forecast-15.html)' }, { label: '`FLAT10` code' }] } as InboxQuestion;
    const answer = choiceAnswer(linked, ['[15% off](forecast-15.html)'], '');
    expect(answer.selected).toEqual(['[15% off](forecast-15.html)']);
    expect(answerWords(answer)).toBe('15% off');
    expect(answerWords({ ...answer, selected: ['**20%** for members', '`FLAT10` code'] })).toBe('20% for members, FLAT10 code');
  });

  test("the swipe hint says the labels' words; the swipe commits the label as written", () => {
    const linked = { ...A1.question, choices: [{ label: '[Yes](a.html)' }, { label: '`No`' }] } as InboxQuestion;
    const choices = swipeChoices(linked)!;
    expect(choices).toEqual(['[Yes](a.html)', '`No`']);
    expect(swipeHint(choices)).toBe('Swipe right for Yes, left for No.');
  });
});

describe('the contract lines (approval "inbox-decision-mode", agent contract lines)', () => {
  const oneWay = (extra: Partial<InboxQuestion> = {}) =>
    question('q-del', {
      prompt: 'Delete the 3 duplicate invoices now?',
      choices: [
        { label: 'Delete now', description: 'The report is right today', recommended: false, settled: false },
        { label: 'Wait for month-end close', description: null, recommended: true, settled: false },
      ],
      recommendation: 'Wait for month-end close',
      reversible: { value: false, why: 'Deleted invoices cannot be restored.' },
      ...extra,
    });

  test('a one-way question never swipes, nor does a picture choice; a plain two-way one still does', () => {
    expect(swipeChoices(question('q-1'))).toEqual(['Yes', 'No']);
    expect(swipeChoices(oneWay())).toBeNull();
    const pictures = question('q-2', {
      choices: [
        { label: 'A', description: null, recommended: false, settled: false, image: { alt: 'A', src: 'a.png' } },
        { label: 'B', description: null, recommended: false, settled: false, image: { alt: 'B', src: 'b.png' } },
      ],
    });
    expect(swipeChoices(pictures)).toBeNull();
  });

  test('on a one-way question every answer asks once more, whichever choice the agent recommends; a Skip never does', () => {
    // The safe choice recommended: both choices confirm.
    const safe = oneWay();
    expect(answerNeedsConfirm(safe, choiceAnswer(safe, ['Delete now'], ''))).toBe(true);
    expect(answerNeedsConfirm(safe, choiceAnswer(safe, ['Wait for month-end close'], ''))).toBe(true);
    // The destructive choice recommended (the grammar does not say which one is one-way): it still confirms.
    const risky = oneWay({ choices: safe.choices.map((c) => ({ ...c, recommended: c.label === 'Delete now' })), recommendation: 'Delete now' });
    expect(answerNeedsConfirm(risky, choiceAnswer(risky, ['Delete now'], ''))).toBe(true);
    expect(answerNeedsConfirm(risky, choiceAnswer(risky, ['Wait for month-end close'], ''))).toBe(true);
    // Other and text confirm; a Skip and a note alone do not; a reversible question never does.
    expect(answerNeedsConfirm(safe, { ...choiceAnswer(safe, [], ''), other: 'Delete only the oldest one' })).toBe(true);
    const text = oneWay({ kind: 'text', choices: [], recommendation: null, suggested_text: 'Drop the table' });
    expect(answerNeedsConfirm(text, { ...choiceAnswer(text, [], ''), kind: 'text', text: 'Drop the table' })).toBe(true);
    expect(answerNeedsConfirm(safe, skipAnswer(safe, ''))).toBe(false);
    expect(answerNeedsConfirm(safe, { ...choiceAnswer(safe, [], ''), note: 'Ask finance' })).toBe(false);
    const plain = question('q-1');
    expect(answerNeedsConfirm(plain, choiceAnswer(plain, ['Yes'], ''))).toBe(false);
  });

  test("the confirm button's words are the answer, cut at about 40 characters", () => {
    expect(confirmLabel('Delete now')).toBe('Delete now');
    const long = 'Delete every duplicate invoice in the legacy billing system today';
    expect(confirmLabel(long).length).toBeLessThanOrEqual(40);
    expect(confirmLabel(long).endsWith('…')).toBe(true);
    expect(long.startsWith(confirmLabel(long).slice(0, -1))).toBe(true);
  });
});
