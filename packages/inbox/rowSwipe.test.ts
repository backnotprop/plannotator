/**
 * The rules of a thread row's swipe on a touch screen (rowSwipe.ts): when a
 * move is a swipe and not a scroll, which touches are the browser's, where
 * the row is drawn under the finger, what a release does (rest open on the
 * button, run the action on a long swipe or a flick, or close), and which
 * actions a row's swipes offer (the hover action's and the row menu's rules).
 * The gesture in a list is rowSwipeList.test.tsx; real touch is
 * tests/e2e/inbox-row-swipe.spec.ts.
 */
import { expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import {
  SWIPE_DECIDE_PX,
  SWIPE_ROW_COMMIT_MAX_PX,
  SWIPE_ROW_COMMIT_MIN_PX,
  SWIPE_ROW_EDGE_PX,
  SWIPE_ROW_FLICK_SPEED,
  SWIPE_ROW_REVEAL_PX,
  VelocityTracker,
  commitDistance,
  lockSwipe,
  releaseOutcome,
  rowSwipeActions,
  startsAtEdge,
  swipeOffset,
} from './rowSwipe';

const BOTH = { lead: 'read', trail: 'archive' } as const;
const PHONE = 390;

test('a move is decided only past the slop, and only a mostly sideways one is a swipe', () => {
  expect(lockSwipe(SWIPE_DECIDE_PX - 1, 3)).toBe('wait');
  expect(lockSwipe(3, SWIPE_DECIDE_PX - 1)).toBe('wait');
  expect(lockSwipe(14, 4)).toBe('swipe');
  expect(lockSwipe(-14, 4)).toBe('swipe');
  // A vertical drag, or a diagonal one, is the list's scroll.
  expect(lockSwipe(2, 14)).toBe('scroll');
  expect(lockSwipe(12, 10)).toBe('scroll');
  expect(lockSwipe(-12, -10)).toBe('scroll');
});

test("a touch at the screen's side is the browser's back or forward swipe", () => {
  expect(startsAtEdge(SWIPE_ROW_EDGE_PX - 1, PHONE)).toBe(true);
  expect(startsAtEdge(PHONE - SWIPE_ROW_EDGE_PX + 1, PHONE)).toBe(true);
  expect(startsAtEdge(SWIPE_ROW_EDGE_PX + 1, PHONE)).toBe(false);
  expect(startsAtEdge(PHONE / 2, PHONE)).toBe(false);
});

test("the commit distance is half the row, kept between the phone's and a wide row's", () => {
  expect(commitDistance(PHONE)).toBe(PHONE / 2);
  expect(commitDistance(200)).toBe(SWIPE_ROW_COMMIT_MIN_PX);
  expect(commitDistance(1000)).toBe(SWIPE_ROW_COMMIT_MAX_PX);
});

test('the row follows the finger 1:1 up to the commit distance, then resists, and never runs off', () => {
  expect(swipeOffset(80, PHONE, BOTH)).toBe(80);
  expect(swipeOffset(-150, PHONE, BOTH)).toBe(-150);
  const commit = commitDistance(PHONE);
  const past = swipeOffset(commit + 100, PHONE, BOTH);
  expect(past).toBeGreaterThan(commit);
  expect(past).toBeLessThan(commit + 100);
  expect(Math.abs(swipeOffset(-5000, PHONE, BOTH))).toBeLessThan(PHONE);
  // A side with no action only resists, a little.
  const none = swipeOffset(200, PHONE, { lead: null, trail: 'archive' });
  expect(none).toBeGreaterThan(0);
  expect(none).toBeLessThan(40);
});

test('a short slow swipe rests open on the button; shorter, or moving back, closes', () => {
  expect(releaseOutcome(-70, 0, PHONE, BOTH)).toBe('reveal-trail');
  expect(releaseOutcome(70, 0, PHONE, BOTH)).toBe('reveal-lead');
  expect(releaseOutcome(-SWIPE_ROW_REVEAL_PX, 0, PHONE, BOTH)).toBe('reveal-trail');
  expect(releaseOutcome(-30, 0, PHONE, BOTH)).toBe('close');
  // Let go while sliding back toward rest: it closes.
  expect(releaseOutcome(-90, 0.4, PHONE, BOTH)).toBe('close');
  expect(releaseOutcome(90, -0.4, PHONE, BOTH)).toBe('close');
});

test('a long swipe runs the action, at any speed', () => {
  const commit = commitDistance(PHONE);
  expect(releaseOutcome(-commit, 0, PHONE, BOTH)).toBe('commit-trail');
  expect(releaseOutcome(commit + 1, 0, PHONE, BOTH)).toBe('commit-lead');
  // Even released slowly moving back.
  expect(releaseOutcome(-(commit + 20), 0.2, PHONE, BOTH)).toBe('commit-trail');
});

test('a flick toward the action runs it from a short distance; a flick the other way does not', () => {
  expect(releaseOutcome(-50, -SWIPE_ROW_FLICK_SPEED, PHONE, BOTH)).toBe('commit-trail');
  expect(releaseOutcome(50, SWIPE_ROW_FLICK_SPEED, PHONE, BOTH)).toBe('commit-lead');
  // Too short to be a flick: a tap's jitter is never an action.
  expect(releaseOutcome(-20, -2, PHONE, BOTH)).toBe('close');
  // Slower than a flick: it rests open.
  expect(releaseOutcome(-70, -(SWIPE_ROW_FLICK_SPEED - 0.1), PHONE, BOTH)).toBe('reveal-trail');
  // Flicked back toward rest from open: it closes.
  expect(releaseOutcome(-60, 1.2, PHONE, BOTH)).toBe('close');
});

test('a side with no action never runs or rests open', () => {
  expect(releaseOutcome(300, 2, PHONE, { lead: null, trail: 'archive' })).toBe('close');
  expect(releaseOutcome(-300, -2, PHONE, { lead: 'read', trail: null })).toBe('close');
  expect(releaseOutcome(0, 3, PHONE, BOTH)).toBe('close');
});

test("the finger's speed is its last moments', and a finger that stopped before lifting flicks nothing", () => {
  const tracker = new VelocityTracker();
  tracker.reset(0, 0);
  for (let t = 10; t <= 300; t += 10) tracker.add(t < 200 ? t * 0.1 : 20 + (t - 200) * 1, t);
  // The last 80 ms moved 1 px/ms; the slow start is forgotten.
  expect(tracker.velocity(300)).toBeCloseTo(1, 1);
  // Held still for longer than that before the lift: no speed.
  expect(tracker.velocity(400)).toBe(0);
});

function row(over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: 'msg_1',
    project_id: 'prj_1',
    subject: 'Thread',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'plannotator' },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  } as InboxListRow;
}

