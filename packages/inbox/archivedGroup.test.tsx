/**
 * The list's Archived group (approval "inbox-archived-group", option A), on the window's own list and its writes
 * (data/actions/archivedGroup.ts) with the Inbox's answers stood in.
 *
 * What this catches: the group on before the person asks; the ⋮ switch not saved, or not heard from another window;
 * a closed group that reads or holds rows; more or fewer than 20 rows, "Show 20 more" not adding 20, the group going
 * past 100 without pointing to Search; a row drawn with its last message's time instead of when it was archived;
 * Unarchive that leaves the row on screen until the answer, has no Undo, or loses a row whose write was held (an
 * asleep machine); the group ignoring the selected project, the list's filters (its Tag picks too) or the linked machines; a swipe on a
 * phone that takes a rightward or a short one; and the live list's rows drawn again when the group opens or reads.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { TidyController } from './components/Tidy';
import type { ArchivedModel } from './api';
import type { BulkWrites } from './bulkWrites';
import * as format from './format';
import { filterListSections, NO_LIST_FILTER } from './listFilter';
import { withLiveTagPicks } from './listFilterTags';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { useArchivedGroup } = await import('./data/actions/archivedGroup');
const { createInboxQueryClient } = await import('./data/client');
const { inboxApi } = await import('./api');
const { adoptShowArchived, resetShowArchivedForTests } = await import('./showArchived');

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };
const MINI = 'ibx_01K0000000000000000000000M';
const resolvedAt = (n: number) => new Date(Date.UTC(2026, 10, 14, 9, 0, 0) - n * 60_000).toISOString();

function row(id: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_a',
    project: { id: 'prj_a', name: 'billing-svc' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: null },
    created_at: '2026-11-01T10:00:00.000Z',
    last_at: '2026-11-01T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    section: 'quiet',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  } as InboxListRow;
}

const archivedRow = (n: number, extra: Partial<InboxListRow> = {}) => row(`arc_${n}`, { resolved_at: resolvedAt(n), ...extra });
/** The store's archived threads, newest archived first. */
let store: InboxListRow[] = [];
const LIVE: InboxListSection[] = [{ id: 'quiet', label: 'Quiet', threads: [row('live_1'), row('live_2')] }];

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
let asks: { project?: string | null; limit?: number; machines?: boolean }[] = [];
const spies: { mockRestore: () => void }[] = [];
const events: string[] = [];
let toasts: { lead: string; detail: string; onUndo: () => void }[] = [];

