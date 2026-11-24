/**
 * Decision mode's queue, pure (decisions/queue.ts; approval "inbox-decision-mode-one-send"). What regresses if these
 * fail: messages come in the wrong order (Stopped and Holds up first, then the thread's order), Later does not move a
 * message to the end before Send, a message that arrives or leaves mid-sitting loses the person's place, an answer in
 * the draft or an action item marked in it does not count, a permission prompt (whose card answers at once) or a
 * question about to be asked again lands in it, or the way in says the wrong thing.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { back, decideEntryLabel, decideQueue, decideTally, laterOffered, next, putOff, startSitting, stepIndex, syncSitting } from './decisions/queue';

function q(key: string, patch: Partial<InboxQuestion> = {}): InboxQuestion {
  return { key, position: 0, kind: 'single', prompt: key, context: null, choices: [], recommendation: null, suggested_text: null, stopped: null, holds_up: [], asked_by_agent_id: 'ses_a', orphaned: false, state: 'open', answer: null, revision: 0, sent_revision: 0, picked_by: null, picked_at: null, sent_reply_id: null, message_id: 'x', superseded_by: null, ...patch } as InboxQuestion;
}

function m(id: string, questions: InboxQuestion[], actions: InboxQuestion[] = [], author: 'agent' | 'person' = 'agent'): InboxMessageWire {
  return { id, thread_id: 't', author: author === 'agent' ? { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null } : { kind: 'person' }, body: '', created_at: '2026-11-24T10:00:00.000Z', questions, actions } as unknown as InboxMessageWire;
}

const answer = { v: 1, key: 'a', kind: 'single', prompt: 'a', selected: ['Yes'] } as InboxQuestion['answer'];
const live = () => true;

describe('the queue', () => {
  test('Stopped first, then Holds up, then thread order; nothing left to decide, a person\'s message and a sent question are not in it', () => {
    const messages = [
      m('m1', [q('a')]),
      m('m2', [q('b', { holds_up: ['the deploy'] })]),
      m('m3', [q('c', { state: 'sent' })]),
      m('m4', [q('d', { stopped: 'the payments PR' })]),
      m('m5', [q('e')], [], 'person'),
      m('m6', [q('f', { state: 'superseded' })]),
      m('m7', [q('g')]),
    ];
    expect(decideQueue(messages, live)).toEqual(['m4', 'm2', 'm1', 'm7']);
    // A message the archive closed (not live) is left out.
    expect(decideQueue(messages, (x) => x.id !== 'm7')).toEqual(['m4', 'm2', 'm1']);
  });

  test('a tally counts what waits and what has an answer or a mark in the draft, a save on its way included', () => {
    const action = q('act', { kind: 'action' });
    const staged = q('act2', { kind: 'action', state: 'picked', action_result: { outcome: 'done', note: null, at: 'now', by: 'person', staged: true } } as Partial<InboxQuestion>);
    const message = m('m1', [q('a', { state: 'picked', answer }), q('b')], [action, staged]);
    expect(decideTally(message)).toEqual({ total: 4, answered: 2 });
    expect(decideTally(message, new Map([['m1/b', answer]]))).toEqual({ total: 4, answered: 3 });
    // A pick being taken back counts as unanswered at once.
    expect(decideTally(message, new Map([['m1/a', null]]))).toEqual({ total: 4, answered: 1 });
    // A message whose only decision is answered in the draft stays in the queue.
    expect(decideQueue([m('m9', [q('z', { state: 'picked', answer })])], live)).toEqual(['m9']);
  });

  test("a launched session's permission prompt is never in it: its card answers at once, so it stays in the thread", () => {
    const prompt = { ...m('p1', [q('allow')]), author: { kind: 'agent', host: 'claude-code', session: 'perm:ses_a', name: null } } as InboxMessageWire;
    expect(decideQueue([m('m1', [q('a')]), prompt, m('m2', [q('b')])], live)).toEqual(['m1', 'm2']);
  });

  test('the open questions a waiting Re-ask note lists are left out, until the session it went to writes again', () => {
    const note = { ...m('n1', [], [], 'person'), reply_to: 'm1', reask: ['m1/a'] } as InboxMessageWire;
    const asked = m('m1', [q('a'), q('b')]);
    const alone = m('m2', [q('c')]);
    // m1/a is about to be asked again: m1 holds one decision (b); m2 none but its own.
    expect(decideQueue([asked, alone, note], live)).toEqual(['m1', 'm2']);
    const onlyReasked = m('m1', [q('a')]);
    expect(decideQueue([onlyReasked, note], live)).toEqual([]);
    // The session wrote since the note: it no longer waits, and the question is back.
    const wrote = { ...m('m3', []), created_at: '2026-11-24T11:00:00.000Z' } as InboxMessageWire;
    expect(decideQueue([onlyReasked, note, wrote], live)).toEqual(['m1']);
  });
});

describe('moving through a sitting', () => {
  test('Next and Back walk the order to Send and back; Later moves the message to the end, before Send', () => {
    let s = startSitting(['a', 'b', 'c']);
    expect(s.current).toBe('a');
    s = putOff(s);
    expect(s.order).toEqual(['b', 'c', 'a']);
    expect(s.current).toBe('b');
    expect(s.later).toEqual(['a']);
    s = next(next(s));
    expect(s.current).toBe('a');
    // The last before Send: no Later there.
    expect(laterOffered(s)).toBe(false);
    s = next(s);
    expect(s.current).toBeNull();
    expect(stepIndex(s)).toBe(3);
    expect(back(s).current).toBe('a');
  });

  test('a message that arrives joins the end; one that went leaves, and the next takes its place on screen', () => {
    let s = startSitting(['a', 'b', 'c']);
    s = next(s);
    expect(syncSitting(s, ['a', 'b', 'c', 'd']).order).toEqual(['a', 'b', 'c', 'd']);
    const gone = syncSitting(s, ['a', 'c']);
    expect(gone.order).toEqual(['a', 'c']);
    expect(gone.current).toBe('c');
    // Nothing changed: the same sitting.
    expect(syncSitting(s, ['a', 'b', 'c'])).toBe(s);
  });
});

describe('the way in', () => {
  test('"Decide these N" when only questions wait, "Decide N one at a time" with action items too, "Resume" after leaving', () => {
    expect(decideEntryLabel(3, 3)).toBe('Decide these 3');
    expect(decideEntryLabel(8, 7)).toBe('Decide 8 one at a time');
    expect(decideEntryLabel(8, 7, { left: 2, messages: 4 })).toBe('Resume · 2 of 4 messages left');
    expect(decideEntryLabel(1, 1, { left: 1, messages: 1 })).toBe('Resume · 1 of 1 message left');
    // Every message answered and nothing sent: never "0 of 3 left".
    expect(decideEntryLabel(4, 4, { left: 0, messages: 3 })).toBe('Resume · all answered, not sent yet');
  });
});
