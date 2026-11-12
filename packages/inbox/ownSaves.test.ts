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

test("an echo is covered only by a read that started after its save's answer, and a later save is not", () => {
  const own = createOwnSaves();
  own.saved([q(4)]);
  expect(own.covered(q(4))).toBe(false);
  own.readsStarted();
  expect(own.covered(q(4))).toBe(true);
  expect(own.covered(q(3))).toBe(true);
  own.saved([q(5)]);
  expect(own.covered(q(5))).toBe(false);
  own.readsStarted();
  expect(own.covered(q(6))).toBe(false);
  expect(own.covered(q(5, { state: 'sent', sent_revision: 5 }))).toBe(false);
});