beforeEach(() => {
  resetShowArchivedForTests();
  client = createInboxQueryClient();
  asks = [];
  toasts = [];
  events.length = 0;
  store = Array.from({ length: 130 }, (_, i) => archivedRow(i));
  spies.push(
    spyOn(inboxApi, 'archived').mockImplementation(async (input = {}) => {
      asks.push(input);
      const scoped = input.project ? store.filter((r) => r.project?.id === input.project) : store;
      return { serverSession: 's', cursor: 1, project: input.project ?? null, projects: [], total: scoped.length, offset: 0, limit: input.limit ?? 50, threads: scoped.slice(0, input.limit ?? 50) } as ArchivedModel;
    }),
    spyOn(inboxApi, 'saveShowArchived').mockImplementation(async (on) => {
      events.push(`save:${on}`);
      return { show_archived: { on, rev: 5 } };
    }),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  resetShowArchivedForTests();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

interface Opts {
  project?: string | null;
  merged?: boolean;
  phone?: boolean;
  filter?: (rows: readonly InboxListRow[]) => readonly InboxListRow[];
  live?: InboxListSection[];
  onSearch?: () => void;
  /** The list's bulk writes: picking rows (rowPicks.ts) is on. */
  bulk?: BulkWrites;
}
const ALL = (rows: readonly InboxListRow[]) => rows;

function Harness(opts: Opts) {
  const { host: archived } = useArchivedGroup({
    project: opts.project ?? null,
    merged: opts.merged ?? false,
    filter: opts.filter ?? ALL,
    showToast: (toast) => void toasts.push(toast),
    showError: (cause) => void events.push(`error:${(cause as Error).message}`),
    afterWrite: async (ids) => void events.push(`afterWrite:${ids?.join(',')}`),
    archive: async (id) => void events.push(`archive:${id}`),
    go: () => {},
    refreshList: async () => {},
  });
  return (
    <InboxList
      title="Inbox"
      path={null}
      sections={opts.live ?? LIVE}
      sort={{ epoch: 1, keep: null }}
      filtered={false}
      narrow={false}
      phone={opts.phone ?? false}
      selectedThreadId={null}
      notice={null}
      onShowNew={() => {}}
      onOpen={(r) => void events.push(`open:${r.thread_id}`)}
      onRowAction={(r, action) => (action === 'unarchive' ? archived.unarchive(r) : undefined)}
      onSearch={opts.onSearch}
      tidy={TIDY}
      archived={archived}
      bulk={opts.bulk}
    />
  );
}

function render(opts: Opts = {}): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <SidebarProvider>
          <Harness {...opts} />
        </SidebarProvider>
      </QueryClientProvider>,
    );
  });
  return host;
}

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const group = () => document.querySelector<HTMLElement>('[data-archived-group]');
const band = () => group()!.querySelector<HTMLButtonElement>('.ib-band')!;
const groupIds = () => [...group()!.querySelectorAll('[data-thread-id]')].map((el) => el.getAttribute('data-thread-id'));
const archivedQueries = () => client.getQueryCache().findAll({ queryKey: ['inbox', 'archived'] }).length;