const CAN = { markRead: true, markUnread: true };

test("a row's swipes are its hover action (right) and the row menu's Archive (left)", () => {
  // Waits on the person: Mark read (Quiet) and Archive.
  expect(rowSwipeActions(row(), 'waiting', CAN)).toEqual({ lead: 'read', trail: 'archive' });
  // Read, an agent wrote last: Mark unread, as the hover action.
  const read = row({ section: 'quiet', unread: false, waiting_on_person: false, questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null } });
  expect(rowSwipeActions(read, 'quiet', CAN)).toEqual({ lead: 'mark-unread', trail: 'archive' });
  // A seen update the list still holds in New: Mark unread there too (the hover action's choice).
  expect(rowSwipeActions(read, 'new', CAN).lead).toBe('mark-unread');
  // A snoozed row offers what its hover action does.
  expect(rowSwipeActions(row({ snoozed: { until: '2099-01-01T00:00:00.000Z', at: '2026-10-10T10:00:00.000Z' } } as Partial<InboxListRow>), 'snoozed', CAN)).toEqual({ lead: 'read', trail: 'archive' });
  // Archived and shown in place: nothing to swipe.
  expect(rowSwipeActions(row({ resolved_at: '2026-10-10T12:00:00.000Z' }), 'waiting', CAN)).toEqual({ lead: null, trail: null });
  // A list without Mark read or Mark unread: Archive alone.
  expect(rowSwipeActions(row(), 'waiting', { markRead: false, markUnread: false })).toEqual({ lead: null, trail: 'archive' });
});
