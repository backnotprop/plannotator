/**
 * The replies one Send makes (approval "inbox-explicit-skip", 2026-10-21):
 * ONE per agent session, carrying every pick waiting on that session's
 * messages, and skipping only the questions the person chose ("Skip them").
 * The owner's thread: one session, 8 messages, 11 questions; one answered.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { replyKeysToRenew, sendTargetAnswerIds, sendTargetsOf, type SentContents } from './sendTargets';

type State = 'open' | 'picked' | 'sent';
const message = (id: string, session: string | null, states: State[]): InboxMessageWire =>
  ({
    id,
    thread_id: 'msg_1',
    author: { kind: 'agent', host: 'claude-code', session, name: 'Claude Code' },
    body: '',
    created_at: '2026-10-21T15:56:00.000Z',
    questions: states.map((state, i) => ({ key: `q-${id}-${i}`, state, revision: state === 'picked' ? 1 : 0 })),
  }) as unknown as InboxMessageWire;
const thread = (messages: InboxMessageWire[]) => ({ thread_id: 'msg_1', messages }) as unknown as InboxThread;

describe('sendTargetsOf', () => {
  test("the owner's case: one session, 8 messages, the newest answered: one reply, to it, skipping nothing", () => {
    const messages = [message('msg_1', 'ses_a', ['open', 'open', 'open', 'open'])];
    for (let i = 2; i <= 7; i++) messages.push(message(`msg_${i}`, 'ses_a', ['open']));
    messages.push(message('msg_8', 'ses_a', ['picked']));
    const targets = sendTargetsOf(thread(messages));
    expect(targets).toEqual([{ message: messages[7], questions: [{ key: 'q-msg_8-0', revision: 1 }], skip: [], actions: [] }]);
  });

  test('picks on three of one session\'s messages: one reply to the latest of them, naming the others', () => {
    const m = [message('msg_1', 'ses_a', ['picked', 'open']), message('msg_2', 'ses_a', ['picked']), message('msg_3', 'ses_a', ['open']), message('msg_4', 'ses_a', ['picked'])];
    const targets = sendTargetsOf(thread(m));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.message.id).toBe('msg_4');
    expect(targets[0]!.questions).toEqual([
      { message_id: 'msg_1', key: 'q-msg_1-0', revision: 1 },
      { message_id: 'msg_2', key: 'q-msg_2-0', revision: 1 },
      { key: 'q-msg_4-0', revision: 1 },
    ]);
  });

  test('Skip them: only the chosen ids are skipped; a question that landed later is not in the set, so it stays open', () => {
    const m = [message('msg_1', 'ses_a', ['open', 'open']), message('msg_2', 'ses_a', ['picked']), message('msg_late', 'ses_a', ['open'])];
    const chosen = new Set(['msg_1/q-msg_1-0', 'msg_1/q-msg_1-1']);
    const targets = sendTargetsOf(thread(m), chosen);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.message.id).toBe('msg_2');
    expect(targets[0]!.skip).toEqual([
      { message_id: 'msg_1', key: 'q-msg_1-0' },
      { message_id: 'msg_1', key: 'q-msg_1-1' },
    ]);
  });

  test('two sessions: one reply each; the words ride the reply of the session that wrote last', () => {
    const m = [message('msg_a1', 'ses_a', ['picked']), message('msg_b1', 'ses_b', ['picked']), message('msg_a2', 'ses_a', [])];
    const targets = sendTargetsOf(thread(m));
    expect(targets.map((t) => t.message.id)).toEqual(['msg_b1', 'msg_a1']);
  });

  test('the latest agent message from a session with nothing to send comes last, empty, for the words', () => {
    const m = [message('msg_a1', 'ses_a', ['picked']), message('msg_b1', 'ses_b', [])];
    const targets = sendTargetsOf(thread(m));
    expect(targets.map((t) => [t.message.id, t.questions.length])).toEqual([
      ['msg_a1', 1],
      ['msg_b1', 0],
    ]);
  });

  test('messages with no session are each a reply of their own', () => {
    const m = [message('msg_1', null, ['picked']), message('msg_2', null, ['picked'])];
    expect(sendTargetsOf(thread(m)).map((t) => t.message.id)).toEqual(['msg_1', 'msg_2']);
  });
});

describe('action items whose Done waits in the draft go with the Send (approval "inbox-action-items-in-reply")', () => {
  const withActions = (m: InboxMessageWire, actions: { key: string; staged?: boolean; by?: 'person' | 'agent'; note?: string | null; state?: string }[]) =>
    ({
      ...m,
      actions: actions.map((a) => ({
        key: a.key,
        kind: 'action',
        state: a.state ?? 'picked',
        revision: 1,
        sent_revision: null,
        action_result:
          a.by === 'agent'
            ? { outcome: 'done', note: null, at: '2026-10-26T10:00:00.000Z', by: 'agent', message_id: 'msg_x', person: { outcome: 'done', note: a.note ?? null, at: '2026-10-26T09:00:00.000Z' } }
            : { outcome: 'done', note: null, at: '2026-10-26T09:00:00.000Z', by: 'person', message_id: null, ...(a.staged ? { staged: true } : {}) },
      })),
    }) as unknown as InboxMessageWire;

  test('with no pick, a Done alone makes a reply to its message', () => {
    const m = [withActions(message('msg_1', 'ses_a', []), [{ key: 'a-1', staged: true }]), message('msg_2', 'ses_a', [])];
    const targets = sendTargetsOf(thread(m));
    expect(targets.map((t) => [t.message.id, t.actions])).toEqual([['msg_1', [{ key: 'a-1' }]]]);
  });

  test("a Done on an older message rides the same session's reply with the picks, by message id", () => {
    const m = [withActions(message('msg_1', 'ses_a', []), [{ key: 'a-1', staged: true }]), message('msg_2', 'ses_a', ['picked'])];
    const targets = sendTargetsOf(thread(m));
    expect(targets.map((t) => [t.message.id, t.actions])).toEqual([['msg_2', [{ message_id: 'msg_1', key: 'a-1' }]]]);
  });

  test('a Done through the timed path (no staged) is not the Send\'s; the agent\'s own done goes only with a note to carry', () => {
    const m = [
      withActions(message('msg_1', 'ses_a', []), [
        { key: 'a-timed' },
        { key: 'a-seen', by: 'agent', state: 'closed' },
        { key: 'a-noted', by: 'agent', state: 'closed', note: 'Rotated the key too.' },
      ]),
    ];
    expect(sendTargetsOf(thread(m))[0]!.actions).toEqual([{ key: 'a-noted' }]);
  });
});

describe('a retried Send keeps or renews each reply\'s key', () => {
  const c = (value: string, answers: string[]): SentContents => ({ value, answers });
  test('a pick added on the retry renews the key, so the new answer is not dropped by a replay', () => {
    const before = new Map([['s:ses_a', c('v', ['a:msg_1/q-1'])]]);
    const now = new Map([['s:ses_a', c('v', ['a:msg_1/q-1', 'a:msg_2/q-2'])]]);
    expect(replyKeysToRenew(before, now)).toEqual(['s:ses_a']);
  });
  test('a skip added, or the words changed, renews it too', () => {
    expect(replyKeysToRenew(new Map([['k', c('v', [])]]), new Map([['k', c('v', ['s:msg_1/q-1'])]]))).toEqual(['k']);
    expect(replyKeysToRenew(new Map([['k', c('v', [])]]), new Map([['k', c('w', [])]]))).toEqual(['k']);
  });
  test('the same Send, or one whose pick went with the last try, keeps the key (a replay, not a second reply)', () => {
    expect(replyKeysToRenew(new Map([['k', c('v', ['a:msg_1/q-1'])]]), new Map([['k', c('v', ['a:msg_1/q-1'])]]))).toEqual([]);
    expect(replyKeysToRenew(new Map([['k', c('v', ['a:msg_1/q-1'])]]), new Map([['k', c('v', [])]]))).toEqual([]);
    expect(replyKeysToRenew(null, new Map([['k', c('v', [])]]))).toEqual([]);
  });
  test('answer ids name the message, the reply\'s own included', () => {
    const m = [message('msg_1', 'ses_a', ['picked']), message('msg_2', 'ses_a', ['picked', 'open'])];
    const [target] = sendTargetsOf(thread(m), new Set(['msg_2/q-msg_2-1']));
    expect(sendTargetAnswerIds(target!)).toEqual(['a:msg_1/q-msg_1-0', 'a:msg_2/q-msg_2-0', 's:msg_2/q-msg_2-1']);
  });
});
