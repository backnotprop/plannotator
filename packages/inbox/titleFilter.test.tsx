/**
 * Filter by typing in the list (components/TitleFilter.tsx, listTitleFilter.ts, listTitleFilterStore.ts): the filter
 * menu's first row opens a field under the header that narrows the list by title as the person types.
 *
 * What this catches: the row missing, not first, not alone above Not seen, or drawn with a count; anything joining the
 * header (the field belongs under it); the field not taking focus, or missing its name; typing that does not narrow on
 * each key, band counts that do not follow, an emptied band left drawn; words that replace the menu's picks instead of
 * narrowing what they left; menu counts that ignore the words; nothing matching that draws Clear filters or nothing at
 * all; the × or Escape leaving words, the field, a narrowed list, or focus nowhere; Escape reaching the window's own
 * Escape (closing a thread too); a linked computer's threads left unfiltered; the words lost when the list is drawn
 * again (a thread opened and closed) or on a reload of the tab.
 *
 * The harness wires the list as App.tsx does (the picks applied to the sections, the rows before them for the menu).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { ArchivedModel } from './api';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { ListFilterEmpty, clearedFrom } = (hasDom ? await import('./components/ListFilter') : {}) as typeof import('./components/ListFilter');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { appliedFilter, filterListSections, pickCount, resetListFilterForTests, useListFilter } = await import('./listFilter');
const { TITLE_FILTER_LABEL, TITLE_FILTER_NONE, TITLE_FILTER_PLACEHOLDER } = await import('./listTitleFilter');
const { resetTitleFilterForTests } = await import('./listTitleFilterStore');
const { resetScheduledForTests } = await import('./scheduled/store');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
const { useArchivedGroup } = await import('./data/actions/archivedGroup');
const { createInboxQueryClient } = await import('./data/client');
const { inboxApi } = await import('./api');
const { adoptShowArchived, resetShowArchivedForTests } = await import('./showArchived');
const { useShowLight } = await import('./showLight');

const NOW = new Date(2026, 10, 5, 15, 0, 0);
const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  setSystemTime(NOW);
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  resetListFilterForTests();
  resetScheduledForTests();
  resetTitleFilterForTests();
});

afterEach(() => {
  setSystemTime();
  if (hasDom) act(() => root?.unmount());
  resetStorageBackend();
  resetListFilterForTests();
  resetScheduledForTests();
  resetTitleFilterForTests();
  if (!hasDom) return;
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
});

function row(id: string, subject: string, project: string, agent: string, section: InboxListRow['section'], machine?: string): InboxListRow {
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    subject,
    thread_name: null,
    author: { kind: 'agent', host: agent, session: `s_${id}`, name: null },
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    section,
    unread: true,
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    ...(machine ? { machine } : {}),
  } as unknown as InboxListRow;
}

function sections(by: Partial<Record<InboxListGroupId, InboxListRow[]>>): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: by[id] ?? [] })) as InboxListSection[];
}

// Two of the rows are the linked computer's (`machine`), in the same list as this computer's.
const LIST = sections({
  stopped: [row('trash', 'Trash for deleted pages', 'web', 'claude-code', 'stopped'), row('retry', 'Retry worker on a 409', 'api', 'codex', 'stopped')],
  holding: [row('invoice', 'Invoice PDF export', 'api', 'claude-code', 'holding'), row('search', 'Search results page layout', 'docs', 'opencode', 'holding', 'mch_other')],
  new: [row('history', 'Page history: restore a version', 'web', 'opencode', 'new', 'mch_other'), row('webhook', 'Webhook signature check', 'api', 'codex', 'new')],
});

interface Look {
  /** The list's rows (LIST unless a test needs others). */
  list?: InboxListSection[];
  /** Which list this is (App: the sidebar's view). */
  place?: string;
}

