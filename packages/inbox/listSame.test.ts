/**
 * Whether a list read shows anything new (listSame.ts). Failures to catch: a
 * read that changed a row, a section, a count or anything else the window
 * draws taken as nothing new (the change would not show until the next one);
 * and the other way, a read with nothing new taken as new, which draws the
 * whole window and the open thread again for each record and each own save.
 */
import { expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { keepSame, sameListModel } from './listSame';

const row = (thread_id: string, over: Record<string, unknown> = {}) => ({ thread_id, subject: `About ${thread_id}`, unseen: 0, last_at: '2026-11-09T10:00:00Z', ...over }) as unknown as InboxListRow;
const model = (rows: InboxListRow[], over: Record<string, unknown> = {}) => ({
  serverSession: 's1',
  version: '0.29.0',
  cursor: 10,
  list_version: 'v.1.1',
  notice: null,
  projects: [{ id: 'prj_1', name: 'web' }],
  sections: [{ id: 'new', label: 'New', threads: rows } as unknown as InboxListSection],
  snoozed: [] as InboxListRow[],
  pins: [] as InboxListRow[],
  session_labels: { ses_1: 'Claude' },
  ...over,
});

test('the same rows, a new read: nothing new, by identity or by content', () => {
  const a = row('a');
  const held = model([a, row('b')]);
  expect(sameListModel(held, model([a, row('b')], { list_version: 'v.1.2' }), { cursor: false })).toBe(true);
});

test('a row that changed, came, left or moved is new', () => {
  const held = model([row('a'), row('b')]);
  expect(sameListModel(held, model([row('a', { unseen: 1 }), row('b')]), { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('a')]), { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('b'), row('a')]), { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('a'), row('b')], { snoozed: [row('c')] }), { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('a'), row('b')], { pins: [row('a')] }), { cursor: false })).toBe(false);
});

test("a section's own fields, and everything else the window draws (projects, labels, the notice), count", () => {
  const held = model([row('a')]);
  const renamed = { ...held, sections: [{ ...held.sections[0]!, label: 'Newer' }] };
  expect(sameListModel(held, renamed, { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('a')], { projects: [{ id: 'prj_1', name: 'site' }] }), { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('a')], { session_labels: { ses_1: 'Codex' } }), { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('a')], { notice: 'Restarted' }), { cursor: false })).toBe(false);
  expect(sameListModel(held, model([row('a')], { update: { latest: '0.30.0' } }), { cursor: false })).toBe(false);
});

test("the agents alone are never new to the list: their own store draws them, and their last poll moves on every read", () => {
  const a = row('a');
  const agents = (seen: string) => [{ agents: [{ id: 'ses_1', session: 'ses_1', state: 'idle', last_seen_at: seen }], total: 1, ended_today: 0 }];
  expect(sameListModel(model([a], { agents: agents('2026-11-09T10:00:00Z') }), model([a], { agents: agents('2026-11-09T10:00:05Z') }), { cursor: false })).toBe(true);
});

test('the cursor alone is new only where it shows (Settings)', () => {
  const held = model([row('a')]);
  const moved = model([row('a')], { cursor: 11 });
  expect(sameListModel(held, moved, { cursor: false })).toBe(true);
  expect(sameListModel(held, moved, { cursor: true })).toBe(false);
});

test('keepSame keeps the value held when the read brought the same, else takes the new one', () => {
  const held = [{ id: 'd1', body: 'hi' }];
  expect(keepSame(held, [{ id: 'd1', body: 'hi' }])).toBe(held);
  const next = [{ id: 'd1', body: 'hi there' }];
  expect(keepSame(held, next)).toBe(next);
});
