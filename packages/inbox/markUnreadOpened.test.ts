/**
 * Mark unread on an opened thread whose questions still wait (the owner, 2026-11-25: on an opened thread with
 * questions the row's button says Mark unread, like every other opened thread). One rule (markRead.ts
 * `canMarkUnread`) for the row's hover action, the row menu, a phone's swipe and the header's ⋯: they must agree.
 * A thread with questions not opened yet is bold and keeps Mark read; Mark read stays reachable on an opened one.
 * The row and header in the window are markUnread.test.tsx; the store's side is
 * packages/shared/inbox/store-mark-unread.test.ts.
 */
import { expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { canMarkUnread, offersRowMarkRead } from './markRead';
import { rowMenuActions } from './rowMenu';
import { rowSwipeActions } from './rowSwipe';
import { lookedRow } from './held';

const QUESTIONS = { open: 2, picked: 0, stopped: false, holds_up: [], prompt: 'Ship it today?' };

function row(over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: 'msg_1',
    project_id: 'prj_1',
    subject: 'Harbor release questions',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'task-wrangler' },
    created_at: '2026-11-25T10:00:00.000Z',
    last_at: '2026-11-25T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: QUESTIONS,
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'harbor' },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 1,
    sent: null,
    guide: false,
    ...over,
  } as InboxListRow;
}

const CAN = { markRead: true, markUnread: true };

for (const section of ['waiting', 'stopped', 'holding'] as const) {
  test(`${section}: not opened, Mark read; opened, Mark unread on the row, the swipe and the menu, Mark read still in the menu`, () => {
    const unopened = row({ section });
    expect(canMarkUnread(unopened)).toBe(false);
    expect(rowSwipeActions(unopened, section, CAN).lead).toBe('read');
    expect(rowMenuActions(unopened, true, null, section)).toContain('read');
    expect(rowMenuActions(unopened, true, null, section)).not.toContain('mark-unread');

    // Opened: the server's row (seen, not bold), and the row the window draws while its look is on its way.
    for (const opened of [row({ section, unread: false, unseen: 0 }), lookedRow(unopened)]) {
      expect(canMarkUnread(opened)).toBe(true);
      expect(rowSwipeActions(opened, section, CAN).lead).toBe('mark-unread');
      const menu = rowMenuActions(opened, true, null, section);
      expect(menu).toContain('mark-unread');
      // Its questions still wait: Mark read (set them aside) stays offered beside it.
      expect(offersRowMarkRead(opened, section)).toBe(true);
      expect(menu).toContain('read');
    }
  });
}

test('an opened thread the person answered last, or archived, or with picks not sent, takes no Mark unread', () => {
  const opened = { unread: false, unseen: 0 } as const;
  expect(canMarkUnread(row({ ...opened, sent: { at: '2026-11-25T10:05:00.000Z', checked_at: null } as InboxListRow['sent'] }))).toBe(false);
  expect(canMarkUnread(row({ ...opened, resolved_at: '2026-11-25T10:05:00.000Z' }))).toBe(false);
  // Picks not sent keep a row in New bold, opened or not: it waits on the person's Send, with Mark read.
  const picked = lookedRow(row({ section: 'new', answered_not_sent: true }));
  expect(picked.unread).toBe(true);
  expect(canMarkUnread(picked)).toBe(false);
  expect(rowSwipeActions(picked, 'new', CAN).lead).toBe('read');
});