/** App.tsx's wiring: the picks from this browser, the sections filtered, the rows before the filter for the menu. */
function Harness({ list = LIST, place = 'inbox' }: Look) {
  const [picks, setPicks] = useListFilter();
  const applied = appliedFilter(picks, false, false, false);
  const shown = filterListSections(list, applied, Date.now());
  const none = pickCount(applied) > 0 && shown.every((s) => s.threads.length === 0);
  return (
    <InboxList
      title="Inbox"
      path={null}
      sections={shown}
      sort={{ epoch: 1, keep: null }}
      filtered={false}
      narrow={false}
      phone={false}
      selectedThreadId={null}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      empty={none ? <ListFilterEmpty onClear={() => setPicks(clearedFrom(picks, false))} /> : null}
      listFilter={{ rows: list.flatMap((s) => s.threads), scoped: false, names: new Map(), filter: picks, onChange: setPicks, place }}
    />
  );
}

/** The list with its Archived group (data/actions/archivedGroup.ts), the Inbox's answers stood in. */
function ArchivedHarness() {
  const [picks, setPicks] = useListFilter();
  const { host: archived } = useArchivedGroup({
    project: null,
    merged: false,
    filter: (rows) => rows,
    showToast: () => {},
    showError: () => {},
    afterWrite: async () => {},
    archive: async () => {},
    go: () => {},
    refreshList: async () => {},
  });
  return (
    <InboxList
      title="Inbox"
      path={null}
      sections={LIST}
      sort={{ epoch: 1, keep: null }}
      filtered={false}
      narrow={false}
      phone={false}
      selectedThreadId={null}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      archived={archived}
      tidy={{ surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} }}
      listFilter={{ rows: LIST.flatMap((s) => s.threads), scoped: false, names: new Map(), filter: picks, onChange: setPicks, place: 'inbox' }}
    />
  );
}

/** Two held rows: one the words "page" keep, one they do not. */
const NEWS = [row('deploy', 'Page deploy notes', 'web', 'codex', 'new'), row('cron', 'Cron schedule tidy', 'api', 'codex', 'new')];
const NEWS_IDS = NEWS.map((r) => r.thread_id);

/** App.tsx's held news: the bar's Show brings the held rows into the list and lights them (showLight.ts), the pill counts the ones out of view. */
function NewsHarness() {
  const [picks, setPicks] = useListFilter();
  const [list, setList] = useState(LIST);
  const [held, setHeld] = useState(true);
  const light = useShowLight();
  return (
    <InboxList
      title="Inbox"
      path={null}
      sections={list}
      sort={{ epoch: 1, keep: null }}
      filtered={false}
      narrow={false}
      phone={false}
      selectedThreadId={null}
      notice={held ? { count: NEWS.length } : null}
      onShowNew={() => {
        setList(sections({ ...Object.fromEntries(LIST.map((s) => [s.id, s.threads])), new: [...LIST.find((s) => s.id === 'new')!.threads, ...NEWS] }));
        setHeld(false);
        light.light(new Set(NEWS_IDS), 0, document.querySelector<HTMLElement>('.ib-lbody'));
      }}
      unseenNew={light.unseen}
      onGoNew={light.go}
      onOpen={() => {}}
      listFilter={{ rows: list.flatMap((s) => s.threads), scoped: false, names: new Map(), filter: picks, onChange: setPicks, place: 'inbox' }}
    />
  );
}

function render(look: Look = {}): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  show(look);
  return host;
}

/** The same list drawn with other props (App: another sidebar view, the list itself kept). */
function show(look: Look) {
  act(() => {
    root!.render(
      <SidebarProvider>
        <Harness {...look} />
      </SidebarProvider>,
    );
  });
}

