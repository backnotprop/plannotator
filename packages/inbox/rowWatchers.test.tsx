/**
 * What a list's rows hold while they wait: a list mounts every row of its open groups (about 2,200 on a large Inbox,
 * the memory soak's store), so anything one row subscribes to or sets up is paid 2,200 times from the moment the
 * window opens, whether or not the person uses the feature behind it. Values the same for every row are read once by
 * the list (rowParts.tsx `ListRows`). What would regress: a per-row watcher coming back (the count growing with the
 * rows), or a row not following a change made after the list drew.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { adoptSavedRows, listLookWatchersForTests, resetListLookForTests } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  const stored = new Map<string, string>();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  // Nothing here asks the server; a stray request answers empty rather than reaching a network.
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => resetListLookForTests());
});

const ROWS = 60;

function listRow(n: number, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: `thr_${n}`,
    project_id: 'prj_billing',
    subject: `Fix the totals ${n}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${n % 3}`, name: null },
    created_at: '2026-11-07T10:00:00.000Z',
    last_at: '2026-11-07T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_billing', name: 'billing-svc' },
    thread_name: null,
    section: 'new',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  } as InboxListRow;
}

const none = () => {};

function mount(rows: InboxListRow[] = Array.from({ length: ROWS }, (_, i) => listRow(i))): HTMLElement {
  const sections: InboxListSection[] = [{ id: 'new', label: 'New', threads: rows }];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={none} onOpen={none} phone={false} onRowAction={none} />
      </SidebarProvider>,
    ),
  );
  return host;
}

const rowEls = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-thread-id]')];

test.skipIf(!hasDom)('the rows read the Rows look once for the list; letter marks turned on after it drew show on every row', () => {
  const before = listLookWatchersForTests();
  const el = mount();
  expect(rowEls(el).length).toBe(ROWS);
  // The list's own few watchers, whatever its length (each row had four: its title's, avatar's, project's and icon's).
  expect(listLookWatchersForTests() - before).toBeLessThanOrEqual(3);
  expect(el.querySelectorAll('.ib-lm-tt, .ib-lm-rowp, .ib-lm-av').length).toBe(0);
  // Settings → Rows, after the list drew: Inline marks for threads and projects.
  act(() => adoptSavedRows(['smallNames', 'marksThreads', 'marksProjects', 'markInline'], 1));
  expect(rowEls(el).filter((row) => row.querySelector('.ib-lm-tt[data-take="inline"]') && row.querySelector('.ib-lm-rowp')).length).toBe(ROWS);
  // Then Avatar: every row swaps to the avatar, none keeps the title's tile.
  act(() => adoptSavedRows(['smallNames', 'marksThreads', 'marksProjects'], 2));
  expect(rowEls(el).filter((row) => row.querySelector('.ib-lm-av') && !row.querySelector('.ib-lm-tt')).length).toBe(ROWS);
});
