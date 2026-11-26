/**
 * Mark all as read and Archive all on the list (markAllRead.ts): the ⋮ takes every row the list shows that single Mark
 * read is offered on, a band's menu only that band's rows; none ever takes a snoozed row (the project menu's rule). A
 * band offers only the items that have something to take, and no menu at all when neither has. What each writes is
 * each thread as it is now (`currentMarkAllRows`, `currentArchiveAllRows`): a thread whose news waits behind
 * "N new · Show" is left out and stays as it is.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { bandArchiveAllRows, bandMarkAllRows, bandMenuActions, currentArchiveAllRows, currentMarkAllRows, listMarkAllRows } from './markAllRead';

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

const band = (id: InboxListSection['id']) => SECTIONS.find((s) => s.id === id)!;

describe('a band’s menu: only that band’s rows', () => {
  test('Mark all as read: the band’s rows, never another group’s, never a snoozed one', () => {
    expect(ids(bandMarkAllRows(band('new')))).toEqual(['n1', 'n3']);
    expect(ids(bandMarkAllRows(band('waiting')))).toEqual(['w1']);
  });

  test('a seen update the list still holds in New is taken there (its Mark read is still offered)', () => {
    const held = row('h1', { section: 'quiet', unseen: 0, unread: false, waiting_on_person: false });
    expect(ids(bandMarkAllRows({ id: 'new', label: 'New since you looked', threads: [held] }))).toEqual(['h1']);
    // The same row in Quiet is not.
    expect(bandMarkAllRows({ id: 'quiet', label: 'Quiet', threads: [held] })).toEqual([]);
  });

  test('Archive all: every row of the band not archived and not snoozed; a thread back from the archive is taken', () => {
    const back = row('b1', { resolved_at: '2026-11-20T06:00:00.000Z', back_from_archive: true } as Partial<InboxListRow>);
    const gone = row('g1', { resolved_at: '2026-11-20T06:00:00.000Z' });
    expect(ids(bandArchiveAllRows({ id: 'new', label: 'New since you looked', threads: [row('n1'), back, gone, row('n2', { snoozed: SNOOZED })] }))).toEqual(['n1', 'b1']);
    expect(ids(bandArchiveAllRows(band('quiet')))).toEqual(['q1']);
  });

  test('the items each band offers: Quiet and Sent only Archive all; Snoozed nothing, so no menu; Re-ask all only on a band of open questions', () => {
    expect(bandMenuActions(band('new'))).toEqual(['read', 'archive']);
    expect(bandMenuActions(band('waiting'))).toEqual(['read', 'archive', 'reask']);
    expect(bandMenuActions(band('quiet'))).toEqual(['archive']);
    expect(bandMenuActions(band('sent'))).toEqual(['archive']);
    expect(bandMenuActions(band('snoozed'))).toEqual([]);
  });
});

describe('what it writes: each thread as it is now', () => {
  const T2 = '2026-11-20T07:05:00.000Z';
  const now = (rows: InboxListRow[]) => (id: string) => rows.find((r) => r.thread_id === id);
  const inNew = () => 'new' as const;

  test('a thread whose agent asked a question since the list was drawn is left out; one with no news is written as it is now', () => {
    const drawn = [row('asked'), row('plain')];
    const plainNow = row('plain', { subject: 'renamed elsewhere' });
    const latest = [row('asked', { section: 'waiting', last_at: T2, last_agent_at: T2, unseen: 2, questions: { ...NO_QUESTIONS, open: 1 } }), plainNow];
    expect(currentMarkAllRows(drawn, now(latest), inNew)).toEqual([plainNow]);
  });

  test('left out too: a thread gone from the list, snoozed since, or read elsewhere', () => {
    const drawn = [row('gone'), row('snoozed'), row('readElsewhere')];
    const latest = [row('snoozed', { snoozed: SNOOZED }), row('readElsewhere', { section: 'quiet', unread: false, unseen: 0, waiting_on_person: false, read_at: '2026-11-20T07:02:00.000Z' } as Partial<InboxListRow>)];
    expect(currentMarkAllRows(drawn, now(latest), inNew)).toEqual([]);
  });

  test('Archive all: a thread whose agent asked since is left out (never archived unseen); one archived or snoozed since too', () => {
    const drawn = [row('asked'), row('plain'), row('archived'), row('snoozed')];
    const plainNow = row('plain', { subject: 'renamed elsewhere' });
    const latest = [
      row('asked', { section: 'waiting', last_at: T2, last_agent_at: T2, unseen: 2, questions: { ...NO_QUESTIONS, open: 1 } }),
      plainNow,
      row('archived', { resolved_at: T2 }),
      row('snoozed', { snoozed: SNOOZED }),
    ];
    expect(currentArchiveAllRows(drawn, now(latest))).toEqual([plainNow]);
  });
});
