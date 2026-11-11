/**
 * When records arrive, the window reads its open thread again only when they
 * can change what it shows (openThreadReads.ts). Failures to catch: a record
 * that changes the open thread's view (its own message, question or
 * annotation; any project record; a frame that cannot be placed) skipped; a
 * thread whose header or files do not come from records alone (on another
 * machine, not read yet, its read failed, its row not in the list, its repo
 * not known yet) left stale; a thread deleted elsewhere left on screen; and,
 * the other way, another thread's records still reading the open one.
 * The records are what a real Inbox sends: `inbox-open-thread-reads.test.ts`
 * (packages/server) checks the map against every write that changes a thread.
 */
import { describe, expect, test } from 'bun:test';
import { INBOX_REPO_TTL_MS, type InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxEvent } from './api';
import { listsThread, newRecordBatch, noteOwnRecord, noteRecord, openThreadRead, type OpenThreadState } from './openThreadReads';

const OPEN = 'msg_OPEN';
const OTHER = 'msg_OTHER';

const message = (threadId: string, id = `${threadId}_m`) => ({ seq: 1, kind: 'message', id, message: { id, thread_id: threadId } }) as unknown as InboxEvent;
const question = (threadId: string | null | undefined) =>
  ({ seq: 2, kind: 'question', id: 'q', ...(threadId === undefined ? {} : { thread_id: threadId }), question: { message_id: 'msg_x', key: 'q-1' } }) as unknown as InboxEvent;
const annotation = (threadId: string) => ({ seq: 3, kind: 'annotation', id: 'a', annotation: { id: 'a', thread_id: threadId, message_id: 'msg_x' } }) as unknown as InboxEvent;
const project = { seq: 4, kind: 'project', id: 'prj_1', project: { id: 'prj_1', name: 'web' } } as unknown as InboxEvent;
const card = { seq: 5, kind: 'card', id: 'crd_1', card: { id: 'crd_1' } } as unknown as InboxEvent;
const unknownKind = { seq: 6, kind: 'reaction', id: 'r_1' } as unknown as InboxEvent;

/** The open thread read, listed, its repo known: the state where another thread's records need no read. */
const settledOpen = (over: Partial<OpenThreadState> = {}): OpenThreadState => ({
  threadId: OPEN,
  remote: false,
  loaded: { thread_id: OPEN, project: { repo: { display: 'acme/web', host: 'github.com' } } },
  loadedAt: 1_000_000,
  now: 1_000_000 + 60_000,
  settled: true,
  listed: true,
  ...over,
});

const readFor = (events: (InboxEvent | null)[], open = settledOpen()) => {
  const batch = newRecordBatch();
  for (const event of events) noteRecord(batch, event);
  return openThreadRead(batch, open);
};

describe('which records read the open thread again', () => {
  test("the open thread's own message, question and annotation read it", () => {
    expect(readFor([message(OPEN)])).toBe('thread');
    expect(readFor([question(OPEN)])).toBe('thread');
    expect(readFor([annotation(OPEN)])).toBe('thread');
  });

  test("another thread's message, question and annotation do not", () => {
    expect(readFor([message(OTHER)])).toBe('none');
    expect(readFor([question(OTHER)])).toBe('none');
    expect(readFor([annotation(OTHER)])).toBe('none');
  });

  test('any project record reads it: a rename, a combine or a new project can change its header', () => {
    expect(readFor([project])).toBe('thread');
    expect(readFor([message(OTHER), project])).toBe('thread');
  });

  test('a record it cannot place reads it: a malformed frame, an owed read with no record, a new kind, a question an older Inbox did not place', () => {
    expect(readFor([null])).toBe('thread');
    expect(readFor([unknownKind])).toBe('thread');
    expect(readFor([card])).toBe('thread');
    expect(readFor([question(undefined)])).toBe('thread');
    expect(readFor([question(null)])).toBe('thread');
    expect(readFor([{ seq: 7, kind: 'message', id: 'm', message: {} } as unknown as InboxEvent])).toBe('thread');
  });

  test('one record of the open thread anywhere in the pause reads it', () => {
    expect(readFor([message(OTHER), question(OTHER), annotation(OPEN), message(OTHER)])).toBe('thread');
  });

  test('a new pause starts empty', () => {
    const batch = newRecordBatch();
    noteRecord(batch, message(OPEN));
    expect(openThreadRead(batch, settledOpen())).toBe('thread');
    expect(openThreadRead(newRecordBatch(), settledOpen())).toBe('none');
  });
});

