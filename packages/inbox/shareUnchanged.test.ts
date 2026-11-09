/**
 * A re-read of the open thread keeps what did not change as the same objects (shareUnchanged.ts, #2948): earlier
 * reads that a message's kept callbacks still reach then pin only what changed, not a full copy of the thread.
 */
import { expect, test } from 'bun:test';
import { shareUnchanged } from './shareUnchanged';

const message = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
  body,
  created_at: '2026-11-08T19:00:00.000Z',
  attachments: [{ id: `att_${id}`, name: 'screen.png', width: 2880, height: 1800 }],
  questions: [] as { key: string; state: string }[],
  ...extra,
});
const thread = (messages: ReturnType<typeof message>[]) => ({ thread_id: 'msg_1', subject: 'Checkout', thread_name: 'checkout', messages });
/** A fresh read: the same data, every object new (as JSON.parse makes it). */
const reread = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

test('a re-read with nothing changed is the earlier read itself', () => {
  const before = thread([message('m1', 'one'), message('m2', 'two')]);
  expect(shareUnchanged(before, reread(before))).toBe(before);
});

test("a message that came in: the thread and its list are new, every earlier message is the earlier read's object", () => {
  const before = thread([message('m1', 'one'), message('m2', 'two')]);
  const next = reread(thread([...before.messages, message('m3', 'three')]));
  const shared = shareUnchanged(before, next);
  expect(shared).not.toBe(before);
  expect(shared.messages).not.toBe(before.messages);
  expect(shared.messages[0]).toBe(before.messages[0]);
  expect(shared.messages[1]).toBe(before.messages[1]);
  expect(shared.messages[2]).toBe(next.messages[2]);
  expect(shared).toEqual(next);
});

test('a message that changed is new, with its unchanged parts kept; its neighbours are kept', () => {
  const before = thread([message('m1', 'one'), message('m2', 'two', { questions: [{ key: 'q1', state: 'open' }] })]);
  const next = reread(before);
  next.messages[1]!.questions = [{ key: 'q1', state: 'sent' }];
  const shared = shareUnchanged(before, next);
  expect(shared.messages[0]).toBe(before.messages[0]);
  expect(shared.messages[1]).not.toBe(before.messages[1]);
  expect(shared.messages[1]!.attachments).toBe(before.messages[1]!.attachments);
  expect(shared.messages[1]!.author).toBe(before.messages[1]!.author);
  expect(shared.messages[1]!.questions).toEqual([{ key: 'q1', state: 'sent' }]);
  expect(shared).toEqual(next);
});

test('a field that appears, goes or turns null makes its object new; the read is always equal to the fresh one', () => {
  const before = { a: { x: 1 }, b: { y: 2 }, c: { z: 3 } };
  const appeared = shareUnchanged(before, { a: { x: 1 }, b: { y: 2 }, c: { z: 3, w: 4 } });
  expect(appeared.a).toBe(before.a);
  expect(appeared.c).toEqual({ z: 3, w: 4 });
  const gone = shareUnchanged(before, { a: { x: 1 }, b: { y: 2 } });
  expect(gone).toEqual({ a: { x: 1 }, b: { y: 2 } });
  expect(gone.a).toBe(before.a);
  const nulled = shareUnchanged(before, { a: null, b: { y: 2 }, c: { z: 3 } });
  expect(nulled.a).toBeNull();
  expect(nulled.b).toBe(before.b);
  // A list that got shorter is new, its kept items still the same objects.
  const list = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const shorter = shareUnchanged(list, [{ n: 1 }, { n: 2 }]);
  expect(shorter).not.toBe(list);
  expect(shorter[0]).toBe(list[0]);
});
