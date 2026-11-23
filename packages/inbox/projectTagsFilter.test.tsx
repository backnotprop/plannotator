/**
 * Project tags in the list's filter, through the window's own wiring (projectTags.ts): the list as drawn
 * (app/useListView.ts `useListShown`, which App reads) and the Filter's Tag group (components/ListFilter.tsx).
 *
 * The failures this catches: a Tag pick that keeps only the threads tagged themselves (the list's filter reading a
 * row's own tags instead of its own and its project's); a Tag group that offers no row for a tag only a project
 * carries, or counts only the threads tagged themselves; a thread tagged itself in a tagged project counted twice; and
 * the sidebar's own tag list (`#tag=`) taking in a tagged project's threads (it reads own tags only).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server: nothing is fetched.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { ListModel, ProjectFolder } from './api';
import type { MachinesModel } from './machines';
import type { ListTag, ThreadTagsHost } from './threadTags';
import type { Route } from './app/route';

const hasDom = typeof document !== 'undefined';
const { act } = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { useListShown } = (hasDom ? await import('./app/useListView') : {}) as typeof import('./app/useListView');
const { ListFilterButton } = (hasDom ? await import('./components/ListFilter') : {}) as typeof import('./components/ListFilter');
const { ThreadTagsContext } = await import('./threadTags');
const { NO_LIST_FILTER, resetListFilterForTests } = await import('./listFilter');
const { resetScheduledForTests } = await import('./scheduled/store');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const NOW = new Date(2026, 10, 18, 15, 0, 0);
const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const tag = (id: string, name: string): ListTag => ({ id, name, created_at: NOW.toISOString(), created_by: { kind: 'person' }, updated_at: NOW.toISOString(), deleted_at: null }) as ListTag;
const WORK = tag('ini_work', 'Work');
const MACHINES: MachinesModel = { self: SELF, all: [], linked: [], names: new Map(), away: new Set() };

function row(id: string, project: string, tags?: string[]): InboxListRow {
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: `s_${id}`, name: null },
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    section: 'waiting',
    unread: true,
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    ...(tags ? { tags } : {}),
  } as unknown as InboxListRow;
}
const project = (name: string, tags?: string[]) =>
  ({ id: `prj_${name}`, name, key: name, root: `/code/${name}`, created_at: NOW.toISOString(), threads: 2, unread: 0, listed: 2, archived: 0, ...(tags ? { tags } : {}) }) as ProjectFolder;

// billing carries Work (its ⋯ → Add tag); b1 is tagged Work itself too; site's s2 is tagged Work itself.
const ROWS = [row('b1', 'billing', ['ini_work']), row('b2', 'billing'), row('s1', 'site'), row('s2', 'site', ['ini_work'])];
const SECTIONS: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: ROWS } as InboxListSection];
const PROJECTS = [project('billing', ['ini_work']), project('site')];
const LATEST = { sections: SECTIONS, projects: PROJECTS, tags: [WORK] } as unknown as ListModel;

const stored = new Map<string, string>();
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  setSystemTime(NOW);
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  resetListFilterForTests();
  resetScheduledForTests();
});

afterEach(() => {
  setSystemTime();
  if (hasDom) act(() => root?.unmount());
  root = null;
  resetStorageBackend();
  resetListFilterForTests();
  resetScheduledForTests();
  if (hasDom) document.body.innerHTML = '';
});

let shown: ReturnType<typeof useListShown> | null = null;
function ListHarness({ route }: { route: Route }) {
  shown = useListShown({
    latest: LATEST,
    projects: PROJECTS,
    route,
    thread: null,
    threadRow: null,
    rowPatches: new Map(),
    pinPatches: new Map(),
    looking: new Set(),
    shown: SECTIONS,
    machines: MACHINES,
    hideAway: false,
    openedHere: { current: new Set() },
    heldOpen: () => null,
    listSort: { epoch: 0, keep: null },
    heldRead: new Set(),
    tags: { listTags: [WORK], across: null, rowOf: () => undefined, showError: () => {}, showToast: () => {}, dismissToast: () => {}, refreshList: async () => {}, openTag: () => {}, tagGone: () => {} },
  });
  return null;
}

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

/** Base UI opens on the pointer's press, as a person's click does. */
async function openFilter() {
  const funnel = document.querySelector<HTMLElement>('[data-list-filter]')!;
  await act(async () => {
    funnel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    funnel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    funnel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    funnel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    funnel.click();
  });
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

const listed = () => (shown!.listSections ?? []).flatMap((section) => section.threads.map((r) => r.thread_id));

test.skipIf(!hasDom)("the list's Tag pick keeps the threads tagged themselves and every thread of a project carrying the tag", () => {
  mount(<ListHarness route={{ page: 'inbox', project: null, thread: null } as Route} />);
  expect(listed()).toEqual(['b1', 'b2', 's1', 's2']);
  act(() => shown!.setListFilter({ ...NO_LIST_FILTER, tags: [WORK.id] }));
  expect(listed()).toEqual(['b1', 'b2', 's2']);
});

test.skipIf(!hasDom)("the sidebar's tag list (#tag=) stays the threads tagged themselves", () => {
  mount(<ListHarness route={{ page: 'inbox', project: null, thread: null, tag: WORK.id } as Route} />);
  expect(listed()).toEqual(['b1', 's2']);
});

test.skipIf(!hasDom)("the Filter's Tag group offers a tag a project carries and counts its threads, each once", async () => {
  const own = (r: Pick<InboxListRow, 'tags'>) => r.tags ?? [];
  // Only billing's untagged b2 is in Work by its project alone: the own-tags rule would count 2, not 3.
  const filterTags = (r: InboxListRow) => (r.project.id === 'prj_billing' ? [...new Set([...own(r), WORK.id])] : own(r));
  const host: ThreadTagsHost = { tags: [WORK], tagsOf: () => [], counts: new Map(), can: () => true, set: () => {}, createAndSet: () => {}, listed: null, rows: ROWS, rowTags: own, filterTags };
  mount(
    <ThreadTagsContext.Provider value={host}>
      <ListFilterButton phone={false} source={{ rows: ROWS, scoped: false, names: new Map(), filter: NO_LIST_FILTER, onChange: () => {} }} />
    </ThreadTagsContext.Provider>,
  );
  await openFilter();
  const work = document.querySelector<HTMLElement>(`[data-list-filter-tag="${WORK.id}"]`);
  expect(work).not.toBeNull();
  expect(work!.querySelector('.ib-pmi-n')?.textContent).toBe('3');
});

test.skipIf(!hasDom)('a tag only a project carries is offered in the Filter', async () => {
  const rows = [row('b2', 'billing'), row('s1', 'site')];
  const own = (r: Pick<InboxListRow, 'tags'>) => r.tags ?? [];
  const filterTags = (r: InboxListRow) => (r.project.id === 'prj_billing' ? [WORK.id] : own(r));
  const host: ThreadTagsHost = { tags: [WORK], tagsOf: () => [], counts: new Map(), can: () => true, set: () => {}, createAndSet: () => {}, listed: null, rows, rowTags: own, filterTags };
  mount(
    <ThreadTagsContext.Provider value={host}>
      <ListFilterButton phone={false} source={{ rows, scoped: false, names: new Map(), filter: NO_LIST_FILTER, onChange: () => {} }} />
    </ThreadTagsContext.Provider>,
  );
  await openFilter();
  expect(document.querySelector(`[data-list-filter-tag="${WORK.id}"] .ib-pmi-n`)?.textContent).toBe('1');
});