describe('an open thread whose view does not come from records alone is read on every record, as before', () => {
  const another = [message(OTHER)];

  test('on another machine (its records come in machine frames)', () => {
    expect(readFor(another, settledOpen({ remote: true }))).toBe('thread');
  });

  test('not read yet since it opened, or its last read is of another thread', () => {
    expect(readFor(another, settledOpen({ loaded: null }))).toBe('thread');
    expect(readFor(another, settledOpen({ loaded: { thread_id: OTHER, project: { repo: { display: 'acme/web' } } } }))).toBe('thread');
  });

  test('its last read failed, waits for a machine, or was refused', () => {
    expect(readFor(another, settledOpen({ settled: false }))).toBe('thread');
  });

  test('not in the list (archived): its header reads its own row, which live sessions, snoozes and drafts change with no record', () => {
    expect(readFor(another, settledOpen({ listed: false }))).toBe('thread');
  });

  test("its last read is older than the repo's freshness: a changed git origin reaches its links, as when every record read it", () => {
    expect(readFor(another, settledOpen({ loadedAt: 0, now: INBOX_REPO_TTL_MS + 1 }))).toBe('thread');
    expect(readFor(another, settledOpen({ loadedAt: 0, now: INBOX_REPO_TTL_MS }))).toBe('none');
  });

  test("its project's repo not known yet (the server resolves it off the record path)", () => {
    expect(readFor(another, settledOpen({ loaded: { thread_id: OPEN, project: { repo: null } } }))).toBe('thread');
    expect(readFor(another, settledOpen({ loaded: { thread_id: OPEN, project: {} } }))).toBe('thread');
  });

  test('a project the server resolved to no git origin needs no read: its repo will not come with one', () => {
    expect(readFor(another, settledOpen({ loaded: { thread_id: OPEN, project: { repo: null, repo_known: true } } }))).toBe('none');
  });
});

describe('listsThread: whether the list read has the open thread', () => {
  const row = (threadId: string) => ({ thread_id: threadId }) as InboxListRow;
  const list = (rows: InboxListRow[], snoozed?: InboxListRow[]) => ({ sections: [{ id: 'new', title: 'New', threads: rows }] as never, ...(snoozed ? { snoozed } : {}) });

  test('a row in any section, or among the snoozed, counts', () => {
    expect(listsThread(list([row(OTHER), row(OPEN)]), OPEN)).toBe(true);
    expect(listsThread(list([row(OTHER)], [row(OPEN)]), OPEN)).toBe(true);
  });

  test('gone from the list (deleted elsewhere, archived), or no list read: not listed, so it is read again', () => {
    expect(listsThread(list([row(OTHER)]), OPEN)).toBe(false);
    expect(listsThread(null, OPEN)).toBe(false);
  });
});

describe("the echo of this window's own question save", () => {
  // The failure this guards: each key typed in a question's "Other…" field saves, and the save's record read the
  // open thread and its files again (with the list, the decisions and the drafts), though the pane had drawn the
  // save's answer already: several reads and whole-window renders per key.
  const ownFor = (threadId: string, events: (InboxEvent | null)[] = [], open = settledOpen()) => {
    const batch = newRecordBatch();
    noteOwnRecord(batch, threadId);
    for (const event of events) noteRecord(batch, event);
    return openThreadRead(batch, open);
  };

  test('alone, it reads neither the open thread nor its files', () => {
    expect(ownFor(OPEN)).toBe('none');
  });

  test('with any other record of the open thread, or one no one placed, the thread is read as before', () => {
    expect(ownFor(OPEN, [message(OPEN)])).toBe('thread');
    expect(ownFor(OPEN, [question(OPEN)])).toBe('thread');
    expect(ownFor(OPEN, [null])).toBe('thread');
    expect(ownFor(OPEN, [project])).toBe('thread');
  });

  test("with another thread's record, nothing of the open thread is read", () => {
    expect(ownFor(OPEN, [message(OTHER)])).toBe('none');
  });

  test("a thread whose row only its read brings (not in the list), or another machine's, is read as before", () => {
    expect(ownFor(OPEN, [], settledOpen({ listed: false }))).toBe('thread');
    expect(ownFor(OPEN, [], settledOpen({ remote: true }))).toBe('thread');
  });
});
