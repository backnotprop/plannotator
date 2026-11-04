import { expect, test } from 'bun:test';
import type { InboxCardWire, InboxListRow } from '@plannotator/core/inbox-types';
import { initiativePeekModel } from './initiativePeek';

const card = (id: string, column: InboxCardWire['column'], extra: Partial<InboxCardWire> = {}): InboxCardWire =>
  ({
    id,
    title: id,
    column,
    initiative: 'ini_a',
    you: null,
    said: null,
    notes: null,
    threads: [],
    heard_at: '2026-11-04T10:00:00Z',
    ...extra,
  }) as InboxCardWire;

const row = (thread_id: string, last_at: string, section: InboxListRow['section'] = 'quiet'): InboxListRow =>
  ({ thread_id, subject: thread_id, thread_name: null, last_at, section, waiting_on_person: false }) as InboxListRow;

test('cards: waiting on the person first, then In progress; other initiatives and dropped cards stay out; the rest is "+N more"', () => {
  const cards = [
    card('todo', 'todo'),
    card('progress', 'in_progress'),
    card('review-you', 'in_review', { you: 'Pick a take' }),
    card('backlog-waiting', 'backlog', { threads: ['t-wait'] }),
    card('done', 'done'),
    card('dropped', 'dropped'),
    card('other', 'in_progress', { initiative: 'ini_b' }),
  ];
  const rows = new Map([['t-wait', row('t-wait', '2026-11-04T09:00:00Z', 'waiting')]]);
  const model = initiativePeekModel('ini_a', cards, rows);
  expect(model.cards.map((c) => c.id)).toEqual(['review-you', 'backlog-waiting', 'progress', 'todo']);
  expect(model.cards.map((c) => c.you)).toEqual(['Pick a take', 'Waiting on you', null, null]);
  expect(model.moreCards).toBe(1);
});

test('threads: the ones its cards link that the list knows, latest first, the waiting one marked', () => {
  const cards = [card('a', 'in_progress', { threads: ['t-old', 't-new', 't-unknown'] }), card('b', 'todo', { threads: ['t-new'] })];
  const rows = new Map([
    ['t-old', row('t-old', '2026-11-01T09:00:00Z', 'waiting')],
    ['t-new', row('t-new', '2026-11-04T09:00:00Z')],
  ]);
  const model = initiativePeekModel('ini_a', cards, rows);
  expect(model.threads.map((t) => [t.id, t.waiting])).toEqual([
    ['t-new', false],
    ['t-old', true],
  ]);
  expect(model.totals).toEqual({ cards: 2, waiting: 1, threads: 2 });
  expect(model.state).toBe('active');
  const empty = initiativePeekModel('ini_empty', cards, rows);
  expect([empty.cards, empty.threads, empty.state, empty.updated]).toEqual([[], [], 'empty', null]);
  expect(initiativePeekModel('ini_a', [card('shipped', 'done')], rows).state).toBe('done');
});

test('round 7: cards in the Board order with Done last; mentions leave out threads a card of it links and the thread the tag sits in', () => {
  const cards = [card('done', 'done'), card('todo', 'todo', { threads: ['t-linked'] }), card('review', 'in_review'), card('progress', 'in_progress')];
  const rows = new Map(['t-linked', 't-here', 't-1', 't-2', 't-3', 't-4'].map((id, i) => [id, row(id, `2026-11-04T0${i}:00:00Z`)] as const));
  const model = initiativePeekModel('ini_a', cards, rows, new Map(), ['t-linked', 't-here', 't-1', 't-2', 't-3', 't-4', 't-gone'], 't-here');
  expect(model.items.map((c) => c.id)).toEqual(['review', 'progress', 'todo', 'done']);
  expect(model.mentions.map((t) => t.id)).toEqual(['t-1', 't-2', 't-3']);
  expect(model.moreMentions).toBe(1);
});
