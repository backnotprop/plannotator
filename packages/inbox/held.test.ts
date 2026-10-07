/**
 * The held list: only agent activity the person has not seen raises "N new".
 * If the person's own picks or replies counted, every action would raise a
 * notice; if a new agent message did not, the list would move under them.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { heldNotice, refreshHeldRows } from './held';

function row(id: string, project: string, last_at: string, last_author: 'agent' | 'person'): InboxListRow {
  return { thread_id: id, project: { id: `prj_${project}`, name: project }, last_at, last_author } as InboxListRow;
}

const sections = (...rows: InboxListRow[]): InboxListSection[] => [{ id: 'waiting', label: 'Waiting on you', threads: rows }];

describe('heldNotice', () => {
  test('a new thread and a newer agent message count; the person\'s own reply does not', () => {
    const shown = sections(row('a', 'billing-svc', '2026-10-07T10:00:00Z', 'agent'), row('b', 'docs-site', '2026-10-07T10:00:00Z', 'agent'));
    expect(heldNotice(shown, shown)).toEqual({ count: 0, text: null });
    const replied = sections(row('a', 'billing-svc', '2026-10-07T10:05:00Z', 'person'), row('b', 'docs-site', '2026-10-07T10:00:00Z', 'agent'));
    expect(heldNotice(shown, replied).count).toBe(0);
    const fresh = sections(
      row('a', 'billing-svc', '2026-10-07T10:00:00Z', 'agent'),
      row('b', 'docs-site', '2026-10-07T10:06:00Z', 'agent'),
      row('c', 'docs-site', '2026-10-07T10:07:00Z', 'agent'),
    );
    expect(heldNotice(shown, fresh)).toEqual({ count: 2, text: '2 new in docs-site' });
    const across = sections(...fresh[0]!.threads, row('d', 'billing-svc', '2026-10-07T10:08:00Z', 'agent'));
    expect(heldNotice(shown, across)).toEqual({ count: 3, text: '3 new' });
  });
});

describe('refreshHeldRows', () => {
  // The failure this guards: after the person's reply was delivered, the held
  // list kept the row's whole old state, so it said "Saved for <agent>" until
  // a reload while the thread beside it said "Delivered".
  test("a row's own state follows a delivery in place; the order and new agent activity stay held", () => {
    const sentRow = { ...row('a', 'billing-svc', '2026-10-07T10:05:00Z', 'person'), section: 'sent', sent: { at: '2026-10-07T10:05:00Z', checked_at: null } } as InboxListRow;
    const other = { ...row('b', 'docs-site', '2026-10-07T10:00:00Z', 'agent'), section: 'waiting' } as InboxListRow;
    const shown: InboxListSection[] = [
      { id: 'waiting', label: 'Waiting on you', threads: [other] },
      { id: 'sent', label: 'Sent', threads: [sentRow] },
    ];
    const delivered = { ...sentRow, section: 'quiet', sent: { at: sentRow.last_at, checked_at: '2026-10-07T10:06:00Z' } } as InboxListRow;
    const newer = { ...other, last_at: '2026-10-07T10:07:00Z', subject: 'A newer agent message' } as InboxListRow;
    const latest: InboxListSection[] = [
      { id: 'sent', label: 'Sent', threads: [] },
      { id: 'quiet', label: 'Quiet', threads: [newer, delivered] },
    ];

    const next = refreshHeldRows(shown, latest);
    // Same sections, same order on screen.
    expect(next.map((s) => s.id)).toEqual(['waiting', 'sent']);
    expect(next.map((s) => s.threads.map((r) => r.thread_id))).toEqual([['b'], ['a']]);
    // The delivered row shows its state as it now is.
    expect(next[1]!.threads[0]).toBe(delivered);
    // The row with a newer agent message keeps what was on screen, and still counts behind "N new".
    expect(next[0]!.threads[0]).toBe(other);
    expect(heldNotice(next, latest).count).toBe(1);
  });
});