/** The list drawn again from scratch (a thread opened over it on a phone and closed, or another view and back). */
function redraw(look: Look = {}): HTMLElement {
  act(() => root?.unmount());
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  return render(look);
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
async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}
/** Each key typed one at a time, as a person types: the list narrows on every one. */
async function typeKeys(input: HTMLInputElement, text: string, after?: (typed: string) => void) {
  for (let i = 1; i <= text.length; i += 1) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text.slice(0, i));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    after?.(text.slice(0, i));
  }
  await settle();
}
async function key(target: HTMLElement, name: string) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const funnel = () => $('.ib-lhead [data-list-filter]')!;
const field = () => document.querySelector<HTMLInputElement>('[data-title-filter-input]');
const rowIds = (el: HTMLElement) => [...el.querySelectorAll('.ib-lbody [data-thread-id]')].map((n) => n.getAttribute('data-thread-id'));
/** Each band drawn with its count: "stopped 2". */
const bandCounts = (el: HTMLElement) =>
  [...el.querySelectorAll('.ib-lbody .ib-group[data-section-id]')].map((g) => `${g.getAttribute('data-section-id')} ${g.querySelector('.ib-band .ib-n')?.textContent ?? ''}`.trim());
const ALL = ['trash', 'retry', 'invoice', 'search', 'history', 'webhook'];

/** The menu, then its first row: the field opens. */
async function openField() {
  await press(funnel());
  await click($('[data-list-filter-title]')!);
}

