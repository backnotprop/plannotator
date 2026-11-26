/**
 * Recent activity holds while the person works in the list (approval "inbox-recent-activity-filter"; listFilterRecent.ts
 * `useRecentActivity`, the hook useListView.ts gives InboxList): the drawn list with the pick on, a row opened, the
 * opening look's list read, a thread coming into the filter from elsewhere, then the close's whole sort.
 *
 * What this catches: the row the person opened jumping to the top while it is open (its open is an act, and the
 * look's read brings its new time and a new group); a thread acted in elsewhere (the phone, a search open) drawn at
 * once at the top, pushing every row down under the pointer; either not coming to the top when the list settles; on a
 * covered list (a phone, a stacked window), the thread just read not coming to the top at Back. Each row's time with the
 * pick on being its newest message's instead of the act the list is sorted by (the times then read out of order), or
 * the act's with it off. A key typed in the reply box counted as the person choosing the thread an agent opens next.
 * The same steps through the window against the compiled binary: tests/e2e/inbox-recent-activity-filter.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { TidyController } from './components/Tidy';
import type { ListSort } from './listView';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { resetListViewForTests } = await import('./listView');
const { NO_LIST_FILTER, filterListSections } = await import('./listFilter');
const { useRecentActivity, resetActedHereForTests } = await import('./listFilterRecent');
const { recentViewSections } = await import('./listRecentView');
const { personOpened, resetRecentActsForTests, routeChanged, useRecentActs } = await import('./recentActs');
const { shortTime } = await import('./format');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  resetListViewForTests();
  resetActedHereForTests();
  resetRecentActsForTests();
});

afterEach(() => {
  resetStorageBackend();
  resetListViewForTests();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** Each row's newest message: three days back, so its time never reads as one of the acts' (minutes ago). */
const LAST = ago(3 * 24 * 60);

function row(id: string, section: InboxListGroupId, acted?: string): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'billing-svc' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' },
    last_at: LAST,
    last_agent_at: LAST,
    last_author: 'agent',
    section,
    unread: section !== 'quiet',
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    ...(acted ? { acted_at: acted } : {}),
  } as unknown as InboxListRow;
}

function sections(rows: InboxListRow[]): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: rows.filter((r) => r.section === id) })) as InboxListSection[];
}

/**
 * The list as App draws it with the view on (`on`): the filter, then Recent activity's held rows and places. `open`:
 * the thread open; `covered`: it covers the list (a phone, a stacked window).
 */
function Shown({ listed, sort, open, on = true, covered = false, phone = false }: { listed: InboxListSection[]; sort: ListSort; open: string | null; on?: boolean; covered?: boolean; phone?: boolean }) {
  const recent = useRecentActivity(on, sort, open, () => covered);
  const kept = filterListSections(listed, NO_LIST_FILTER, Date.now());
  const drawn = recent.held ? recentViewSections(listed, kept, recent.held, Date.now()) : kept;
  return (
    <SidebarProvider>
      <InboxList
        title="Inbox"
        path={null}
        sections={drawn}
        sort={recent.sort}
        filtered={false}
        narrow={phone}
        phone={phone}
        selectedThreadId={open}
        notice={null}
        onShowNew={() => {}}
        onOpen={() => {}}
        tidy={TIDY}
      />
    </SidebarProvider>
  );
}

function draw(listed: InboxListSection[], sort: ListSort, open: string | null = null, look: { on?: boolean; covered?: boolean; phone?: boolean } = {}) {
  if (!root) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(<Shown listed={listed} sort={sort} open={open} {...look} />));
}

const rowIds = () => [...host!.querySelectorAll('.ib-lbody [data-thread-id]')].map((node) => node.getAttribute('data-thread-id'));
/** The time each drawn row shows, top to bottom. */
const rowTimes = () => [...host!.querySelectorAll('.ib-lbody [data-thread-id]')].map((node) => node.querySelector('.ib-t')?.textContent ?? null);

