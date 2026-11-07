/**
 * The List view's rows (listView.ts `flatRows`) and the remembered choice.
 *
 * What this catches: List hiding a thread the grouped view shows (Quiet, Sent) or showing a snoozed one outside its
 * band; List not newest first; a row that moves in List while the groups hold it still (its time changed in place:
 * the person's Send in the open thread, Mark read's note, an agent's message held behind "N new"); a sort that never
 * comes (Show, a close) or that moves the open thread beside a refresh; and a choice that is not remembered, or that
 * leaves a cookie behind for Grouped.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection, InboxListGroupId } from '@plannotator/core/inbox-types';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { listGroups, refreshHeldRows, settleOwn } from './held';
import { flatRows, LIST_VIEW_COOKIE, readListView, resetListViewForTests, writeListView, type ListPlaces } from './listView';

function row(id: string, last_at: string, section: InboxListRow['section'], extra: Partial<InboxListRow> = {}): InboxListRow {
  return { thread_id: id, project: { id: 'prj_a', name: 'a' }, last_at, last_agent_at: last_at, last_author: 'agent', sent: null, section, ...extra } as InboxListRow;
}

const T = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, '0')}:00Z`;

function groups(byGroup: Partial<Record<InboxListGroupId, InboxListRow[]>>): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: byGroup[id] ?? [] })) as InboxListSection[];
}

const ids = (rows: { row: InboxListRow }[]) => rows.map(({ row }) => row.thread_id);

const LIST = groups({
  stopped: [row('stop', T(1), 'stopped')],
  waiting: [row('wait', T(9), 'waiting')],
  new: [row('new2', T(8), 'new'), row('new1', T(3), 'new')],
  sent: [row('sent', T(7), 'sent', { last_author: 'person' })],
  quiet: [row('q2', T(6), 'quiet'), row('q1', T(2), 'quiet')],
  snoozed: [row('zz', T(5), 'new', { snoozed: { until: '2026-11-06T09:00:00Z', at: T(4) } } as Partial<InboxListRow>)],
});

describe('flatRows', () => {
  test('every thread the groups show, Quiet and Sent included, once each and newest first; the snoozed stay in their band', () => {
    const { rows } = flatRows(LIST, null, { epoch: 0, keep: null });
    expect(ids(rows)).toEqual(['wait', 'new2', 'sent', 'q2', 'new1', 'q1', 'stop']);
    const grouped = LIST.filter((s) => s.id !== 'snoozed').flatMap((s) => s.threads.map((r) => r.thread_id));
    expect([...ids(rows)].sort()).toEqual([...grouped].sort());
    // Each row keeps the group it is drawn in: its actions (Mark read, the row menu) read that.
    expect(rows.find(({ row }) => row.thread_id === 'q2')!.drawn).toBe('quiet');
  });

  test('a time changed in place moves nothing until the list is sorted whole; then it sorts', () => {
    const first = flatRows(LIST, null, { epoch: 1, keep: null });
    // The person replies in the open "q1" (its row shows its state in place, Mark read's note does the same).
    const inPlace = LIST.map((s) => ({ ...s, threads: s.threads.map((r) => (r.thread_id === 'q1' ? { ...r, last_at: T(30) } : r)) }));
    const held = flatRows(inPlace, first.places, { epoch: 1, keep: null });
    expect(ids(held.rows)).toEqual(ids(first.rows));
    // Show, a close, a refresh: the list is sorted whole.
    expect(ids(flatRows(inPlace, held.places, { epoch: 2, keep: null }).rows)[0]).toBe('q1');
  });

  test('agent news held behind "N new" moves no row in List either', () => {
    const shown = listGroups({ sections: LIST.filter((s) => s.id !== 'snoozed'), snoozed: [] });
    const first = flatRows(shown, null, { epoch: 1, keep: null });
    // An agent writes again in the oldest row and starts a new thread: the held list keeps both out.
    const latest = listGroups({
      sections: groups({ ...Object.fromEntries(shown.map((s) => [s.id, s.threads])), new: [row('fresh', T(40), 'new'), row('stop', T(41), 'new'), ...shown.find((s) => s.id === 'new')!.threads] }).filter((s) => s.id !== 'snoozed'),
      snoozed: [],
    });
    const heldList = refreshHeldRows(shown, latest);
    expect(ids(flatRows(heldList, first.places, { epoch: 1, keep: null }).rows)).toEqual(ids(first.rows));
  });

  test('beside a refresh the open thread keeps its place; the rest sort', () => {
    const first = flatRows(LIST, null, { epoch: 1, keep: null });
    const bumped = LIST.map((s) => ({ ...s, threads: s.threads.map((r) => (r.thread_id === 'q1' || r.thread_id === 'stop' ? { ...r, last_at: T(30) } : r)) }));
    const after = ids(flatRows(bumped, first.places, { epoch: 2, keep: 'q1' }).rows);
    expect(after[0]).toBe('stop');
    expect(after.at(-1)).toBe('q1');
  });

  test('a row that settles into another group alone takes its place by its time; the others hold', () => {
    const shown = LIST.filter((s) => s.id !== 'snoozed');
    const first = flatRows(shown, null, { epoch: 1, keep: null });
    // "new1" got the person's Send in place (held), then "q1" alone moves to New with a newer time.
    const moved = shown.map((s) => ({
      ...s,
      threads:
        s.id === 'quiet'
          ? s.threads.filter((r) => r.thread_id !== 'q1')
          : s.id === 'new'
            ? [row('q1', T(50), 'new'), ...s.threads.map((r) => (r.thread_id === 'new1' ? { ...r, last_at: T(45) } : r))]
            : s.threads,
    }));
    const after = ids(flatRows(moved, first.places, { epoch: 1, keep: null }).rows);
    expect(after[0]).toBe('q1');
    expect(after.slice(1)).toEqual(ids(first.rows).filter((id) => id !== 'q1'));
  });

  test('a close settles List as it settles the groups: newest first again', () => {
    const shown = LIST.filter((s) => s.id !== 'snoozed');
    const first = flatRows(shown, null, { epoch: 1, keep: null });
    const latest = shown.map((s) => ({ ...s, threads: s.threads.map((r) => (r.thread_id === 'new1' ? { ...r, last_at: T(55), last_author: 'person' as const, sent: { at: T(55), checked_at: null } } : r)) }));
    const settled = settleOwn(shown, latest);
    const places: ListPlaces = first.places;
    expect(ids(flatRows(settled, places, { epoch: 2, keep: null }).rows)[0]).toBe('new1');
  });
});

describe('the remembered choice', () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    setStorageBackend({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value), removeItem: (key) => void stored.delete(key) });
    resetListViewForTests();
  });
  afterEach(() => {
    resetStorageBackend();
    resetListViewForTests();
  });

  test('an untouched browser is Grouped and carries no cookie', () => {
    expect(readListView()).toBe('grouped');
    expect(stored.size).toBe(0);
  });

  test('List is remembered for the next load; Grouped leaves no cookie behind; only "list" counts', () => {
    writeListView('list');
    expect(stored.get(LIST_VIEW_COOKIE)).toBe('list');
    expect(readListView()).toBe('list');
    writeListView('grouped');
    expect(stored.has(LIST_VIEW_COOKIE)).toBe(false);
    stored.set(LIST_VIEW_COOKIE, 'List');
    expect(readListView()).toBe('grouped');
  });
});
