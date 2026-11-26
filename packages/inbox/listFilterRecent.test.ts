/**
 * "Recent activity" (approval "inbox-recent-activity-filter"; listFilterRecent.ts, the view in listRecentView.ts, the
 * window's notes in recentActs.ts): which rows it keeps, their order, how it holds and how it goes.
 *
 * What this catches: a row kept with no act of the person's, or past the 30 days, or one dropped inside them; rows not
 * newest first by the act across the groups (or by `last_at` instead), a snoozed row drawn among them; a row that moves
 * under the person before the list settles, or one that stays put after it does; the List view still sorting by
 * `last_at` with the view on, or keeping its order once it is off; a thread that comes into the filter while the list holds drawn at once (pushing the rows down
 * under the pointer) instead of at the next whole sort; a thread counted as opened without the person's gesture (shown on load, opened by an agent, or
 * opened while the browser's user activation lingers after an unrelated click), or not counted with one; a film played without a gesture written, or one written on every play.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { INBOX_SNOOZED_BAND } from '@plannotator/core/inbox-snooze';
import { resetStorageBackend } from '@plannotator/ui/utils/storage';
import { NO_LIST_FILTER, filterListSections, resetListFilterForTests } from './listFilter';
import { recentViewSections } from './listRecentView';
import { RECENT_ACTIVITY_DAYS, actedPlaces, heldRecentRows, noteActedHere, resetActedHereForTests, rowActedAt, rowRecentlyActed } from './listFilterRecent';
import { flatRows } from './listView';
import { gestured, mediaPlayed, personOpened, resetRecentActsForTests, routeChanged } from './recentActs';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function row(id: string, extra: { acted?: string; last?: string } = {}): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_billing', name: 'billing' },
    last_at: extra.last ?? ago(1),
    author: { kind: 'agent', host: 'claude-code', session: `s_${id}`, name: null },
    unread: false,
    ...(extra.acted ? { acted_at: extra.acted } : {}),
  } as unknown as InboxListRow;
}
const section = (id: string, rows: InboxListRow[]): InboxListSection => ({ id, label: id, threads: rows }) as InboxListSection;
const ids = (sections: readonly InboxListSection[]) => sections.map((s) => `${s.id}:${s.threads.map((r) => r.thread_id).join(',')}`);

afterEach(() => {
  resetActedHereForTests();
  resetRecentActsForTests();
  resetStorageBackend();
  resetListFilterForTests();
});

/** The view's rows with nothing held (each row at its time now), as useListView.ts draws them. */
const viewed = (sections: InboxListSection[], kept = sections) => recentViewSections(sections, kept, (listed, k, now) => heldRecentRows(listed, k, actedPlaces(null, null).key, now), NOW);

describe('which rows Recent activity keeps', () => {
  test('only a thread the person acted in within the last 30 days, in every group, the groups kept', () => {
    const sections = [
      section('waiting', [row('charlie', { acted: ago(2) }), row('ada'), row('bob', { acted: ago(24 * (RECENT_ACTIVITY_DAYS + 1)) })]),
      section('quiet', [row('dunn', { acted: ago(24 * (RECENT_ACTIVITY_DAYS - 1)) })]),
    ];
    expect(ids(viewed(sections))).toEqual(['waiting:charlie', 'quiet:dunn']);
  });

  test("within the filter's real picks; the Snoozed band keeps the filter's rows, so its count is never the view's", () => {
    const sections = [
      section('waiting', [row('charlie', { acted: ago(2) }), { ...row('ada', { acted: ago(3) }), unread: true } as InboxListRow, row('bob')]),
      section(INBOX_SNOOZED_BAND.id, [row('snoozed-acted', { acted: ago(1) }), row('snoozed-never')]),
    ];
    // No pick: the view alone. The band keeps both its rows.
    expect(ids(viewed(sections))).toEqual(['waiting:charlie,ada', `${INBOX_SNOOZED_BAND.id}:snoozed-acted,snoozed-never`]);
    // Not seen picked as well: the recent threads it keeps (Ada's), the band as Not seen leaves it.
    const notSeen = filterListSections(sections, { ...NO_LIST_FILTER, notSeen: true }, NOW);
    expect(ids(viewed(sections, notSeen))).toEqual(['waiting:ada', `${INBOX_SNOOZED_BAND.id}:`]);
  });

  test("a film played in this window counts before the list reads it back, and the later time wins", () => {
    expect(rowRecentlyActed(row('ada'), NOW)).toBe(false);
    noteActedHere('ada', ago(1));
    expect(rowRecentlyActed(row('ada'), NOW)).toBe(true);
    expect(rowActedAt(row('ada', { acted: ago(5) }))).toBe(ago(1));
    expect(rowActedAt(row('ada', { acted: ago(0.5) }))).toBe(ago(0.5));
  });

});

