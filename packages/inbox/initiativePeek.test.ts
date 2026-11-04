/**
 * The sent `#Shape` preview's lists (approval "board-hashtags", round 8).
 * What regresses: cards out of the Board's order (Done not last), a cancelled
 * card or another initiative's card listed, a wrong "+N more", a column badge
 * for an empty column, or Threads listing a thread a card of it already links
 * or the thread the person is reading, or undercounting the threads the
 * cards read sent ids for but no row.
 */
import { expect, test } from 'bun:test';
import type { InboxCardWire, InboxListRow } from '@plannotator/core/inbox-types';
import { initiativePeekModel, PEEK_ITEMS, PEEK_THREADS } from './initiativePeek';

const card = (id: string, column: InboxCardWire['column'], extra: Partial<InboxCardWire> = {}): InboxCardWire =>
  ({
    id,
    title: id,
    column,
    project_id: 'prj_a',
    initiative: 'ini_a',
    threads: [],
    heard_at: '2026-11-04T10:00:00Z',
    ...extra,
  }) as InboxCardWire;

const row = (thread_id: string, last_at = '2026-11-04T09:00:00Z'): InboxListRow =>
  ({ thread_id, subject: `About ${thread_id}`, thread_name: null, last_at, author: { kind: 'agent', host: 'codex', session: 's', name: null }, addressee: null }) as unknown as InboxListRow;

test('cards: Board order with Done last, the latest heard first in a column; Cancelled and other initiatives left out; one badge per column with cards', () => {
  const cards = [
    card('done', 'done'),
    card('todo', 'todo'),
    card('progress-old', 'in_progress', { heard_at: '2026-11-01T10:00:00Z' }),
    card('progress-new', 'in_progress', { heard_at: '2026-11-03T10:00:00Z' }),
    card('review', 'in_review'),
    card('cancelled', 'dropped'),
    card('other', 'in_review', { initiative: 'ini_b' }),
  ];
  const model = initiativePeekModel('ini_a', cards, new Map(), new Map([['prj_a', 'plannotator']]));
  expect(model.items.map((c) => c.id)).toEqual(['review', 'progress-new', 'progress-old', 'todo', 'done']);
  expect(model.items.map((c) => c.column)).toEqual(['In review', 'In progress', 'In progress', 'Todo', 'Done']);
  expect(model.byColumn.map((c) => [c.column, c.count])).toEqual([
    ['In review', 1],
    ['In progress', 2],
    ['Todo', 1],
    ['Done', 1],
  ]);
  expect([model.cards, model.moreItems, model.projects]).toEqual([5, 0, ['plannotator']]);
});

test('cards past the cap read "+N more"; all done is one Done badge; none is empty', () => {
  const many = Array.from({ length: PEEK_ITEMS + 3 }, (_, i) => card(`c${i}`, 'todo'));
  const capped = initiativePeekModel('ini_a', many, new Map());
  expect([capped.items.length, capped.moreItems]).toEqual([PEEK_ITEMS, 3]);
  const shipped = initiativePeekModel('ini_a', [card('a', 'done'), card('b', 'done')], new Map());
  expect(shipped.byColumn.map((c) => [c.column, c.count])).toEqual([['Done', 2]]);
  const empty = initiativePeekModel('ini_empty', many, new Map());
  expect([empty.cards, empty.items, empty.byColumn, empty.mentions, empty.updated]).toEqual([0, [], [], [], null]);
});

test('threads: the tagged ones latest first, minus those a card of it links and the one being read; the rest "+N more", counted from ids', () => {
  const cards = [card('todo', 'todo', { threads: ['t-linked'] }), card('gone', 'dropped', { threads: ['t-cancelled-card'] })];
  const ids = ['t-linked', 't-here', 't-cancelled-card', 't-1', 't-2', 't-3', 't-4'];
  // The cards read sends a row only for the few the preview lists: t-4 has an id and no row.
  const rows = new Map(['t-linked', 't-here', 't-cancelled-card', 't-1', 't-2', 't-3'].map((id) => [id, row(id)] as const));
  const model = initiativePeekModel('ini_a', cards, rows, new Map(), ids, 't-here');
  // A cancelled card's thread is not "linked": the card is not on the Board.
  expect(model.mentions.map((t) => t.id)).toEqual(['t-cancelled-card', 't-1', 't-2'].slice(0, PEEK_THREADS));
  expect(model.mentions[0]!.title).toBe('About t-cancelled-card');
  expect(model.moreMentions).toBe(2);
  // An older Inbox sends no `initiative_threads`: no threads.
  expect(initiativePeekModel('ini_a', cards, rows).mentions).toEqual([]);
});
