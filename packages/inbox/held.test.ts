/**
 * The held list: only agent activity the person has not seen raises "N new".
 * If the person's own picks or replies counted, every action would raise a
 * notice; if a new agent message did not, the list would move under them.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { heldNotice } from './held';

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
