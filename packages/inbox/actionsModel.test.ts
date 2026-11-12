import { expect, test } from 'bun:test';
import type { InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { foldSnippet, holdingsOf, isPersonLook, isPersonReply, lookBoundary } from './folding';

const q = (over: Partial<InboxQuestion>): InboxQuestion =>
  ({ key: 'q-1', position: 0, kind: 'single', prompt: 'Ship it?', context: null, choices: [], recommendation: null, suggested_text: null, stopped: null, holds_up: [], asked_by_agent_id: null, orphaned: false, state: 'open', answer: null, revision: 0, sent_revision: 0, picked_by: null, picked_at: null, sent_reply_id: null, message_id: 'msg_a', superseded_by: null, ...over }) as InboxQuestion;

const agent = (over: Partial<InboxMessageWire>): InboxMessageWire =>
  ({ id: 'msg_a', project_id: 'prj', thread_id: 'msg_a', reply_to: null, author: { kind: 'agent', host: 'claude-code', session: 's', name: null }, subject: null, body: '', created_at: '2026-10-21T15:00:00.000Z', resolved_at: null, idempotency_key: null, ...over }) as InboxMessageWire;

test('a folded message that is only an action item says its line', () => {
  const message = agent({ body: ':::action\nApprove the **deploy**\n:::', actions: [q({ key: 'a-1', kind: 'action', prompt: 'Approve the deploy' })] });
  expect(foldSnippet(message)).toEqual({ kind: 'words', text: 'Action item: Approve the deploy' });
});

test('a question and an action item give two chips with different kinds (React keys)', () => {
  const message = agent({ questions: [q({})], actions: [q({ key: 'a-1', kind: 'action' })] });
  const kinds = holdingsOf(message, { delivered: false }).map((h) => h.kind);
  expect(kinds).toEqual(['open', 'todo']);
  expect(new Set(kinds).size).toBe(kinds.length);
});

test("an action item's report is the person's reply but not their look", () => {
  const report = { ...agent({ id: 'msg_r', author: { kind: 'person' }, action_report: ['msg_a/a-1'] }), seq: 9 } as InboxMessageWire;
  expect(isPersonReply(report)).toBe(true);
  expect(isPersonLook(report)).toBe(false);
  const thread = { messages: [{ ...agent({}), seq: 1, person_seen_seq: 1 }, { ...agent({ id: 'msg_b' }), seq: 5 }, report] } as unknown as InboxThread;
  expect(lookBoundary(thread)).toBe(1);
});

test("a folded Re-ask note that asked for an action item says so", () => {
  const note = agent({ id: 'msg_n', author: { kind: 'person' }, reask: ['msg_a/q-11111111', 'msg_a/a-22222222'] });
  expect(foldSnippet(note)).toEqual({ kind: 'words', text: 'Asked to re-ask 1 open question and 1 action item in one message' });
});