async function openMenu(): Promise<HTMLElement> {
  act(() => document.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  return document.querySelector<HTMLElement>('[data-tidy-menu-popup]')!;
}

async function switchOn() {
  adoptShowArchived({ on: true, rev: 1 });
  await settle();
}

async function openGroup() {
  act(() => band().click());
  await settle();
  await settle();
}

test.skipIf(!hasDom)('off by default: no group, and the ⋮ menu offers "Show archived" unticked', async () => {
  render();
  expect(group()).toBeNull();
  const menu = await openMenu();
  const option = menu.querySelector<HTMLElement>('[data-show-archived-option]')!;
  expect(option.textContent).toContain('Show archived');
  expect(option.getAttribute('aria-checked')).toBe('false');
  expect(asks).toEqual([]);
});

test.skipIf(!hasDom)('the ⋮ switch saves, shows the group closed, and another window switching it off takes it away live', async () => {
  render();
  const menu = await openMenu();
  await act(async () => menu.querySelector<HTMLElement>('[data-show-archived-option]')!.click());
  await settle();
  expect(events).toEqual(['save:true']);
  expect(group()).not.toBeNull();
  expect(band().getAttribute('aria-expanded')).toBe('false');
  expect(band().textContent).toBe('Archived');
  // Under Snoozed and every other group: the list's last.
  expect(document.querySelector('.ib-lbody .ib-group:last-of-type')).toBe(group());
  adoptShowArchived({ on: false, rev: 6 });
  await settle();
  expect(group()).toBeNull();
});

test.skipIf(!hasDom)('closed, the group reads nothing and holds nothing; open, 20 rows; closed again, its rows leave memory', async () => {
  render();
  await switchOn();
  expect(asks).toEqual([]);
  expect(archivedQueries()).toBe(0);
  await openGroup();
  expect(asks).toEqual([{ project: null, limit: 21, machines: false }]);
  expect(groupIds()).toEqual(Array.from({ length: 20 }, (_, i) => `arc_${i}`));
  act(() => band().click());
  await settle();
  expect(groupIds()).toEqual([]);
  expect(archivedQueries()).toBe(0);
});

test.skipIf(!hasDom)('"Show 20 more" adds 20 at a time up to 100, then the group points to Search', async () => {
  let searched = 0;
  render({ onSearch: () => void searched++ });
  await switchOn();
  await openGroup();
  for (const shown of [40, 60, 80, 100]) {
    const more = group()!.querySelector<HTMLButtonElement>('[data-archived-more]')!;
    expect(more.textContent).toBe('Show 20 more');
    act(() => more.click());
    await settle();
    await settle();
    expect(groupIds().length).toBe(shown);
  }
  expect(asks.map((a) => a.limit)).toEqual([21, 41, 61, 81, 101]);
  expect(group()!.querySelector('[data-archived-more]')).toBeNull();
  const past = group()!.querySelector<HTMLElement>('[data-archived-past]')!;
  expect(past.textContent).toBe('Older ones are in Search.');
  act(() => past.querySelector<HTMLButtonElement>('button')!.click());
  expect(searched).toBe(1);
});

test.skipIf(!hasDom)('fewer than 20 archived: no "Show 20 more"; none: "Nothing archived."', async () => {
  store = store.slice(0, 5);
  render();
  await switchOn();
  await openGroup();
  expect(groupIds().length).toBe(5);
  expect(group()!.querySelector('[data-archived-more]')).toBeNull();
  expect(group()!.querySelector('[data-archived-past]')).toBeNull();
  store = [];
  act(() => band().click());
  await openGroup();
  expect(group()!.querySelector('[data-archived-none]')!.textContent).toBe('Nothing archived.');
});

test.skipIf(!hasDom)('a thread archived while the group is open comes in at its top', async () => {
  const listRead = (ids: string[]) => ({ cursor: 1, sections: [{ id: 'quiet', label: 'Quiet', threads: ids.map((id) => row(id)) }] });
  client.setQueryData(['inbox', 'list'], listRead(['live_1', 'live_2']));
  render();
  await switchOn();
  await openGroup();
  expect(asks.length).toBe(1);
  store = [archivedRow(-1, { thread_id: 'live_2' } as Partial<InboxListRow>), ...store];
  await act(async () => void client.setQueryData(['inbox', 'list'], listRead(['live_1'])));
  await settle();
  await settle();
  expect(asks.length).toBe(2);
  expect(groupIds()[0]).toBe('live_2');
  // A read whose threads did not change reads nothing.
  await act(async () => void client.setQueryData(['inbox', 'list'], listRead(['live_1'])));
  await settle();
  expect(asks.length).toBe(2);
});

test.skipIf(!hasDom)('each row shows when it was archived, not its last message', async () => {
  render();
  await switchOn();
  const shortTime = spyOn(format, 'shortTime');
  try {
    await openGroup();
    const drawn = shortTime.mock.calls.map((call) => call[0]);
    expect(drawn).toContain(resolvedAt(0));
    expect(drawn).not.toContain('2026-11-01T10:00:00.000Z');
    // The header says Archived; the rows do not say it again.
    expect(group()!.querySelector('[data-thread-id]')!.textContent).not.toContain('Archived');
  } finally {
    shortTime.mockRestore();
  }
});

test.skipIf(!hasDom)('Unarchive from the row takes it out at once, and the toast\'s Undo archives it again', async () => {
  let answer: (() => void) | null = null;
  spies.push(spyOn(inboxApi, 'resolve').mockImplementation((id, resolved) => {
    events.push(`resolve:${id}:${resolved}`);
    return new Promise((resolve) => (answer = () => resolve({ ok: true } as never)));
  }));
  render();
  await switchOn();
  await openGroup();
  const button = group()!.querySelector<HTMLButtonElement>('[data-row="arc_0"] [data-row-unarchive], [data-row-unarchive]')!;
  expect(button.getAttribute('aria-label')).toBe('Unarchive: Thread arc_0');
  act(() => button.click());
  await settle();
  // Before the Inbox answers.
  expect(groupIds()[0]).toBe('arc_1');
  expect(events).toContain('resolve:arc_0:false');
  await act(async () => answer!());
  await settle();
  expect(events).toContain('afterWrite:arc_0');
  expect(toasts.map((t) => [t.lead, t.detail])).toEqual([['Back in your Inbox', '“Thread arc_0”']]);
  toasts[0]!.onUndo();
  expect(events).toContain('archive:arc_0');
});

test.skipIf(!hasDom)('after Unarchive, keyboard focus goes to the next row, and to the header after the last one', async () => {
  spies.push(spyOn(inboxApi, 'resolve').mockImplementation(async () => ({ ok: true }) as never));
  store = store.slice(0, 2);
  render();
  await switchOn();
  await openGroup();
  const unarchive = (id: string) => {
    const button = group()!.querySelector<HTMLElement>(`[data-row="${id}"] [data-row-unarchive]`)!;
    act(() => button.focus());
    act(() => button.click());
  };
  unarchive('arc_0');
  await settle();
  expect(document.activeElement?.getAttribute('data-thread-id')).toBe('arc_1');
  unarchive('arc_1');
  await settle();
  expect(document.activeElement).toBe(band());
});

test.skipIf(!hasDom)("with machines linked, this Inbox's rows draw before a slow machine answers", async () => {
  const far = archivedRow(-1, { thread_id: 'far_1', machine: MINI } as Partial<InboxListRow>);
  let answer: (() => void) | null = null;
  spies.push(spyOn(inboxApi, 'archived').mockImplementation((input = {}) => {
    const page = (threads: InboxListRow[]) => ({ serverSession: 's', cursor: 1, project: null, projects: [], total: threads.length, offset: 0, limit: 21, threads }) as ArchivedModel;
    if (!input.machines) return Promise.resolve(page(store.slice(0, 3)));
    return new Promise((resolve) => (answer = () => resolve(page([far, ...store.slice(0, 3)]))));
  }));
  store = store.slice(0, 3);
  render({ merged: true });
  await switchOn();
  await openGroup();
  expect(groupIds()).toEqual(['arc_0', 'arc_1', 'arc_2']);
  await act(async () => answer!());
  await settle();
  expect(groupIds()).toEqual(['far_1', 'arc_0', 'arc_1', 'arc_2']);
});

test.skipIf(!hasDom)('a project on a slow machine: no "Nothing archived." before that machine answers', async () => {
  let answer: (() => void) | null = null;
  spies.push(spyOn(inboxApi, 'archived').mockImplementation((input = {}) => {
    const page = (threads: InboxListRow[]) => ({ serverSession: 's', cursor: 1, project: 'prj_far', projects: [], total: threads.length, offset: 0, limit: 21, threads }) as ArchivedModel;
    if (!input.machines) return Promise.resolve(page([]));
    return new Promise((resolve) => (answer = () => resolve(page([archivedRow(0, { machine: MINI } as Partial<InboxListRow>)]))));
  }));
  render({ merged: true, project: 'prj_far' });
  await switchOn();
  await openGroup();
  expect(group()!.querySelector('[data-archived-none]')).toBeNull();
  await act(async () => answer!());
  await settle();
  expect(groupIds()).toEqual(['arc_0']);
});

test.skipIf(!hasDom)("an archived row's menu offers Unarchive (and no Mark read); a held write (machine asleep) puts the row back and says why", async () => {
  spies.push(spyOn(inboxApi, 'resolve').mockImplementation(async () => {
    throw new Error('Waiting for Mini: this applies when Mini is back.');
  }));
  store = [archivedRow(0, { machine: MINI } as Partial<InboxListRow>), archivedRow(1)];
  render({ merged: true });
  await switchOn();
  await openGroup();
  expect(asks).toContainEqual({ project: null, limit: 21, machines: true });
  const target = group()!.querySelector<HTMLElement>('[data-thread-id="arc_0"]')!;
  await act(async () => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 }));
  });
  const menu = document.querySelector<HTMLElement>('[data-row-menu="arc_0"]')!;
  const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());
  expect(labels).toContain('Unarchive');
  expect(labels.some((label) => label?.startsWith('Mark'))).toBe(false);
  await act(async () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === 'Unarchive')!.click());
  await settle();
  expect(groupIds()).toEqual(['arc_0', 'arc_1']);
  expect(events).toContain('error:Waiting for Mini: this applies when Mini is back.');
  expect(toasts).toEqual([]);
});

