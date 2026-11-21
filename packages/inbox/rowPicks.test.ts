/**
 * Picking thread rows (rowPicks.ts): a press toggles one row, Shift picks the run between the last press and this one
 * in the order drawn, a box over several picks them all or lets them all go, and each bulk action takes only the
 * picked rows it applies to, by the menus' own rules and the row's machine.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { boxState, bulkTargets, pickAll, pressPick, type PickRules } from './rowPicks';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('pressPick', () => {
  test('a press picks a row, and a second lets it go', () => {
    const one = pressPick(new Set(), 'b', 'toggle', null, order);
    expect([...one]).toEqual(['b']);
    expect([...pressPick(one, 'b', 'toggle', 'b', order)]).toEqual([]);
  });
  test('Shift picks every row between the last press and this one, either way, keeping what was picked', () => {
    expect([...pressPick(new Set(['b']), 'd', 'range', 'b', order)].sort()).toEqual(['b', 'c', 'd']);
    expect([...pressPick(new Set(['e']), 'b', 'range', 'd', order)].sort()).toEqual(['b', 'c', 'd', 'e']);
  });
  test('Shift with nothing pressed before, or a row no longer drawn, picks just the row', () => {
    expect([...pressPick(new Set(), 'c', 'range', null, order)]).toEqual(['c']);
    expect([...pressPick(new Set(), 'c', 'range', 'gone', order)]).toEqual(['c']);
  });
});

test('a box over several rows picks them all, then lets them all go; half picked reads "some"', () => {
  const some = new Set(['a']);
  expect(boxState(['a', 'b'], some)).toBe('some');
  const all = pickAll(some, ['a', 'b']);
  expect(boxState(['a', 'b'], all)).toBe('all');
  expect(boxState(['a', 'b'], pickAll(all, ['a', 'b']))).toBe('none');
  expect(boxState([], new Set())).toBe('none');
});

function row(id: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    subject: id,
    section: 'waiting',
    resolved_at: null,
    read_at: null,
    unseen: 0,
    answered_not_sent: false,
    waiting_on_person: true,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    priority: null,
    snoozed: null,
    sent: null,
    last_author: 'agent',
    ...extra,
  } as InboxListRow;
}

const rules = (over: Partial<PickRules> = {}): PickRules => ({ drawn: (r) => r.section as never, snoozes: () => true, starred: () => false, prioritizes: () => true, ...over });

describe('bulkTargets', () => {
  test('Archive skips a row already archived', () => {
    const rows = [row('a'), row('b', { resolved_at: '2026-11-01T00:00:00.000Z' })];
    expect(bulkTargets(rows, 'archive', rules()).map((r) => r.thread_id)).toEqual(['a']);
  });
  test('Snooze skips a row whose machine keeps no snoozes', () => {
    const rows = [row('a'), row('b', { machine: 'm_old' } as Partial<InboxListRow>)];
    expect(bulkTargets(rows, 'snooze', rules({ snoozes: (r) => !(r as { machine?: string }).machine })).map((r) => r.thread_id)).toEqual(['a']);
  });
  test('Star takes the rows not starred whose machine takes a star; Unstar the starred ones', () => {
    const starred = new Set(['b']);
    const farNoStar = 'c';
    const r = rules({ starred: (x) => (x.thread_id === farNoStar ? null : starred.has(x.thread_id)) });
    const rows = [row('a'), row('b'), row('c')];
    expect(bulkTargets(rows, 'star', r).map((x) => x.thread_id)).toEqual(['a']);
    expect(bulkTargets(rows, 'unstar', r).map((x) => x.thread_id)).toEqual(['b']);
  });
  test('Priority: Add on the rows out of it, Remove on the rows in it, neither where the machine does not take it', () => {
    const rows = [row('a'), row('b', { priority: { at: '2026-11-01T00:00:00.000Z', person: true } as InboxListRow['priority'] }), row('c')];
    const r = rules({ prioritizes: (x) => x.thread_id !== 'c' });
    expect(bulkTargets(rows, 'priority-add', r).map((x) => x.thread_id)).toEqual(['a']);
    expect(bulkTargets(rows, 'priority-remove', r).map((x) => x.thread_id)).toEqual(['b']);
  });
  test('Hide takes only the rows with open PRs not hidden (never an archived one, nor a linked machine\'s, which carries none)', () => {
    const rows = [row('a', { hide_pulls: ['github.com/o/r#1'] }), row('b'), row('c', { hide_pulls: ['github.com/o/r#2'], resolved_at: '2026-11-01T00:00:00.000Z' }), row('d', { hide_pulls: [] })];
    expect(bulkTargets(rows, 'hide-pulls', rules()).map((x) => x.thread_id)).toEqual(['a']);
  });
  test('Mark read only where the row offers it (never Quiet); Mark unread only on a read row an agent wrote last in', () => {
    const quiet = row('q', { section: 'quiet', waiting_on_person: false, questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 } as InboxListRow['questions'] });
    const rows = [row('a'), quiet];
    expect(bulkTargets(rows, 'read', rules()).map((x) => x.thread_id)).toEqual(['a']);
    expect(bulkTargets(rows, 'unread', rules()).map((x) => x.thread_id)).toEqual(['q']);
  });
});
