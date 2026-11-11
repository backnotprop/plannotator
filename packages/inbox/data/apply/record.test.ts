/**
 * The record applier (record.ts) as a table: each live-stream record against a held thread, and what the thread
 * shows after it. A wrong row here is a window that shows something the server does not (an agent's message
 * missing, an answer going backwards, an archive undone by a late read).
 */
import { describe, expect, test } from 'bun:test';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { InboxEvent, ThreadModel } from '../../api';
import { applyRecord, reconcileRead, recordMovesFiles, type HeldThread } from './record';

const T = 'msg_ROOT';
const at = '2026-11-10T10:00:00.000Z';
const agent = { kind: 'agent', host: 'claude-code', session: 'ses_1' } as const;
const person = { kind: 'person' } as const;
const msg = (id: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire =>
  ({ id, thread_id: T, project_id: 'prj', author: agent, body: id, subject: id === T ? 'Release' : null, created_at: at, resolved_at: null, reply_to: id === T ? null : T, ...extra }) as unknown as InboxMessageWire;
const question = (key: string, revision: number, extra: Partial<InboxQuestion> = {}): InboxQuestion =>
  ({ message_id: T, key, kind: 'single', prompt: key, state: 'open', revision, answer: null, ...extra }) as unknown as InboxQuestion;
const model = (messages: InboxMessageWire[], cursor = 10, applied?: Record<string, number>): HeldThread => ({
  serverSession: 's',
  cursor,
  thread: { thread_id: T, project: { id: 'prj', name: 'billing', root: '/r' } as never, subject: 'Release', thread_name: null, resolved_at: null, archive_seq: null, messages },
  ...(applied ? { applied } : {}),
});
const held = model([msg(T, { seq: 1, questions: [question('q1', 1)] }), msg('msg_R', { author: person, seq: 5, sent_annotations: 2 })]);
const message = (seq: number, m: InboxMessageWire, first = true): InboxEvent => ({ seq, kind: 'message', id: m.id, first, message: m as never });
const q = (seq: number, question: InboxQuestion, thread: string | null = T): InboxEvent => ({ seq, kind: 'question', id: question.key, thread_id: thread, question });

type Row = [name: string, event: InboxEvent, want: 'none' | 'reread' | ((after: HeldThread) => void)];
const rows: Row[] = [
  ['a new agent message lands at the end with its seq', message(11, msg('msg_N')), (after) => {
    expect(after.thread.messages.map((m) => [m.id, m.seq])).toEqual([[T, 1], ['msg_R', 5], ['msg_N', 11]]);
    expect(after.applied).toEqual({ msg_N: 11 });
  }],
  ['a record the read already has (a replay) changes nothing', message(9, msg('msg_N')), 'none'],
  ['a later line of a reply keeps its seq and comment count', message(12, msg('msg_R', { author: person, delivered_at: at } as never), false), (after) => {
    const reply = after.thread.messages[1]!;
    expect([reply.seq, reply.sent_annotations, (reply as { delivered_at?: string }).delivered_at]).toEqual([5, 2, at]);
  }],
  ['the root archived: the thread is archived, its archive seq is the line', message(13, msg(T, { resolved_at: at }), false), (after) => {
    expect([after.thread.resolved_at, after.thread.archive_seq]).toEqual([at, 13]);
    expect(after.thread.messages[0]!.questions?.[0]?.key).toBe('q1');
  }],
  ['the root renamed: the thread takes the name', message(14, msg(T, { thread_name: 'Ship it' }), false), (after) => {
    expect(after.thread.thread_name).toBe('Ship it');
  }],
  ['a subject the server works out is read', message(15, msg(T, { subject: 'Other' }), false), 'reread'],
  ['the note carrying a 👍 is read (the read hides it)', message(16, msg('msg_A', { author: person, ack_of: T } as never)), 'reread'],
  ['a 👍 given on a message is read (its delivery is in no record)', message(17, msg(T, { ack: { at, reaction: 'thumbs_up' } } as never), false), 'reread'],
  ['an answer saved elsewhere shows on its card', q(18, question('q1', 2, { state: 'picked' })), (after) => {
    expect(after.thread.messages[0]!.questions?.[0]).toMatchObject({ revision: 2, state: 'picked' });
    expect(after.applied).toEqual({ [`${T}/q1`]: 18 });
  }],
  ['an action item goes with the actions, not the questions', q(19, question('a1', 1, { kind: 'action' } as never)), (after) => {
    const root = after.thread.messages[0]!;
    expect([root.questions?.map((x) => x.key), root.actions?.map((x) => x.key)]).toEqual([['q1'], ['a1']]);
  }],
  ['an older revision never takes an answer back', q(20, question('q1', 0)), 'none'],
  // The thread's subject came from q1 (the agent gave none): the server follows the replacement, so the header does.
  ['the question a subject came from replaced: the thread is read (its subject)', q(25, question('q1', 2, { state: 'superseded', superseded_by: { message_id: 'msg_N', key: 'q1' } })), 'reread'],
  ['a question of a message not held is read', q(21, { ...question('q9', 1), message_id: 'msg_X' }), 'reread'],
  ['a comment that went with a reply is read (its count)', { seq: 22, kind: 'annotation', id: 'ann', annotation: { thread_id: T, sent_reply_id: 'msg_R' } as never }, 'reread'],
  ['a comment waiting on a file changes no message', { seq: 23, kind: 'annotation', id: 'ann', annotation: { thread_id: T, sent_reply_id: null } as never }, 'none'],
  ["another thread's record does nothing here", message(24, { ...msg('msg_O'), thread_id: 'msg_OTHER' }), 'none'],
  // Safe default: a kind this build has no case for (a newer Inbox's) is read, never left as it was.
  ['a record kind this build does not know is read', { seq: 26, kind: 'reaction', id: 'r' } as unknown as InboxEvent, 'reread'],
  ['a project record (a label the header reads) is read', { seq: 27, kind: 'project', id: 'prj', project: {} } as unknown as InboxEvent, 'reread'],
];

describe('one stream record on a held thread', () => {
  for (const [name, event, want] of rows) {
    test(name, () => {
      const out = applyRecord(held, event);
      if (typeof want === 'string') expect(out.kind).toBe(want);
      else {
        expect(out.kind).toBe('applied');
        if (out.kind === 'applied') want(out.model);
      }
    });
  }
  test('a question replaced under a subject the agent gave changes no subject: drawn in place', () => {
    const given = model([msg(T, { seq: 1, subject_question: null, questions: [question('q1', 1)] })]);
    const out = applyRecord(given, q(25, question('q1', 2, { state: 'superseded', superseded_by: { message_id: 'msg_N', key: 'q1' } })));
    expect(out.kind).toBe('applied');
  });
  test('the same record twice draws once', () => {
    const once = applyRecord(held, message(11, msg('msg_N')));
    if (once.kind !== 'applied') throw new Error('not applied');
    expect(applyRecord(once.model, message(11, msg('msg_N'))).kind).toBe('none');
  });
});

describe('a read landing after records', () => {
  const read = (cursor: number, messages: InboxMessageWire[]): ThreadModel => ({ ...model(messages, cursor) });
  const base = [msg(T, { seq: 1, questions: [question('q1', 1)] }), msg('msg_R', { author: person, seq: 5 })];
  test('a read that left before an agent message keeps that message', () => {
    const after = applyRecord(model(base), message(11, msg('msg_N')));
    if (after.kind !== 'applied') throw new Error('not applied');
    const kept = reconcileRead(after.model, read(10, base));
    expect(kept.thread.messages.map((m) => m.id)).toEqual([T, 'msg_R', 'msg_N']);
  });
  test('a read newer than every record applied is taken whole', () => {
    const after = applyRecord(model(base), message(11, msg('msg_N')));
    if (after.kind !== 'applied') throw new Error('not applied');
    const fresh = read(30, [...base, msg('msg_N', { seq: 11, body: 'server copy' })]);
    expect(reconcileRead(after.model, fresh)).toBe(fresh);
  });
  test('an older read never takes back a newer answer or an archive', () => {
    let now: HeldThread = model(base);
    for (const event of [q(12, question('q1', 3, { state: 'picked' })), message(13, msg(T, { resolved_at: at }), false)]) {
      const out = applyRecord(now, event);
      if (out.kind !== 'applied') throw new Error('not applied');
      now = out.model;
    }
    const kept = reconcileRead(now, read(11, base));
    expect(kept.thread.messages[0]!.questions?.[0]).toMatchObject({ revision: 3, state: 'picked' });
    expect([kept.thread.resolved_at, kept.thread.archive_seq]).toEqual([at, 13]);
  });
});

describe('which records read the thread\'s files apart (a comment, the agent at work), and which do not', () => {
  const ann = (thread: string): InboxEvent => ({ seq: 30, kind: 'annotation', id: 'ann', annotation: { thread_id: thread, sent_reply_id: null } as never });
  const cases: [string, InboxEvent, boolean][] = [
    ['a comment added, edited or removed (the foot\'s count)', ann(T), true],
    ["another thread's comment", ann('msg_OTHER'), false],
    ['a new message with no file (a file edited or deleted on disk shows)', message(31, msg('msg_N')), true],
    ['a new message that brings files: the pane reads them itself', message(32, msg('msg_F', { attachments: [{ id: 'att' }] } as never)), false],
    ["the agent read the person's reply (the root's agent_checked_seq moved)", message(33, msg(T, { agent_checked_seq: 5 } as never), false), true],
    ['a look on the root (person_seen_seq)', message(34, msg(T, { person_seen_seq: 5 } as never), false), false],
    ['the root archived', message(35, msg(T, { resolved_at: at }), false), false],
    ["a later line of a reply", message(36, msg('msg_R', { author: person, delivered_at: at } as never), false), false],
    ['a pick saved', q(37, question('q1', 2, { state: 'picked' })), false],
  ];
  for (const [name, event, want] of cases) test(name, () => expect(recordMovesFiles(held, event)).toBe(want));
});