test.skipIf(!hasDom)("the group follows the selected project, and the list's filters", async () => {
  store = Array.from({ length: 60 }, (_, i) => archivedRow(i, i % 2 ? { project: { id: 'prj_b', name: 'web' } } : {}));
  render({ project: 'prj_b' });
  await switchOn();
  await openGroup();
  expect(asks[0]).toEqual({ project: 'prj_b', limit: 21, machines: false });
  expect(groupIds().every((id) => Number(id!.slice(4)) % 2 === 1)).toBe(true);

  act(() => band().click());
  asks = [];
  // A filter that drops rows: the group reads up to its most, and still shows 20 that pass.
  render({ project: null, filter: (rows) => rows.filter((r) => Number(r.thread_id.slice(4)) % 3 === 0) });
  await openGroup();
  await settle();
  expect(asks.at(-1)!.limit).toBe(101);
  expect(groupIds().length).toBe(20);
  expect(groupIds().every((id) => Number(id!.slice(4)) % 3 === 0)).toBe(true);
});

test.skipIf(!hasDom)("the list's Tag filter applies to the group: an untagged archived row drops out when a tag is picked", async () => {
  // Thread tags step 2: App's filter for the group (App.tsx `archivedFilter`), the list's picks read against the live tags.
  const release = { id: 'ini_release', name: 'Release', created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: null } as const;
  store = Array.from({ length: 30 }, (_, i) => archivedRow(i, i % 2 ? { tags: ['ini_release'] } : {}));
  const picks = withLiveTagPicks({ ...NO_LIST_FILTER, tags: ['ini_release'] }, [release]);
  const byTag = (rows: readonly InboxListRow[]) => filterListSections([{ id: 'archived', label: 'Archived', threads: [...rows] } as InboxListSection], picks, Date.now(), undefined, (r) => r.tags ?? [])[0]?.threads ?? rows;
  render({ filter: byTag });
  await switchOn();
  await openGroup();
  await settle();
  expect(groupIds().length).toBeGreaterThan(0);
  expect(groupIds().every((id) => Number(id!.slice(4)) % 2 === 1)).toBe(true);
  // No tag picked: every archived row, tagged or not.
  act(() => band().click());
  render({ filter: (rows) => filterListSections([{ id: 'archived', label: 'Archived', threads: [...rows] } as InboxListSection], NO_LIST_FILTER, Date.now(), undefined, (r) => r.tags ?? [])[0]?.threads ?? rows });
  await openGroup();
  await settle();
  expect(groupIds().some((id) => Number(id!.slice(4)) % 2 === 0)).toBe(true);
});

