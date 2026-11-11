/**
 * A record the list takes in place (list.ts), and the list read that left before it (queries/list.ts
 * `takeListRead`). Failures to catch: an archive elsewhere that leaves the row on this list until the next read;
 * a later line of a thread that came back after an archive taking its row away; a slow read that left before the
 * archive putting the row back.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxEvent, ListModel } from '../../api';
import { takeListRead } from '../queries/list';
import { applyListRecord } from './list';

const row = (id: string, over: Partial<InboxListRow> = {}) => ({ thread_id: id, thread_name: null, resolved_at: null, ...over }) as InboxListRow;
const list = (rows: InboxListRow[], snoozed?: InboxListRow[], cursor = 10): ListModel =>
  ({ serverSession: 's1', cursor, sections: [{ id: 'new', label: 'New', threads: rows }], ...(snoozed ? { snoozed } : {}) }) as unknown as ListModel;
const rootLine = (id: string, seq: number, over: Record<string, unknown> = {}) =>
  ({ seq, kind: 'message', id, first: false, message: { id, thread_id: id, resolved_at: null, thread_name: null, author: { kind: 'agent' }, ...over } }) as unknown as InboxEvent;

describe('applyListRecord', () => {
  test('a thread archived elsewhere leaves the list, from its section or the snoozed', () => {
    const held = list([row('a'), row('b')], [row('c')]);
    const next = applyListRecord(held, rootLine('a', 11, { resolved_at: '2026-11-11T10:00:00Z' }))!;
    expect(next.sections[0]!.threads.map((r) => r.thread_id)).toEqual(['b']);
    expect(next.cursor).toBe(11);
    const snoozed = applyListRecord(held, rootLine('c', 12, { resolved_at: '2026-11-11T10:00:00Z' }))!;
    expect(snoozed.snoozed!.map((r) => r.thread_id)).toEqual([]);
  });

  test('a later line of a thread back after an archive (the same archive time) moves nothing', () => {
    const held = list([row('a', { resolved_at: '2026-11-10T09:00:00Z' })]);
    expect(applyListRecord(held, rootLine('a', 11, { resolved_at: '2026-11-10T09:00:00Z' }))).toBeNull();
  });

  test('a rename shows on the row; the same name changes nothing', () => {
    const held = list([row('a'), row('b')]);
    const next = applyListRecord(held, rootLine('a', 11, { thread_name: 'Billing' }))!;
    expect(next.sections[0]!.threads[0]!.thread_name).toBe('Billing');
    expect(next.sections[0]!.threads[1]).toBe(held.sections[0]!.threads[1]);
    expect(applyListRecord(held, rootLine('a', 11))).toBeNull();
  });

  test("what the list cannot take in place waits for the read: a new message, a reply's line, a replay, a thread not listed", () => {
    const held = list([row('a')]);
    expect(applyListRecord(held, { ...rootLine('a', 11, { resolved_at: 'x' }), first: true } as InboxEvent)).toBeNull();
    expect(applyListRecord(held, { seq: 11, kind: 'message', id: 'm2', first: false, message: { id: 'm2', thread_id: 'a', resolved_at: 'x' } } as unknown as InboxEvent)).toBeNull();
    expect(applyListRecord(held, rootLine('a', 10, { resolved_at: 'x' }))).toBeNull();
    expect(applyListRecord(held, rootLine('z', 11, { resolved_at: 'x' }))).toBeNull();
  });

  test('a list read that left before the archive is the older one: the row does not come back', () => {
    const held = applyListRecord(list([row('a'), row('b')]), rootLine('a', 11, { resolved_at: 'x' }))!;
    const slow = list([row('a'), row('b')], undefined, 10);
    expect(takeListRead(held, slow, { session: 's1', cursor: 10 }, { firstDone: true, adopt: false, settings: false })).toBe('older');
    const after = list([row('b')], undefined, 11);
    expect(takeListRead(held, after, { session: 's1', cursor: 10 }, { firstDone: true, adopt: false, settings: false })).not.toBe('older');
  });
});
