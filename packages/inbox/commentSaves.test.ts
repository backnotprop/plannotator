/**
 * The comment writes a Send waits for (commentSaves.ts). What regresses: a
 * Send that stops waiting while a comment saved during its wait is still on
 * its way (the reply goes without it); a write that ended before the Send
 * was pressed counted as the Send's; a failed save that the person saved
 * again still stopping the Send; a comment removed or sent during the wait
 * still named by the reply.
 */
import { expect, test } from 'bun:test';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { failedCommentWrite, trackCommentWrite, watchCommentWrites, withCommentWrites } from './commentSaves';

const record = (id: string, change: Partial<InboxAnnotationRecord> = {}): InboxAnnotationRecord => ({
  id,
  project_id: 'prj_1',
  thread_id: 'msg_thread',
  message_id: 'msg_thread',
  attachment_id: '',
  path: 'msg_thread',
  version: 'current',
  message: { at: '2026-11-12T10:00:00.000Z' },
  annotation: { id, type: 'COMMENT', text: id },
  created_at: '2026-11-12T10:00:00.000Z',
  updated_at: '2026-11-12T10:00:00.000Z',
  removed_at: null,
  sent_reply_id: null,
  ...change,
});

/** A write the test answers when it likes. */
function held<T>() {
  let answer: (value: T) => void = () => {};
  let refuse: (cause: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer, refuse };
}

test('settling waits for every write on its way, one started during the wait too, and answers each in the order they ended', async () => {
  const before = held<{ annotation: InboxAnnotationRecord }>();
  void trackCommentWrite(before.promise, { on: 'msg_thread' });
  before.answer({ annotation: record('c0') });
  await before.promise;
  await Promise.resolve();

  const first = held<{ annotation: InboxAnnotationRecord }>();
  void trackCommentWrite(first.promise, { on: 'msg_thread', id: 'c1' });
  const watch = watchCommentWrites();
  let done = false;
  const settled = watch.settled().then((writes) => {
    done = true;
    return writes;
  });
  const second = held<{ annotation: InboxAnnotationRecord }>();
  void trackCommentWrite(second.promise, { on: 'msg_thread', id: 'c2' });
  first.answer({ annotation: record('c1') });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The first answered, the second is still on its way: the wait goes on.
  expect(done).toBe(false);
  second.answer({ annotation: record('c2') });
  const writes = await settled;
  watch.stop();
  // c0 ended before the watch: not this Send's.
  expect(writes.map((w) => (w.kind === 'answered' ? w.record.id : 'failed'))).toEqual(['c1', 'c2']);
});

test('a refused write is reported for its thread only, and not once the same comment saved after it', async () => {
  const watch = watchCommentWrites();
  const refused = held<{ annotation: InboxAnnotationRecord }>();
  void trackCommentWrite(refused.promise, { on: 'msg_thread', id: 'c3' }).catch(() => {});
  refused.refuse(new TypeError('Failed to fetch'));
  const elsewhere = held<{ annotation: InboxAnnotationRecord }>();
  void trackCommentWrite(elsewhere.promise, { on: 'msg_other', id: 'c9' }).catch(() => {});
  elsewhere.refuse(new TypeError('Failed to fetch'));
  const writes = await watch.settled();
  const ours = new Set(['msg_thread']);
  expect(failedCommentWrite(writes, ours)).toMatchObject({ kind: 'failed', on: 'msg_thread', id: 'c3', remove: false });

  const again = held<{ annotation: InboxAnnotationRecord }>();
  void trackCommentWrite(again.promise, { on: 'msg_thread', id: 'c3' });
  again.answer({ annotation: record('c3') });
  expect(failedCommentWrite(await watch.settled(), ours)).toBeNull();
  watch.stop();
});

test("the Send's list takes what the writes answered: a new comment, an edit, a removal; another thread's comment stays out", () => {
  const pressed = [record('c1'), record('c2')];
  const merged = withCommentWrites(
    pressed,
    [
      { kind: 'answered', record: record('c3') },
      { kind: 'answered', record: record('c1', { annotation: { id: 'c1', type: 'COMMENT', text: 'edited' }, updated_at: '2026-11-12T10:05:00.000Z' }) },
      { kind: 'answered', record: record('c2', { removed_at: '2026-11-12T10:06:00.000Z' }) },
      { kind: 'answered', record: record('c8', { thread_id: 'msg_other' }) },
    ],
    'msg_thread',
  );
  expect(merged.map((r) => [r.id, r.annotation.text])).toEqual([
    ['c1', 'edited'],
    ['c3', 'c3'],
  ]);
});