describe.skipIf(!hasDom)('Filter by typing', () => {
  test("the menu's first row, alone above Not seen, the search mark and no count; the header gains nothing", async () => {
    const el = render();
    await press(funnel());
    const rows = [...document.querySelectorAll<HTMLElement>('[data-list-filter-menu] .ib-pmi')];
    expect(rows[0]!.hasAttribute('data-list-filter-title')).toBe(true);
    expect(rows[0]!.querySelector('.ib-pmi-l')!.textContent).toBe(TITLE_FILTER_LABEL);
    expect(rows[0]!.querySelector('.ib-pmi-n')).toBeNull();
    expect(rows[0]!.querySelector('svg')).not.toBeNull();
    // Its own section: the menu's separator, then Not seen.
    expect(rows[0]!.nextElementSibling?.classList.contains('ib-pm-sep')).toBe(true);
    expect(rows[1]!.hasAttribute('data-list-filter-not-seen')).toBe(true);
    await click(rows[0]!);
    expect($('[data-list-filter-menu]')).toBeNull();
    expect(el.querySelector('.ib-lhead')!.textContent).toBe('Inbox');
    expect(funnel().hasAttribute('data-set')).toBe(false);
  });

  test('the row opens a named field under the header, with focus, and the whole list still there', async () => {
    const el = render();
    await openField();
    const input = field()!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe(TITLE_FILTER_PLACEHOLDER);
    expect(input.placeholder).toBe(TITLE_FILTER_PLACEHOLDER);
    expect($('[data-title-filter-close]')!.getAttribute('aria-label')).toBeTruthy();
    // Under the header, above the list's body.
    const box = $('[data-title-filter]')!;
    expect(box.previousElementSibling?.classList.contains('ib-lhead')).toBe(true);
    expect(el.querySelector('.ib-lhead [data-title-filter]')).toBeNull();
    expect(rowIds(el)).toEqual(ALL);
  });

  test("each key narrows the list in place by title; band counts follow and an emptied band goes; a linked computer's rows too", async () => {
    const el = render();
    await openField();
    const seen: Record<string, (string | null)[]> = {};
    await typeKeys(field()!, 'page', (typed) => (seen[typed] = rowIds(el)));
    // On every key, no Enter.
    expect(seen.p).toEqual(['trash', 'invoice', 'search', 'history']);
    expect(seen.pa).toEqual(['trash', 'search', 'history']);
    expect(rowIds(el)).toEqual(['trash', 'search', 'history']);
    expect(bandCounts(el)).toEqual(['stopped 1', 'holding 1', 'new 1']);
    // Two words, any order, case and accents aside: only the linked computer's thread holds both.
    await typeKeys(field()!, 'LAYOUT pàge');
    expect(rowIds(el)).toEqual(['search']);
    expect(bandCounts(el)).toEqual(['holding 1']);
  });

  test("the words narrow what the menu's picks left, never replace them; the menu counts what the words leave", async () => {
    const el = render();
    await press(funnel());
    await click($('[data-list-filter-project="prj_api"]')!);
    await click($('[data-list-filter-title]')!);
    expect(rowIds(el)).toEqual(['retry', 'invoice', 'webhook']);
    await typeKeys(field()!, 'e');
    expect(rowIds(el)).toEqual(['retry', 'invoice', 'webhook']);
    await typeKeys(field()!, 'export');
    expect(rowIds(el)).toEqual(['invoice']);
    // The pick is still on (badge), and the menu's counts are the rows the words leave; every project is still offered,
    // the picked one too, so it can be unticked.
    expect(funnel().querySelector('[data-list-filter-count]')?.textContent).toBe('1');
    await press(funnel());
    expect($('[data-list-filter-project="prj_api"] .ib-pmi-n')!.textContent).toBe('1');
    expect($('[data-list-filter-project="prj_web"] .ib-pmi-n')!.textContent).toBe('0');
    expect($('[data-list-filter-project="prj_api"]')!.getAttribute('aria-checked')).toBe('true');
  });

  test('nothing matching: "No threads match" where the list would be, and nothing else there', async () => {
    const el = render();
    await openField();
    await typeKeys(field()!, 'billing');
    expect(rowIds(el)).toEqual([]);
    const none = el.querySelector<HTMLElement>('.ib-lbody [data-title-filter-none]')!;
    expect(none.textContent).toBe(TITLE_FILTER_NONE);
    expect(none.querySelector('button')).toBeNull();
    expect(el.querySelector('[data-list-filter-empty]')).toBeNull();
    expect(el.querySelectorAll('.ib-lbody .ib-band')).toHaveLength(0);
  });

  test('the × empties the field, takes it away, gives back the whole list and focus to the filter button', async () => {
    const el = render();
    await openField();
    await typeKeys(field()!, 'webhook');
    expect(rowIds(el)).toEqual(['webhook']);
    await click($('[data-title-filter-close]')!);
    expect(field()).toBeNull();
    expect($('[data-title-filter]')).toBeNull();
    expect(rowIds(el)).toEqual(ALL);
    expect(bandCounts(el)).toEqual(['stopped 2', 'holding 2', 'new 2']);
    expect(document.activeElement).toBe(funnel());
    // Opened again, it is empty.
    await openField();
    expect(field()!.value).toBe('');
  });

  test("Escape in the field does the same, and goes no further (the window's own Escape never sees it)", async () => {
    const el = render();
    const heard: string[] = [];
    const listen = (event: KeyboardEvent) => heard.push(event.key);
    document.addEventListener('keydown', listen);
    try {
      await openField();
      await typeKeys(field()!, 'page');
      await key(field()!, 'Escape');
      expect(field()).toBeNull();
      expect(rowIds(el)).toEqual(ALL);
      expect(document.activeElement).toBe(funnel());
      expect(heard).toEqual([]);
    } finally {
      document.removeEventListener('keydown', listen);
    }
  });

  test('typing starts the matches at the top; closing puts the list back where it was scrolled', async () => {
    const el = render();
    const body = el.querySelector<HTMLElement>('.ib-lbody')!;
    body.scrollTop = 120;
    await openField();
    await typeKeys(field()!, 'page');
    expect(body.scrollTop).toBe(0);
    await click($('[data-title-filter-close]')!);
    await act(async () => void (await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))));
    expect(body.scrollTop).toBe(120);
  });

  test('closed in another list (another sidebar view), the scroll stays where it is; no other list\'s scroll is put back', async () => {
    const el = render({ place: 'inbox' });
    const body = el.querySelector<HTMLElement>('.ib-lbody')!;
    body.scrollTop = 120;
    await openField();
    await typeKeys(field()!, 'page');
    // Another view: the field and its words stay, the list is the same element, scrolled by the person.
    show({ place: 'project web' });
    await settle();
    expect(field()!.value).toBe('page');
    body.scrollTop = 40;
    await click($('[data-title-filter-close]')!);
    await act(async () => void (await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))));
    expect(body.scrollTop).toBe(40);
  });

  test("a reload keeps the list's scroll from when the field opened: closing puts it back, in that list only", async () => {
    let el = render({ place: 'inbox' });
    el.querySelector<HTMLElement>('.ib-lbody')!.scrollTop = 120;
    await openField();
    await typeKeys(field()!, 'page');
    act(() => root?.unmount());
    host?.remove();
    resetTitleFilterForStateOnly();
    el = render({ place: 'inbox' });
    await settle();
    const body = el.querySelector<HTMLElement>('.ib-lbody')!;
    body.scrollTop = 0;
    await click($('[data-title-filter-close]')!);
    expect(body.scrollTop).toBe(120);
  });

  test('"No threads match" only when nothing at all matches: a match in the folded Snoozed band draws no such words', async () => {
    const list = sections({ ...Object.fromEntries(LIST.map((s) => [s.id, s.threads])), snoozed: [row('later', 'Billing export later', 'api', 'codex', 'snoozed' as InboxListRow['section'])] });
    const el = render({ list });
    await openField();
    await typeKeys(field()!, 'billing');
    expect(bandCounts(el)).toEqual(['snoozed 1']);
    expect(el.querySelector('.ib-lbody [data-title-filter-none]') === null).toBe(true);
    await typeKeys(field()!, 'billing nothing');
    expect(el.querySelector('.ib-lbody [data-title-filter-none]')!.textContent).toBe(TITLE_FILTER_NONE);
  });

  test('"No threads match" stays away while only a row of the open Archived group matches', async () => {
    const archivedRow = { ...row('old', 'Billing archive sweep', 'api', 'codex', 'quiet'), resolved_at: new Date(NOW.getTime() - 86_400_000).toISOString() } as InboxListRow;
    const spy = spyOn(inboxApi, 'archived').mockImplementation(
      async (input = {}) => ({ serverSession: 's', cursor: 1, project: null, projects: [], total: 1, offset: 0, limit: input.limit ?? 50, threads: [archivedRow] }) as ArchivedModel,
    );
    resetShowArchivedForTests();
    try {
      const client = createInboxQueryClient();
      host = document.createElement('div');
      host.className = 'pn-inbox';
      document.body.append(host);
      root = createRoot(host);
      act(() => {
        root!.render(
          <QueryClientProvider client={client}>
            <SidebarProvider>
              <ArchivedHarness />
            </SidebarProvider>
          </QueryClientProvider>,
        );
      });
      adoptShowArchived({ on: true, rev: 1 });
      await settle();
      await click(document.querySelector<HTMLElement>('[data-archived-group] .ib-band')!);
      await settle();
      const el = host;
      await openField();
      await typeKeys(field()!, 'billing');
      // No live row holds "billing"; the Archived group's row does, and it is drawn.
      expect(rowIds(el)).toEqual(['old']);
      expect(el.querySelector('.ib-lbody [data-title-filter-none]') === null).toBe(true);
      await typeKeys(field()!, 'billing nothing');
      expect(el.querySelector('.ib-lbody [data-title-filter-none]')!.textContent).toBe(TITLE_FILTER_NONE);
    } finally {
      spy.mockRestore();
      resetShowArchivedForTests();
    }
  });

  test('"N new · Show" with words typed: Show brings in only the new rows the words keep, and the pill counts only those', async () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    const realRects = HTMLElement.prototype.getClientRects;
    // The list shows 0 to 600; the rows Show brings in land below it, every other row in view.
    const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }) as DOMRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const id = this.getAttribute('data-thread-id');
      return id === null ? box(0, 600) : box(NEWS_IDS.includes(id) ? 900 : 100, 40);
    };
    HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
      return (this.isConnected ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList;
    };
    try {
      host = document.createElement('div');
      host.className = 'pn-inbox';
      document.body.append(host);
      root = createRoot(host);
      act(() => {
        root!.render(
          <SidebarProvider>
            <NewsHarness />
          </SidebarProvider>,
        );
      });
      const el = host;
      await openField();
      await typeKeys(field()!, 'page');
      expect(rowIds(el)).toEqual(['trash', 'search', 'history']);
      // The words stay on the bar's Show: the held rows come in under them.
      await click(el.querySelector<HTMLElement>('[data-inbox-notice]')!);
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
      await settle();
      expect(field()!.value).toBe('page');
      expect(rowIds(el)).toEqual(['trash', 'search', 'history', 'deploy']);
      // One row came in below the view: the pill says one, not the two Show brought.
      const pill = el.querySelector<HTMLElement>('[data-list-new-pill]')!;
      expect(pill.hasAttribute('data-off')).toBe(false);
      expect(pill.textContent).toBe('1 new');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect;
      HTMLElement.prototype.getClientRects = realRects;
    }
  });

  test('a screen reader hears how many threads match once typing pauses, in the field\'s polite status; nothing shows', async () => {
    render();
    await openField();
    const status = () => $('[data-title-filter] [role="status"]');
    expect(status()!.classList.contains('ib-sr')).toBe(true);
    await typeKeys(field()!, 'page');
    // Not on every key: only after the pause.
    expect(status()!.textContent).toBe('');
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))));
    expect(status()!.textContent).toBe('3 matches');
    await typeKeys(field()!, 'pagex');
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))));
    expect(status()!.textContent).toBe(TITLE_FILTER_NONE);
  });

  test("the row flies to the field and the field folds away; with reduced motion neither, and nothing is left behind", async () => {
    const el = render();
    await openField();
    // The menu's row on its way (over the page, outside the list), and the list making room.
    expect(document.querySelectorAll('.ib-tflt-ghost')).toHaveLength(1);
    expect($('[data-title-filter]')!.hasAttribute('data-enter')).toBe(true);
    await typeKeys(field()!, 'page');
    await click($('[data-title-filter-close]')!);
    // A copy folds away in the field's place, words and all, never taken for the field.
    const copies = [...el.querySelectorAll<HTMLElement>('.ib-tflt')];
    expect(copies).toHaveLength(1);
    expect(copies[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(copies[0]!.querySelector('input')!.value).toBe('page');
    expect(field()).toBeNull();
    expect(rowIds(el)).toEqual(ALL);

    const was = window.matchMedia;
    window.matchMedia = ((query: string) => ({ ...was.call(window, query), matches: query.includes('prefers-reduced-motion') })) as typeof window.matchMedia;
    try {
      for (const node of document.querySelectorAll('.ib-tflt-ghost, .ib-tflt')) node.remove();
      await openField();
      expect(document.querySelectorAll('.ib-tflt-ghost')).toHaveLength(0);
      expect($('[data-title-filter]')!.hasAttribute('data-enter')).toBe(false);
      expect(document.activeElement).toBe(field());
      await key(field()!, 'Escape');
      expect(el.querySelectorAll('.ib-tflt')).toHaveLength(0);
    } finally {
      window.matchMedia = was;
    }
  });

  test('the field and its words outlive the list being drawn again, and a reload of the tab', async () => {
    let el = render();
    await openField();
    await typeKeys(field()!, 'retry');
    el = redraw();
    await settle();
    expect(field()!.value).toBe('retry');
    expect(rowIds(el)).toEqual(['retry']);
    // A reload: this page's memory gone, the tab's storage kept.
    act(() => root?.unmount());
    host?.remove();
    resetTitleFilterForStateOnly();
    el = render();
    await settle();
    expect(field()!.value).toBe('retry');
    expect(rowIds(el)).toEqual(['retry']);
    // Drawn again, it does not steal focus.
    expect(document.activeElement).not.toBe(field());
  });
});

/** A reload: the store module's memory gone, sessionStorage kept (resetTitleFilterForTests clears both). */
function resetTitleFilterForStateOnly() {
  const kept = sessionStorage.getItem('plannotator-inbox-title-filter');
  resetTitleFilterForTests();
  if (kept !== null) sessionStorage.setItem('plannotator-inbox-title-filter', kept);
}
