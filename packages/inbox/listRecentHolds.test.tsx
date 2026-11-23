/**
 * Recent activity holds while the person works in the list (approval "inbox-recent-activity-filter"; listFilterRecent.ts
 * `useRecentActivity`, the hook useListView.ts gives InboxList): the drawn list with the pick on, a row opened, the
 * opening look's list read, a thread coming into the filter from elsewhere, then the close's whole sort.
 *
 * What this catches: the row the person opened jumping to the top while it is open (its open is an act, and the
 * look's read brings its new time and a new group); a thread acted in elsewhere (the phone, a search open) drawn at
 * once at the top, pushing every row down under the pointer; either not coming to the top when the list settles.
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
const ON = { ...NO_LIST_FILTER, recent: true };

function row(id: string, section: InboxListGroupId, acted?: string): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'billing-svc' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' },
    last_at: ago(90),
    last_agent_at: ago(90),
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

/** The list as App draws it with the pick on: the filter, then Recent activity's held rows and places. */
function Shown({ listed, sort, open }: { listed: InboxListSection[]; sort: ListSort; open: string | null }) {
  const recent = useRecentActivity(true, sort);
  const kept = filterListSections(listed, ON, Date.now());
  const drawn = recent.held ? recent.held(listed, kept, Date.now()) : kept;
  return (
    <SidebarProvider>
      <InboxList
        title="Inbox"
        path={null}
        sections={drawn}
        sort={recent.sort}
        filtered={false}
        narrow={false}
        phone={false}
        selectedThreadId={open}
        notice={null}
        onShowNew={() => {}}
        onOpen={() => {}}
        tidy={TIDY}
      />
    </SidebarProvider>
  );
}

function draw(listed: InboxListSection[], sort: ListSort, open: string | null = null) {
  if (!root) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(<Shown listed={listed} sort={sort} open={open} />));
}

const rowIds = () => [...host!.querySelectorAll('.ib-lbody [data-thread-id]')].map((node) => node.getAttribute('data-thread-id'));

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
});
