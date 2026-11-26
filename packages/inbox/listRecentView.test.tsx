/**
 * Recent activity as a view of the list, not a filter (listRecentView.ts; the bar components/RecentViewBar.tsx; the
 * menu's row components/ListFilter.tsx), through the window's own wiring: app/useListView.ts `useListShown`, which App
 * reads, drawn by the real InboxList with its real filter button.
 *
 * What this catches: the view counted as a filter (the funnel's badge or its "N active" name, the other menu rows'
 * counts moved by it, the folded Snoozed band's count cut by it); a count or a tick on its menu row, the row moved from
 * under Not seen, or the menu left open after it; the view written to the filter's cookie, or a saved `recent: true`
 * from 0.29 opening someone's Inbox stuck in it; the view lost when a thread opens or closes, or kept after leaving the
 * list for another place in the sidebar (or found on again on coming back); Done or Escape not leaving it, Escape
 * leaving it while a thread is still open (the thread closes first), or from a field or a key something else used;
 * a real filter that stops applying, or loses its own badge, under the view; the view's empty words missing, or shown
 * where the filter's own picks left nothing ("No threads match" says that); nothing said to a screen reader.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server: nothing is fetched.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { ListModel, ProjectFolder } from './api';
import type { MachinesModel } from './machines';
import type { Route } from './app/route';

const hasDom = typeof document !== 'undefined';
const { act } = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { useListShown, leaveRecentViewOnEscape } = (hasDom ? await import('./app/useListView') : {}) as typeof import('./app/useListView');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { ListFilterEmpty, RecentViewEmpty, clearedFrom } = (hasDom ? await import('./components/ListFilter') : {}) as typeof import('./components/ListFilter');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { SidebarCustomizer } = (hasDom ? await import('./components/SidebarCustomizer') : {}) as typeof import('./components/SidebarCustomizer');
const { drawnSidebarItems } = await import('./sidebarItems');
const { openSidebarCustomizer, resetSidebarLayoutForTests } = await import('./sidebarLayout');
const { listGroups } = await import('./held');
const { LIST_FILTER_COOKIE, NO_LIST_FILTER, resetListFilterForTests } = await import('./listFilter');
const { resetRecentViewForTests } = await import('./listRecentView');
const { resetActedHereForTests } = await import('./listFilterRecent');
const { resetRecentActsForTests } = await import('./recentActs');
const { resetScheduledForTests } = await import('./scheduled/store');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const NOW = new Date(2026, 10, 26, 15, 0, 0);
const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MACHINES: MachinesModel = { self: SELF, all: [], linked: [], names: new Map(), away: new Set() };
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function row(id: string, project: string, section: string, opts: { acted?: number; unread?: boolean; snoozed?: boolean } = {}): InboxListRow {
  const at = hoursAgo(5);
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: `s_${id}`, name: null },
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    section,
    unread: opts.unread ?? false,
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    ...(opts.acted !== undefined ? { acted_at: hoursAgo(opts.acted) } : {}),
    ...(opts.snoozed ? { snoozed: { until: hoursAgo(-24), at: hoursAgo(2) } } : {}),
  } as unknown as InboxListRow;
}
const project = (name: string) => ({ id: `prj_${name}`, name, key: name, root: `/code/${name}`, created_at: NOW.toISOString(), threads: 2, unread: 0, listed: 2, archived: 0 }) as ProjectFolder;
const PROJECTS = [project('harbor'), project('ledger'), project('fern-api')];

/** Charlie Dunn's reply (ledger) an hour ago, the harbor retry three hours ago, fern-api's never, quill's 40 days ago. */
const ACTED = {
  sections: [
    { id: 'waiting', label: 'Waiting on you', threads: [row('t-fern', 'fern-api', 'waiting', { unread: true }), row('t-harbor', 'harbor', 'waiting', { acted: 3, unread: true })] },
    { id: 'quiet', label: 'Quiet', threads: [row('t-ledger', 'ledger', 'quiet', { acted: 1 }), row('t-old', 'ledger', 'quiet', { acted: 24 * 40 })] },
  ] as InboxListSection[],
  snoozed: [row('t-snoozed', 'harbor', 'quiet', { snoozed: true })],
  projects: PROJECTS,
} as unknown as ListModel;
/** No act of the person's anywhere. */
const UNTOUCHED = {
  sections: [{ id: 'waiting', label: 'Waiting on you', threads: [row('t-fern', 'fern-api', 'waiting', { unread: true }), row('t-harbor', 'harbor', 'waiting')] }] as InboxListSection[],
  snoozed: [],
  projects: PROJECTS,
} as unknown as ListModel;

