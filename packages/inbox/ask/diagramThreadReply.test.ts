import { expect, test } from 'bun:test';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { diagramReplyTarget, diagramThreadReply } from './diagramThreadReply';

const thread = (messages: Partial<InboxMessageWire>[], extra?: Partial<InboxThread>) =>
  ({ messages, thread_id: 'root', resolved_at: null, ...extra }) as InboxThread;
const person = { id: 'mine', author: { kind: 'person' as const } };
const agent = { id: 'theirs', author: { kind: 'agent' as const, host: 'codex', session: 'author', name: 'Diagram author' } };

test('a question about a person attachment follows the ordinary thread recipient', () => {
  expect(diagramReplyTarget(thread([agent, person]), person.id)).toBe(agent.id);
  expect(diagramReplyTarget(thread([person]), person.id)).toBeUndefined();
  expect(diagramReplyTarget(thread([agent]), 'another thread')).toBeUndefined();
  expect(diagramReplyTarget(thread([agent], { resolved_at: '2026-10-01', archive_seq: 1 }), agent.id)).toBeUndefined();
});

test('a lost response keeps the same key on a plain HTTP origin and only sends the diagram question', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const inputs: Parameters<Parameters<typeof diagramThreadReply>[0]>[1][] = [];
    const accepted: boolean[] = [];
    const send = diagramThreadReply(async (id, input) => {
      expect(id).toBe('msg_owner');
      inputs.push(input);
      if (inputs.length === 1) throw new Error('Interrupted');
      return { reply: 'msg_sent', questions: [], replayed: true };
    }, held => accepted.push(held));
    await expect(send('msg_owner', 'Why?', 'panel: Queue')).rejects.toThrow('Interrupted');
    expect(await send('msg_owner', 'Why?', 'panel: Queue')).toBe(true);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[0]).toEqual({ idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/), words: 'Why?\n\npanel: Queue', questions: [], annotation_ids: [] });
    expect(accepted).toEqual([false]);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
});