describe('the order', () => {
  test('one list newest first by when the person acted, across the groups and never by last_at; the Snoozed band left out', () => {
    // A minute-old act in Quiet comes before a week-old one waiting on the person.
    const sections = [
      section('waiting', [row('charlie', { acted: ago(24 * 7), last: ago(0.1) }), row('bob', { acted: ago(24), last: ago(0.2) })]),
      section('quiet', [row('ada', { acted: ago(1 / 60), last: ago(30) })]),
      section(INBOX_SNOOZED_BAND.id, [row('snoozed', { acted: ago(0) })]),
    ];
    const flat = flatRows(sections, null, { epoch: 1, keep: null, by: actedPlaces(null, null).key });
    expect(flat.rows.map((r) => r.row.thread_id)).toEqual(['ada', 'bob', 'charlie']);
  });

  test('a row keeps its place until the next whole sort; the open thread kept through one keeps it then too', () => {
    const first = actedPlaces(null, null);
    expect(first.key(row('ada', { acted: ago(5) }))).toBe(ago(5));
    // The person acts in it again while the list holds: its place does not move.
    expect(first.key(row('ada', { acted: ago(0) }))).toBe(ago(5));
    // The next whole sort places it by its new time...
    expect(actedPlaces(first.keys, null).key(row('ada', { acted: ago(0) }))).toBe(ago(0));
    // ...unless it is the thread the sort keeps in place.
    expect(actedPlaces(first.keys, 'ada').key(row('ada', { acted: ago(0) }))).toBe(ago(5));
  });

  test('a thread that comes into the view while the list holds waits for the next whole sort; one already in stays', () => {
    const rowsOf = (sections: readonly InboxListSection[]) => sections.flatMap((s) => s.threads.map((r) => r.thread_id));
    const listed = [section('waiting', [row('charlie', { acted: ago(2) }), row('bob')]), section('quiet', [row('ada', { acted: ago(3) })])];
    const first = actedPlaces(null, null);
    const live = (sections: InboxListSection[]) => recentViewSections(sections, sections, (_l, kept) => kept, NOW);
    expect(rowsOf(heldRecentRows(listed, live(listed), first.key, NOW))).toEqual(['charlie', 'ada']);
    // Bob is acted in on the phone, and Ada again: the view's live answer takes Bob in, the held one does not yet.
    const later = [section('waiting', [row('charlie', { acted: ago(2) }), row('bob', { acted: ago(0) })]), section('quiet', [row('ada', { acted: ago(0) })])];
    const now = live(later);
    expect(rowsOf(now)).toEqual(['charlie', 'bob', 'ada']);
    const held = heldRecentRows(later, now, first.key, NOW);
    expect(rowsOf(held)).toEqual(['charlie', 'ada']);
    expect(flatRows(held, null, { epoch: 1, keep: null, by: first.key }).rows.map((r) => r.row.thread_id)).toEqual(['charlie', 'ada']);
    // The next whole sort takes Bob in, every row by its time now.
    const next = actedPlaces(first.keys, null);
    const settled = heldRecentRows(later, now, next.key, NOW);
    expect(flatRows(settled, null, { epoch: 2, keep: null, by: next.key }).rows.map((r) => r.row.thread_id)).toEqual(['ada', 'bob', 'charlie']);
  });

  test('the List view sorts by the acted time while on, and by last_at again once off', () => {
    const sections = [section('waiting', [row('ada', { acted: ago(1), last: ago(40) }), row('bob', { acted: ago(20), last: ago(2) })]), section('quiet', [row('charlie', { acted: ago(3), last: ago(1) })])];
    const by = actedPlaces(null, null).key;
    const onList = flatRows(sections, null, { epoch: 1, keep: null, by });
    expect(onList.rows.map((r) => r.row.thread_id)).toEqual(['ada', 'charlie', 'bob']);
    // Turned off at the same epoch: still a whole sort, by last_at.
    const off = flatRows(sections, onList.places, { epoch: 1, keep: null });
    expect(off.rows.map((r) => r.row.thread_id)).toEqual(['charlie', 'bob', 'ada']);
  });
});

describe("what this window tells the server", () => {
  test('a thread the person moved to is opened by them, once; one shown on load or by an agent is not', () => {
    // Shown with no gesture (a launch link, an agent's open, the page loading on it).
    routeChanged(NOW, 'msg_agent');
    expect(personOpened('msg_agent', NOW + 200)).toBe(false);
    // The person's click, then the route moves.
    gestured(NOW + 1000);
    routeChanged(NOW + 1050, 'msg_chosen');
    expect(personOpened('msg_chosen', NOW + 1500)).toBe(true);
    expect(personOpened('msg_chosen', NOW + 1600)).toBe(false);
    // A gesture long before the route moved is not this open.
    routeChanged(NOW + 9000, 'msg_later');
    expect(personOpened('msg_later', NOW + 9100)).toBe(false);
  });

  test("the browser's user activation alone (about 5 s after any click) never makes an open the person's", () => {
    const before = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true, hasBeenActive: true } });
    try {
      // An unrelated click, then an agent opens a thread 3 s later while the activation still holds.
      gestured(NOW);
      routeChanged(NOW + 3000, 'msg_agent_after_click');
      expect(personOpened('msg_agent_after_click', NOW + 3100)).toBe(false);
      const posted: string[] = [];
      mediaPlayed(NOW + 3000, async (id) => void posted.push(id), 'msg_autoplay');
      expect(posted).toEqual([]);
    } finally {
      if (before) Object.defineProperty(navigator, 'userActivation', before);
      else delete (navigator as { userActivation?: unknown }).userActivation;
    }
  });

  test('a film the person played writes once per thread for a while; a play with no gesture writes nothing', () => {
    const posted: string[] = [];
    const post = async (id: string) => void posted.push(id);
    mediaPlayed(NOW, post, 'msg_film');
    expect(posted).toEqual([]);
    gestured(NOW + 100);
    mediaPlayed(NOW + 150, post, 'msg_film');
    gestured(NOW + 5000);
    mediaPlayed(NOW + 5050, post, 'msg_film');
    expect(posted).toEqual(['msg_film']);
    expect(rowActedAt(row('msg_film'))).toBe(new Date(NOW + 150).toISOString());
  });
});