describe.skipIf(!hasDom)('Recent activity while the list holds', () => {
  test('the opened row stays put through its look and its read; a thread acted in elsewhere waits; both come to the top when the thread closes', () => {
    // Ada Novak's thread acted in an hour ago, Bob Tully's 40 minutes ago, Charlie Dunn's 20; Dana's never.
    const before = sections([row('ada', 'waiting', ago(60)), row('bob', 'waiting', ago(40)), row('charlie', 'quiet', ago(20)), row('dana', 'new')]);
    draw(before, { epoch: 1, keep: null });
    expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);

    // The person opens Ada's thread: selected, nothing moves.
    draw(before, { epoch: 1, keep: null }, 'ada');
    expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);

    // The opening look's list read: Ada's open is now her newest act and her thread went to Quiet. Meanwhile Dana's
    // thread was acted in on the phone, a minute ago. Still nothing moves, and Dana's is not drawn yet.
    const read = sections([row('ada', 'quiet', ago(0)), row('bob', 'waiting', ago(40)), row('charlie', 'quiet', ago(20)), row('dana', 'new', ago(1))]);
    draw(read, { epoch: 1, keep: null }, 'ada');
    expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);

    // The thread closes and the list settles (a whole sort): newest first by the act, Dana's taken in.
    draw(read, { epoch: 2, keep: null });
    expect(rowIds()).toEqual(['ada', 'dana', 'charlie', 'bob']);
  });

  test('a refresh beside the open thread keeps that row where it was and settles the rest', () => {
    const before = sections([row('ada', 'waiting', ago(60)), row('bob', 'waiting', ago(40))]);
    draw(before, { epoch: 1, keep: null }, 'ada');
    expect(rowIds()).toEqual(['bob', 'ada']);
    const read = sections([row('ada', 'quiet', ago(0)), row('bob', 'waiting', ago(40)), row('charlie', 'new', ago(5))]);
    draw(read, { epoch: 2, keep: 'ada' }, 'ada');
    expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);
  });

  test("each row shows the time of the act it is sorted by, so the times read in order; off, its own time again; a phone's rows the same", () => {
    const listed = sections([row('ada', 'waiting', ago(60)), row('bob', 'sent', ago(40)), row('charlie', 'quiet', ago(20))]);
    for (const phone of [false, true]) {
      draw(listed, { epoch: 1, keep: null }, null, { phone });
      expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);
      expect(rowTimes()).toEqual([ago(20), ago(40), ago(60)].map((at) => shortTime(at)));
      draw(listed, { epoch: 1, keep: null }, null, { phone, on: false });
      // Smart groups again (Quiet folded): every row drawn shows its own time.
      expect(rowTimes().length).toBeGreaterThan(0);
      expect(new Set(rowTimes())).toEqual(new Set([shortTime(LAST)]));
    }
  });

  test('on a covered list (a phone, a stacked window) Back sorts it whole: the thread just read comes to the top as the list shows', () => {
    const before = sections([row('ada', 'waiting', ago(60)), row('bob', 'waiting', ago(40)), row('charlie', 'quiet', ago(20))]);
    draw(before, { epoch: 1, keep: null }, null, { covered: true });
    // The open, where the thread covers the list: App settles the list as it opens (a whole sort), before the look
    // records the open.
    draw(before, { epoch: 2, keep: null }, 'ada', { covered: true });
    expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);
    const read = sections([row('ada', 'quiet', ago(0)), row('bob', 'waiting', ago(40)), row('charlie', 'quiet', ago(20))]);
    draw(read, { epoch: 2, keep: null }, 'ada', { covered: true });
    expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);
    // Back: no settle comes from App here, yet the list shows with the thread just read at the top, at its new time.
    draw(read, { epoch: 2, keep: null }, null, { covered: true });
    expect(rowIds()).toEqual(['ada', 'charlie', 'bob']);
    expect(rowTimes()[0]).toBe(shortTime(ago(0)));
    // Beside the list (a wide window), the close's own settle does it after its beat: nothing moves at the close itself.
    draw(before, { epoch: 3, keep: null }, 'bob');
    draw(read, { epoch: 3, keep: null }, null);
    expect(rowIds()).toEqual(['charlie', 'bob', 'ada']);
  });
});

function Acts() {
  useRecentActs();
  return null;
}

describe.skipIf(!hasDom)("the person's choosing keys", () => {
  test('a key typed in a field never makes the thread an agent opens next a chosen open; Enter, the arrows and J on the list do, and Enter in search', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Acts />));
    const field = (tag: 'textarea' | 'input' | 'button') => {
      const el = document.createElement(tag);
      document.body.append(el);
      return el;
    };
    const press = (target: Element, key: string, extra: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
    let n = 0;
    /** An open lands right after the key: whether it counts as the person's. */
    const opensAfter = (target: Element, key: string, extra: KeyboardEventInit = {}) => {
      resetRecentActsForTests();
      press(target, key, extra);
      const id = `msg_${++n}`;
      routeChanged(Date.now(), id);
      return personOpened(id);
    };
    const reply = field('textarea');
    const search = field('input');
    const rowButton = field('button');
    // Typing in the reply box: letters, J, Space and Enter (a new line) alike; a letter outside any field; ⌘ with Enter.
    expect(opensAfter(reply, 'a')).toBe(false);
    expect(opensAfter(reply, 'j')).toBe(false);
    expect(opensAfter(reply, ' ')).toBe(false);
    expect(opensAfter(reply, 'Enter')).toBe(false);
    expect(opensAfter(search, 'k')).toBe(false);
    expect(opensAfter(document.body, 'x')).toBe(false);
    expect(opensAfter(rowButton, 'Enter', { metaKey: true })).toBe(false);
    // Archive (E, Shift+E) moves to the next thread: being moved there is not choosing it.
    expect(opensAfter(document.body, 'e')).toBe(false);
    expect(opensAfter(document.body, 'E', { shiftKey: true })).toBe(false);
    // The list's keys and the opening ones.
    expect(opensAfter(rowButton, 'Enter')).toBe(true);
    expect(opensAfter(rowButton, ' ')).toBe(true);
    expect(opensAfter(rowButton, 'ArrowDown')).toBe(true);
    expect(opensAfter(document.body, 'j')).toBe(true);
    expect(opensAfter(search, 'Enter')).toBe(true);
  });
});
