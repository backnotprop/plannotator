import { expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { InboxEvent } from '../../api';
import { inboxKeys } from '../keys';
import { isThreadStale, putThread, staleThread } from '../queries/thread';
import type { HeldThread } from './record';
import { applyStreamRecord } from './stream';

const T = 'msg_ROOT';
const at = '2026-11-10T10:00:00.000Z';
const agent = { kind: 'agent', host: 'claude-code', session: 'ses_1' } as const;
const msg = (id: string): InboxMessageWire =>
  ({ id, thread_id: T, project_id: 'prj', author: agent, body: id, subject: id === T ? 'Release' : null, created_at: at, resolved_at: null, reply_to: id === T ? null : T, seq: id === T ? 1 : undefined }) as unknown as InboxMessageWire;
const question = (message: string, key: string, kind = 'single'): InboxQuestion =>
  ({ message_id: message, key, kind, prompt: key, state: 'open', revision: 0, answer: null }) as unknown as InboxQuestion;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test('an agent message with a question and an action item draws with its cards, in one redraw, with no read', async () => {
  const client = new QueryClient();
  putThread(client, T, { serverSession: 's', cursor: 10, thread: { thread_id: T, project: { id: 'prj', name: 'billing', root: '/r' } as never, subject: 'Release', thread_name: null, resolved_at: null, archive_seq: null, messages: [msg(T)] } } as never);
  const observer = new QueryObserver<HeldThread>(client, { queryKey: inboxKeys.thread(T), enabled: false, notifyOnChangeProps: ['data'] });
  const drawn: HeldThread[] = [];
  let inTask = false;
  const stop = observer.subscribe(() => {
    if (inTask) return;
    inTask = true;
    setTimeout(() => {
      inTask = false;
      const held = client.getQueryData<HeldThread>(inboxKeys.thread(T));
      if (held) drawn.push(held);
    }, 0);
  });
  await wait(150);

  const records: InboxEvent[] = [
    { seq: 11, kind: 'message', id: 'msg_N', first: true, message: msg('msg_N') as never },
    { seq: 12, kind: 'question', id: 'msg_N/q1', thread_id: T, question: question('msg_N', 'q1') },
    { seq: 13, kind: 'question', id: 'msg_N/a1', thread_id: T, question: question('msg_N', 'a1', 'action') },
  ];
  const outcomes = records.map((record) => applyStreamRecord(client, record).kind);
  await wait(150);

  expect(outcomes).toEqual(['applied', 'applied', 'applied']);
  const withMessage = drawn.filter((held) => held.thread.messages.some((m) => m.id === 'msg_N'));
  expect(withMessage.length).toBe(1);
  const arrived = withMessage[0]!.thread.messages.find((m) => m.id === 'msg_N')!;
  expect([arrived.questions?.map((q) => q.key), arrived.actions?.map((q) => q.key)]).toEqual([['q1'], ['a1']]);
  expect(client.getQueryState(inboxKeys.thread(T))?.isInvalidated).toBe(false);
  stop();
  client.clear();
});

test('a record that came while the thread was stale keeps it stale until a read that has the record lands', () => {
  const client = new QueryClient();
  const base = { serverSession: 's', cursor: 10, thread: { thread_id: T, project: { id: 'prj', name: 'billing', root: '/r' } as never, subject: 'Release', thread_name: null, resolved_at: null, archive_seq: null, messages: [msg(T)] } } as never;
  putThread(client, T, base);
  staleThread(client, T);
  expect(applyStreamRecord(client, { seq: 20, kind: 'message', id: 'msg_N', first: true, message: msg('msg_N') } as InboxEvent).kind).toBe('unheld');
  putThread(client, T, { ...(base as object), cursor: 15 } as never);
  expect(isThreadStale(client, T)).toBe(true);
  putThread(client, T, { ...(base as object), cursor: 20 } as never);
  expect(isThreadStale(client, T)).toBe(false);
});