test.skipIf(!hasDom)('on a phone a swipe to the left unarchives; rightward and short ones do nothing, and open nothing', async () => {
  spies.push(spyOn(inboxApi, 'resolve').mockImplementation(async (id) => void events.push(`resolve:${id}`) as never));
  render({ phone: true });
  await switchOn();
  await openGroup();
  const swipe = (id: string, dx: number) => {
    const el = group()!.querySelector<HTMLElement>(`[data-swipe-row="${id}"]`)!;
    const at = (type: string, x: number) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: 50 }));
    act(() => {
      at('pointerdown', 200);
      for (let x = 200; dx < 0 ? x >= 200 + dx : x <= 200 + dx; x += dx < 0 ? -10 : 10) at('pointermove', x);
      at('pointerup', 200 + dx);
    });
  };
  swipe('arc_1', 120);
  swipe('arc_1', -40);
  await settle();
  expect(events.filter((e) => e.startsWith('resolve'))).toEqual([]);
  swipe('arc_1', -140);
  await settle();
  expect(events).toContain('resolve:arc_1');
  expect(groupIds()).not.toContain('arc_1');
  expect(events.filter((e) => e.startsWith('open'))).toEqual([]);
});

test.skipIf(!hasDom)("opening the group and its reads draw no live row again", async () => {
  render();
  await switchOn();
  const shortTime = spyOn(format, 'shortTime');
  try {
    await openGroup();
    expect(shortTime.mock.calls.length).toBe(20);
    shortTime.mockClear();
    // A list read with the same content (new objects) while the group is open.
    render({ live: JSON.parse(JSON.stringify(LIVE)) });
    await settle();
    expect(shortTime.mock.calls.length).toBe(0);
  } finally {
    shortTime.mockRestore();
  }
});

