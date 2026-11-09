/**
 * Which question records only echo this window's own saves (ownSaves.ts).
 * Failures to catch: news taken for an echo, so the open thread is not read
 * again and shows a stale question (another window's newer answer, a Send
 * that marked it sent without raising its revision, a question this window
 * never saved); and an echo taken for news, which reads the thread and its
 * files again for each key typed.
 */
import { expect, test } from 'bun:test';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { createOwnSaves } from './ownSaves';

const q = (revision: number, over: Record<string, unknown> = {}) =>
  ({ message_id: 'msg_a', key: 'q-1', revision, sent_revision: 0, state: 'picked', answer: { selected: [], other: 'abc' }, ...over }) as unknown as InboxQuestion;

test("the record of a save's own answer, and an older one of the same question, are echoes", () => {
  const own = createOwnSaves();
  own.saved([q(4)]);
  expect(own.explains(q(4))).toBe(true);
  expect(own.explains(q(3, { answer: { selected: [], other: 'ab' } }))).toBe(true);
});

test('a newer revision, or the same one changed (a Send marks it sent without raising it), is news', () => {
  const own = createOwnSaves();
  own.saved([q(4)]);
  expect(own.explains(q(5))).toBe(false);
  expect(own.explains(q(4, { sent_revision: 4, state: 'sent' }))).toBe(false);
});

test('a question this window never saved, or a record with no revision, is news', () => {
  const own = createOwnSaves();
  own.saved([q(4)]);
  expect(own.explains(q(1, { key: 'q-2' }))).toBe(false);
  expect(own.explains(q(1, { message_id: 'msg_b' }))).toBe(false);
  expect(own.explains(undefined)).toBe(false);
  expect(own.explains({ message_id: 'msg_a', key: 'q-1' } as unknown as InboxQuestion)).toBe(false);
});

test("a slow answer of an earlier save never takes the newer one's place", () => {
  const own = createOwnSaves();
  own.saved([q(6)]);
  own.saved([q(5, { answer: { selected: [], other: 'abcd' } })]);
  expect(own.explains(q(6))).toBe(true);
  expect(own.explains(q(7))).toBe(false);
});
