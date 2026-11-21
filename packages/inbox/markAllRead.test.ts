/**
 * Mark all as read on the list (markAllRead.ts): the ⋮ takes every row the list shows that single Mark read is
 * offered on, the "New since you looked" band only its own; neither ever takes a snoozed row (the project menu's
 * rule). The toast's words after the count are the project menu's (projectMenu.ts `batchReadDetail`).
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { bandMarkAllRows, listMarkAllRows } from './markAllRead';
import { batchReadDetail } from './projectMenu';

const NO_QUESTIONS = { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 };

function row(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    subject: id,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: 'Claude Code' },
    created_at: '2026-11-20T07:00:00.000Z',
    last_at: '2026-11-20T07:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: NO_QUESTIONS,
    waiting_on_person: true,
    project: { id: 'prj_a', name: 'alpha' },
    thread_name: null,
    section: 'new',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 1,
    sent: null,
    guide: false,
    priority: null,
    ...over,
  } as InboxListRow;
}

const waiting = (id: string, over: Partial<InboxListRow> = {}) => row(id, { section: 'waiting', questions: { ...NO_QUESTIONS, open: 1 }, unseen: 0, ...over });
const ids = (rows: readonly InboxListRow[]) => rows.map((r) => r.thread_id);
const SNOOZED = { until: '2099-01-01T00:00:00.000Z', at: '2026-11-20T06:00:00.000Z' } as InboxListRow['snoozed'];

const SECTIONS: InboxListSection[] = [
  { id: 'waiting', label: 'Waiting on you', threads: [waiting('w1'), waiting('w2', { snoozed: SNOOZED })] },
  { id: 'new', label: 'New since you looked', threads: [row('n1'), row('n2', { snoozed: SNOOZED }), row('n3')] },
  { id: 'sent', label: 'Sent', threads: [row('s1', { section: 'sent', unseen: 0, unread: false, waiting_on_person: false })] },
  { id: 'quiet', label: 'Quiet', threads: [row('q1', { section: 'quiet', unseen: 0, unread: false, waiting_on_person: false })] },
  { id: 'snoozed', label: 'Snoozed', threads: [row('z1', { snoozed: SNOOZED })] },
];

describe('the list ⋮: every row the list shows that takes Mark read', () => {
  test('waiting and new rows, in the order drawn; never a snoozed, Sent or Quiet row', () => {
    expect(ids(listMarkAllRows(SECTIONS))).toEqual(['w1', 'n1', 'n3']);
  });

  test('a filtered list (one project) takes only its rows', () => {
    const other = row('b1', { project: { id: 'prj_b', name: 'beta' } });
    const all: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: [row('a1'), other] }];
    const filtered: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: all[0]!.threads.filter((r) => r.project.id === 'prj_a') }];
    expect(ids(listMarkAllRows(all))).toEqual(['a1', 'b1']);
    expect(ids(listMarkAllRows(filtered))).toEqual(['a1']);
  });

  test('a thread drawn twice (Priority and its own group) is taken once; an archived row is not taken', () => {
    const twice = waiting('p1', { priority: { at: '2026-11-20T06:00:00.000Z' } } as Partial<InboxListRow>);
    const sections: InboxListSection[] = [
      { id: 'priority', label: 'Priority', threads: [twice] },
      { id: 'waiting', label: 'Waiting on you', threads: [twice, waiting('a1', { resolved_at: '2026-11-20T06:30:00.000Z' })] },
    ];
    expect(ids(listMarkAllRows(sections))).toEqual(['p1']);
  });

  test('nothing to do: an empty list, or only Sent and Quiet rows', () => {
    expect(listMarkAllRows([])).toEqual([]);
    expect(listMarkAllRows(SECTIONS.filter((s) => s.id === 'sent' || s.id === 'quiet'))).toEqual([]);
  });
});

describe('the New band: only its own rows', () => {
  test('the band’s rows, never another group’s, never a snoozed one', () => {
    expect(ids(bandMarkAllRows(SECTIONS))).toEqual(['n1', 'n3']);
  });

  test('a seen update the list still holds in New is taken there (its Mark read is still offered)', () => {
    const held = row('h1', { section: 'quiet', unseen: 0, unread: false, waiting_on_person: false });
    expect(ids(bandMarkAllRows([{ id: 'new', label: 'New since you looked', threads: [held] }]))).toEqual(['h1']);
    // The same row in Quiet is not.
    expect(listMarkAllRows([{ id: 'quiet', label: 'Quiet', threads: [held] }])).toEqual([]);
  });

  test('no New band: nothing', () => {
    expect(bandMarkAllRows(SECTIONS.filter((s) => s.id !== 'new'))).toEqual([]);
  });
});

describe('the toast’s words after "Marked N threads read"', () => {
  test('the questions closed; a stopped agent before them; none when nothing was waiting', () => {
    expect(batchReadDetail([waiting('a', { questions: { ...NO_QUESTIONS, open: 2 } }), waiting('b', { questions: { ...NO_QUESTIONS, open: 1 } })])).toBe('Closed 3 questions');
    expect(batchReadDetail([waiting('a', { questions: { ...NO_QUESTIONS, open: 1, stopped: true } })])).toBe('Claude Code was stopped');
    expect(batchReadDetail([row('a'), row('b')])).toBe('');
  });
});