test.skipIf(!hasDom)('picking: an archived row is picked with a live one, Combine is offered for both, and Archive takes only the live one', async () => {
  const archivedBy: string[][] = [];
  const bulk = {
    archive: async (rows: InboxListRow[]) => void archivedBy.push(rows.map((r) => r.thread_id)),
    snooze: async () => {},
    markRead: async () => {},
    markUnread: async () => {},
    star: async () => {},
    priority: async () => {},
    combines: { waiting: new Map(), begin: () => {}, stop: async () => {} },
  } as unknown as BulkWrites;
  render({ bulk, live: [{ id: 'waiting', label: 'Waiting on you', threads: [row('live_1', { section: 'waiting' }), row('live_2', { section: 'waiting' })] }] });
  await switchOn();
  const click = (el: Element, init: MouseEventInit = {}) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })));
  const liveRow = (id: string) => [...document.querySelectorAll<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`)].find((el) => !el.closest('[data-archived-group]'))!;
  const count = () => document.querySelector('[data-pick-bar] [role="status"]')?.textContent ?? null;
  click(liveRow('live_1'), { metaKey: true });
  await openGroup();

  const archivedEl = group()!.querySelector<HTMLElement>('[data-thread-id]')!;
  const id = archivedEl.getAttribute('data-thread-id')!;
  expect(archivedEl.closest('.ib-rw')!.querySelector('[data-pick-box]')).not.toBeNull();
  expect(archivedEl.closest('.ib-rw')!.hasAttribute('data-archived')).toBe(false);
  click(archivedEl, { metaKey: true });
  expect(count()).toBe('2 selected');
  expect(archivedEl.getAttribute('aria-pressed')).toBe('true');
  expect(events).not.toContain(`open:${id}`);
  const combine = document.querySelector<HTMLElement>('[data-pick-bar] [data-pick-combine]')!;
  expect(combine.getAttribute('aria-disabled')).toBeNull();

  click(document.querySelector('[data-pick-bar] [data-bulk-action="archive"]')!);
  expect(archivedBy).toEqual([['live_1']]);
});

test.skipIf(!hasDom)("in the Agents view an archived row is the group's own row: Unarchive, not Mark unread", async () => {
  const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
  const { LIST_VIEW_COOKIE, resetListViewForTests } = await import('./listView');
  const kept = new Map<string, string>([[LIST_VIEW_COOKIE, 'agents']]);
  setStorageBackend({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) });
  resetListViewForTests();
  try {
    render();
    await switchOn();
    await openGroup();
    const wrap = group()!.querySelector<HTMLElement>('[data-row="arc_0"]')!;
    expect(wrap.querySelector('[data-row-unarchive]')?.getAttribute('aria-label')).toBe('Unarchive: Thread arc_0');
    expect(wrap.querySelector('.ib-lrow')).toBeNull();
    expect(wrap.textContent).not.toContain('Mark unread');
  } finally {
    resetStorageBackend();
    resetListViewForTests();
  }
});
