/**
 * When a list read owes the window a drafts read (draftsReads.ts, #2593). What
 * this catches: a thread holding unsent work deleted (no record says it) left
 * counted in the sidebar's Drafts; and a linked machine's rows holding unsent
 * work (never in this machine's `replies`) owing a drafts read after every
 * list read, which would put back the read per agent message.
 */
import { expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { draftsReadOwed, replyDraftsDiffer } from './draftsReads';
import { newRecordBatch, noteOwnRecord } from './openThreadReads';

const row = (thread_id: string, unsent: boolean, machine?: string) =>
  ({ thread_id, unsent: unsent ? { picks: 1, comments: 0, reply_at: null } : null, ...(machine ? { machine } : {}) }) as unknown as InboxListRow;
const list = (rows: InboxListRow[], snoozed: InboxListRow[] = [], self?: string) => ({
  sections: [{ id: 'new', label: 'New', threads: rows } as unknown as InboxListSection],
  snoozed,
  ...(self ? { self } : {}),
});

test('the reply drafts shown are the rows holding unsent work (a section or snoozed): nothing owed', () => {
  expect(replyDraftsDiffer([{ thread_id: 'a' }, { thread_id: 's' }], list([row('a', true), row('b', false)], [row('s', true)]))).toBe(false);
  expect(replyDraftsDiffer([], list([row('b', false)]))).toBe(false);
});

test('a thread shown as a reply draft gone from the list, or one more holding work: a read is owed', () => {
  expect(replyDraftsDiffer([{ thread_id: 'a' }, { thread_id: 'gone' }], list([row('a', true)]))).toBe(true);
  expect(replyDraftsDiffer([{ thread_id: 'a' }], list([row('a', true), row('c', true)]))).toBe(true);
});

test("a linked machine's rows never owe a read; this machine's own (`self`) do", () => {
  const merged = list([row('a', true, 'ibx_self'), row('far', true, 'ibx_far')], [], 'ibx_self');
  expect(replyDraftsDiffer([{ thread_id: 'a' }], merged)).toBe(false);
  expect(replyDraftsDiffer([], merged)).toBe(true);
});

test("the echo of this window's own pick save owes the drafts read of a thread holding unsent work, as its record did", () => {
  // A pick is unsent work: the Drafts row counts it. The echo reads no thread, but the drafts still follow it.
  const batch = newRecordBatch();
  noteOwnRecord(batch, 'a');
  expect(draftsReadOwed(batch, ['a'])).toBe(true);
  expect(draftsReadOwed(batch, ['b'])).toBe(false);
});