const stored = new Map<string, string>();
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
let latest: ListModel = ACTED;

beforeEach(() => {
  setSystemTime(NOW);
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  resetListFilterForTests();
  resetRecentViewForTests();
  resetScheduledForTests();
  resetActedHereForTests();
  resetRecentActsForTests();
  latest = ACTED;
});

afterEach(() => {
  setSystemTime();
  if (hasDom) act(() => root?.unmount());
  root = null;
  resetStorageBackend();
  resetListFilterForTests();
  resetRecentViewForTests();
  resetScheduledForTests();
  resetSidebarLayoutForTests();
  if (!hasDom) return;
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

const INBOX = { page: 'inbox', project: null, thread: null } as Route;

/** The list as App draws it: `useListShown`'s sections, sort and filter source, and App's empty words. */
function Harness({ route }: { route: Route }) {
  const s = useListShown({
    latest,
    projects: PROJECTS,
    route,
    thread: null,
    threadRow: null,
    rowPatches: new Map(),
    pinPatches: new Map(),
    looking: new Set(),
    shown: listGroups(latest),
    machines: MACHINES,
    hideAway: false,
    openedHere: { current: new Set() },
    heldOpen: () => null,
    listSort: { epoch: 1, keep: null },
    heldRead: new Set(),
    tags: { listTags: [], across: null, rowOf: () => undefined, showError: () => {}, showToast: () => {}, dismissToast: () => {}, refreshList: async () => {}, openTag: () => {}, tagGone: () => {} },
  });
  return (
    <>
    {/* The Customize sidebar panel, as App draws it: nothing while closed. */}
    <SidebarCustomizer drawn={drawnSidebarItems({ board: false, reviews: false, usage: false, phone: false })} />
    <InboxList
      title={s.listTitle}
      path={null}
      sections={s.listSections ?? []}
      sort={s.listSortShown}
      filtered={false}
      narrow={route.thread !== null}
      phone={false}
      selectedThreadId={route.thread}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      listFilter={{ rows: s.listFilterRows, scoped: s.listFilterScoped, names: s.projectNames, filter: s.listFilterPicks, onChange: s.setListFilter, place: [route.project, route.machine, route.agent, route.tag].join('\n') }}
      empty={s.listHeld ? null : s.recentEmpty ? <RecentViewEmpty /> : s.listFilterEmpty ? <ListFilterEmpty onClear={() => s.setListFilter(clearedFrom(s.listFilterPicks, s.listFilterScoped))} /> : null}
    />
    </>
  );
}

function draw(route: Route = INBOX) {
  if (!root) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <SidebarProvider>
        <Harness route={route} />
      </SidebarProvider>,
    ),
  );
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
/** Base UI opens on the pointer's press, as a person's click does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const funnel = () => $('.ib-lhead [data-list-filter]')!;
const badge = () => funnel().querySelector('[data-list-filter-count]')?.textContent ?? null;
const menu = () => $('[data-list-filter-menu]');
const bar = () => $('[data-recent-view]');
const rowIds = () => [...host!.querySelectorAll('.ib-lbody [data-thread-id]')].map((n) => n.getAttribute('data-thread-id'));
const bands = () => [...host!.querySelectorAll('.ib-lbody .ib-band')].map((n) => n.closest('[data-section-id]')!.getAttribute('data-section-id'));
const bandCount = (id: string) => host!.querySelector(`[data-section-id="${id}"] .ib-n`)?.textContent ?? null;
/** Every menu row's words and count, top to bottom ("Today 3"; a row with no count, its words alone). */
const menuRows = () => [...menu()!.querySelectorAll('.ib-pmi')].map((n) => [n.querySelector('.ib-pmi-l')?.textContent, n.querySelector('.ib-pmi-n')?.textContent].filter(Boolean).join(' '));

async function turnOn() {
  await press(funnel());
  await press($('[data-list-filter-menu] [data-list-filter-recent]')!);
}

describe.skipIf(!hasDom)('Recent activity is a view, not a filter', () => {
  test("its menu row sits under Not seen with no count and no tick; a pick closes the menu and the bar shows; no badge, no cookie, no other count moves", async () => {
    draw();
    await press(funnel());
    const before = menuRows();
    const words = before.map((w) => w.replace(/ \d+$/, ''));
    expect(words.indexOf('Recent activity')).toBe(words.indexOf('Not seen') + 1);
    expect(before).toContain('Recent activity');
    const recentRow = $('[data-list-filter-menu] [data-list-filter-recent]')!;
    expect(recentRow.querySelector('.ib-pmi-n')).toBeNull();
    expect(recentRow.querySelector('.ib-pc-tick svg')).toBeNull();

    await press(recentRow);
    expect(menu()).toBeNull();
    expect(bar()).not.toBeNull();
    // Done names what it leaves, and keeps its visible word in that name (voice control says "Done").
    const doneName = bar()!.querySelector('button[data-recent-view-done]')?.getAttribute('aria-label') ?? '';
    expect(doneName).toContain('Done');
    expect(doneName).toContain('Recent activity');
    // One list, newest act first; the Snoozed band folded under it with its own count (its row was never acted in).
    expect(rowIds()).toEqual(['t-ledger', 't-harbor']);
    expect(bands()).toEqual(['snoozed']);
    expect(bandCount('snoozed')).toBe('1');
    // Not a filter: no badge, the funnel's name and colour at rest, nothing written.
    expect(badge()).toBeNull();
    expect(funnel().getAttribute('aria-label')).toBe('Filter');
    expect(funnel().hasAttribute('data-set')).toBe(false);
    expect(stored.has(LIST_FILTER_COOKIE)).toBe(false);
    // The menu again: every count as it was, the row still with none and no tick.
    await press(funnel());
    expect(menuRows()).toEqual(before);
    expect($('[data-list-filter-menu] [data-list-filter-recent] .ib-pc-tick svg')).toBeNull();
  });

  test("a screen reader hears the bar's words as the view turns on, not again when the list is drawn anew; Done is a real button that leaves it, focus on the funnel", async () => {
    draw();
    expect($('[data-recent-view-said]')?.textContent).toBe('');
    await turnOn();
    expect($('[data-recent-view-said]')?.getAttribute('role')).toBe('status');
    const said = $('[data-recent-view-said]')?.textContent ?? '';
    expect(said).toContain('Recent activity');
    // The list drawn again with the view still on (a full-screen file closed): nothing said again.
    act(() => root!.unmount());
    root = null;
    host?.remove();
    draw();
    expect(bar()).not.toBeNull();
    await settle();
    expect($('[data-recent-view-said]')?.textContent).toBe('');
    await act(async () => $('[data-recent-view-done]')!.click());
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(funnel());
    // The list as it was: its groups, every thread.
    expect(bands()).toEqual(['waiting', 'quiet', 'snoozed']);
    expect(rowIds()).toEqual(['t-fern', 't-harbor']);
    expect(stored.has(LIST_FILTER_COOKIE)).toBe(false);
  });

  test("a saved Recent activity pick from 0.29's cookie is ignored on load: no bar, no badge, the whole list", () => {
    stored.set(LIST_FILTER_COOKIE, JSON.stringify({ projects: [], updated: null, agents: [], pulls: [], notSeen: false, recent: true, tags: [], routines: [] }));
    draw();
    expect(bar()).toBeNull();
    expect(badge()).toBeNull();
    expect(bands()).toEqual(['waiting', 'quiet', 'snoozed']);
    expect(rowIds()).toEqual(['t-fern', 't-harbor']);
  });

  test('a saved real pick beside it still applies, with its own badge', () => {
    stored.set(LIST_FILTER_COOKIE, JSON.stringify({ notSeen: true, recent: true }));
    draw();
    expect(bar()).toBeNull();
    expect(badge()).toBe('1');
    expect(rowIds()).toEqual(['t-fern', 't-harbor']);
  });

  test('it holds while a thread opens and closes; leaving the list for another place ends it, and coming back finds it off', async () => {
    draw();
    await turnOn();
    draw({ ...INBOX, thread: 't-harbor' });
    expect(bar()).not.toBeNull();
    expect(rowIds()).toEqual(['t-ledger', 't-harbor']);
    draw(INBOX);
    expect(bar()).not.toBeNull();
    // A project in the sidebar.
    draw({ ...INBOX, project: 'prj_harbor' });
    expect(bar()).toBeNull();
    draw(INBOX);
    expect(bar()).toBeNull();
    expect(bands()).toEqual(['waiting', 'quiet', 'snoozed']);
    // Another page (Artifacts), then back.
    await turnOn();
    draw({ page: 'artifacts', project: null, thread: null } as Route);
    draw(INBOX);
    expect(bar()).toBeNull();
  });

  test('with a real filter: the view shows the recent threads the filter keeps, and the badge is the filter\'s alone', async () => {
    draw();
    await press(funnel());
    await press($('[data-list-filter-menu] [data-list-filter-not-seen]')!);
    await act(async () => void menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    expect(menu()).toBeNull();
    expect(badge()).toBe('1');
    await turnOn();
    // Not seen keeps fern-api's and harbor's; of those, only harbor's was acted in.
    expect(rowIds()).toEqual(['t-harbor']);
    expect(badge()).toBe('1');
    expect(JSON.parse(stored.get(LIST_FILTER_COOKIE)!)).toEqual({ ...NO_LIST_FILTER, notSeen: true });
    await act(async () => $('[data-recent-view-done]')!.click());
    expect(rowIds()).toEqual(['t-fern', 't-harbor']);
    expect(badge()).toBe('1');
  });

  test("nothing acted in: the view's own words; a real pick that keeps nothing says the filter's words instead", async () => {
    latest = UNTOUCHED;
    draw();
    await turnOn();
    expect($('[data-recent-view-empty]')?.textContent).toBe('Nothing you acted in during the last month.');
    expect($('[data-list-filter-empty]')).toBeNull();
    expect(bar()).not.toBeNull();
    // A Pull request pick no thread has: the filter's own picks left nothing.
    latest = ACTED;
    act(() => resetListFilterForTests());
    stored.set(LIST_FILTER_COOKIE, JSON.stringify({ pulls: ['merged'] }));
    act(() => resetListFilterForTests());
    draw();
    expect($('[data-list-filter-empty]')).not.toBeNull();
    expect($('[data-recent-view-empty]')).toBeNull();
  });
});

describe.skipIf(!hasDom)("Escape: the window's ladder, one layer at a time", () => {
  /** App's window ladder, its last rung: no shortcut of its own. */
  let route: Route = INBOX;
  const rung = (event: KeyboardEvent) => leaveRecentViewOnEscape(event, route);
  beforeEach(() => window.addEventListener('keydown', rung));
  afterEach(() => {
    window.removeEventListener('keydown', rung);
    route = INBOX;
  });
  const escape = async (from: Element) => {
    await act(async () => void from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  };

  test('with a thread open the view stays (the thread closes first); then Escape leaves it', async () => {
    draw();
    await turnOn();
    route = { ...INBOX, thread: 't-harbor' };
    draw(route);
    await escape(document.body);
    expect(bar()).not.toBeNull();
    route = INBOX;
    draw(route);
    await escape(document.body);
    expect(bar()).toBeNull();
  });

  test('not from a field, nor a key something else already used; from Done, focus goes to the funnel', async () => {
    draw();
    await turnOn();
    const field = document.createElement('input');
    document.body.append(field);
    await escape(field);
    expect(bar()).not.toBeNull();
    const used = document.createElement('div');
    used.addEventListener('keydown', (event) => event.preventDefault());
    document.body.append(used);
    await escape(used);
    expect(bar()).not.toBeNull();
    const done = $('[data-recent-view-done]')!;
    done.focus();
    await escape(done);
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(funnel());
  });

  test("from a row (where closing a thread puts focus): focus stays on that thread's row where the groups draw it; a row they fold away hands it to the funnel, never to the page", async () => {
    draw();
    await turnOn();
    const harbor = $('.ib-lbody [data-thread-id="t-harbor"]')!;
    harbor.focus();
    await escape(harbor);
    expect(bar()).toBeNull();
    expect(document.activeElement?.getAttribute('data-thread-id')).toBe('t-harbor');
    await turnOn();
    // Charlie Dunn's ledger thread: in Quiet, folded once the groups are back.
    const ledger = $('.ib-lbody [data-thread-id="t-ledger"]')!;
    ledger.focus();
    await escape(ledger);
    expect(bar()).toBeNull();
    expect(rowIds()).not.toContain('t-ledger');
    expect(document.activeElement).toBe(funnel());
  });

  test('an open layer keeps its Escape (the Customize sidebar panel, any dialog), and a held Escape never runs on to the view', async () => {
    draw();
    await turnOn();
    await act(async () => openSidebarCustomizer(null));
    await settle();
    expect($('[data-sidebar-customizer]')).not.toBeNull();
    // The person clicked a row in the list: focus is outside the panel.
    const harbor = $('.ib-lbody [data-thread-id="t-harbor"]')!;
    harbor.focus();
    await escape(harbor);
    expect($('[data-sidebar-customizer]')).toBeNull();
    expect(bar()).not.toBeNull();
    // Any open dialog, not only the panel.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    await escape(harbor);
    expect(bar()).not.toBeNull();
    dialog.remove();
    // Escape held down (it closed a thread on its first press): its repeats leave nothing.
    await act(async () => void harbor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
    expect(bar()).not.toBeNull();
    await escape(harbor);
    expect(bar()).toBeNull();
  });

  test('only a layer that shows keeps Escape: search\'s <dialog> kept mounted closed (with its listbox), a menu hidden by its style, a floating reply window with focus outside it never do', async () => {
    draw();
    await turnOn();
    // Search after its first ⌘K: App keeps the palette mounted, and closing it only closes the <dialog>.
    const palette = document.createElement('dialog');
    palette.setAttribute('role', 'dialog');
    const results = document.createElement('div');
    results.setAttribute('role', 'listbox');
    palette.append(results);
    document.body.append(palette);
    const harbor = $('.ib-lbody [data-thread-id="t-harbor"]')!;
    harbor.focus();
    // Open, it keeps its Escape.
    palette.setAttribute('open', '');
    await escape(harbor);
    expect(bar()).not.toBeNull();
    palette.removeAttribute('open');
    // A menu drawn but hidden by its style, and a floating reply window (non-modal, long-lived) the focus is not in.
    const menuHidden = document.createElement('div');
    menuHidden.setAttribute('role', 'menu');
    menuHidden.style.display = 'none';
    const floater = document.createElement('aside');
    floater.setAttribute('data-chat-window', '');
    floater.setAttribute('data-popover-layer', '');
    document.body.append(menuHidden, floater);
    await escape(harbor);
    expect(bar() === null).toBe(true);
  });
});
