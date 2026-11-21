/**
 * Mark all as read and Archive all on the window's own InboxList (markAllRead.ts): a group band's menu (a right-click,
 * Shift+F10 on the focused band, a finger held on it; a sheet on a phone) offers them for that band's rows only, never
 * a snoozed one, each only where it has something to take; a band with nothing to take keeps the browser's own menu;
 * neither the right-click nor the hold toggles the band; no band menu while picking. The list's ⋮ offers "Mark all as
 * read" after "Select threads", taking every row the list shows that takes Mark read; the picks' bar shows Mark read
 * as its own button where there is room, and its ⋯ then does not list it again. They go through bulkWrites.ts
 * `markAllRead` and `archiveAll` (each thread as it is now, the warning, one toast and Undo); the bar's button through
 * the picks' Mark read.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxTidyPlan } from '@plannotator/core/inbox-types';
import type { BulkWrites } from './bulkWrites';
import type { TidyController } from './components/Tidy';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LONG_PRESS_MS } = await import('./components/useContextMenuTrigger');
const { resetListGroupsForTests } = await import('./listGroups');
const { BAND_TIP_TIMES } = await import('./bandTip');
import type { BandTipHost } from './bandTip';

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  // A test that toggles a band keeps it for the page (listGroups.ts): each test starts from the defaults.
  resetListGroupsForTests();
  tipHost = undefined;
});

const AGO = '2026-11-20T07:00:00.000Z';
function row(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: AGO,
    last_at: AGO,
    last_agent_at: AGO,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'alpha' },
    thread_name: null,
    section: 'new',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 1,
    sent: null,
    guide: false,
    priority: null,
    ...over,
  } as InboxListRow;
}

const SNOOZED = { until: '2099-01-01T00:00:00.000Z', at: AGO } as InboxListRow['snoozed'];
const SECTIONS: InboxListSection[] = [
  { id: 'waiting', label: 'Waiting on you', threads: [row('w1', { section: 'waiting', unseen: 0, questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 } })] },
  { id: 'new', label: 'New since you looked', threads: [row('n1'), row('n2', { snoozed: SNOOZED }), row('n3')] },
  { id: 'snoozed', label: 'Snoozed', threads: [row('z1', { snoozed: SNOOZED })] },
];

const calls: { via: 'all' | 'picks' | 'archive'; ids: string[] }[] = [];
const bulk = {
  archive: async () => {},
  snooze: async () => {},
  markRead: async (rows: readonly InboxListRow[]) => (calls.push({ via: 'picks', ids: rows.map((r) => r.thread_id) }), true),
  markAllRead: async (rows: readonly InboxListRow[]) => (calls.push({ via: 'all', ids: rows.map((r) => r.thread_id) }), true),
  archiveAll: async (rows: readonly InboxListRow[]) => (calls.push({ via: 'archive', ids: rows.map((r) => r.thread_id) }), true),
  markUnread: async () => {},
  star: async () => {},
  priority: async () => {},
  hidePulls: async () => {},
} as unknown as BulkWrites;

const tidy: TidyController = { surface: 'list', scope: null, plan: { serverSession: 's', count: 0, agents: [], run: null } as unknown as InboxTidyPlan as TidyController['plan'], run: null, start: async () => null, refresh: () => {} };

let tipHost: BandTipHost | undefined;
function draw(narrow = false, sections: InboxListSection[] = SECTIONS, phone = false): void {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} scope={null} sections={sections} filtered={false} narrow={narrow} phone={phone} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} onRowAction={() => {}} bulk={bulk} bandTip={tipHost} pinned={new Set()} tidy={tidy} />
        </div>
      </SidebarProvider>,
    );
  });
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
const band = (id: string) => host!.querySelector<HTMLButtonElement>(`[data-section-id="${id}"] > button.ib-band`)!;
const bandMenu = () => document.querySelector<HTMLElement>('[data-band-menu]');
const bandItems = () => [...(bandMenu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((el) => el.textContent);
async function rightClick(el: Element): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 20 });
  act(() => void el.dispatchEvent(event));
  await settle();
  return event;
}
async function closeMenu() {
  act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
}
/** A touch event as a phone sends it (one finger down; none on the lift). */
function touch(target: Element, type: 'touchstart' | 'touchend'): Event {
  const point = { identifier: 1, clientX: 40, clientY: 20, pageX: 40, pageY: 20, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  act(() => void target.dispatchEvent(event));
  return event;
}
const rowEl = (id: string) => host!.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`)!;
async function openListMenu() {
  act(() => host!.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  return document.querySelector<HTMLElement>('[data-tidy-menu-popup]')!;
}

test.skipIf(!hasDom)('a right-click on a band: Mark all as read and Archive all on that band’s rows only, never a snoozed one; the band does not toggle', async () => {
  if (!hasDom) return;
  calls.length = 0;
  draw();
  const expanded = band('new').getAttribute('aria-expanded');
  const event = await rightClick(band('new').querySelector('.ib-n')!);
  expect(event.defaultPrevented).toBe(true);
  expect(bandMenu()?.getAttribute('data-band-menu')).toBe('new');
  expect(bandMenu()?.getAttribute('aria-label')).toBe('New since you looked');
  expect(bandItems()).toEqual(['Mark all as read', 'Archive all']);
  expect(band('new').getAttribute('aria-expanded')).toBe(expanded);
  // The band keeps its look while its menu is open, as a row does.
  expect(band('new').hasAttribute('data-menu')).toBe(true);
  act(() => bandMenu()!.querySelector<HTMLElement>('[data-band-action="read"]')!.click());
  await settle();
  expect(calls).toEqual([{ via: 'all', ids: ['n1', 'n3'] }]);
  expect(band('new').hasAttribute('data-menu')).toBe(false);
  // Another band's menu is its own rows'.
  await rightClick(band('waiting'));
  act(() => bandMenu()!.querySelector<HTMLElement>('[data-band-action="archive"]')!.click());
  await settle();
  expect(calls).toEqual([{ via: 'all', ids: ['n1', 'n3'] }, { via: 'archive', ids: ['w1'] }]);
  expect(band('waiting').getAttribute('aria-expanded')).toBe('true');
});

test.skipIf(!hasDom)('a band with nothing to take (Snoozed) has no menu: the browser keeps its own; it names no menu key', async () => {
  if (!hasDom) return;
  draw();
  const event = await rightClick(band('snoozed'));
  expect(event.defaultPrevented).toBe(false);
  expect(bandMenu()).toBeNull();
  expect(band('snoozed').hasAttribute('aria-keyshortcuts')).toBe(false);
  expect(band('new').getAttribute('aria-keyshortcuts')).toBe('Shift+F10');
});

test.skipIf(!hasDom)('Shift+F10 on the focused band opens its menu; Escape puts focus back on the band', async () => {
  if (!hasDom) return;
  draw();
  act(() => band('new').focus());
  act(() => void band('new').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })));
  await settle();
  expect(bandMenu()?.getAttribute('data-band-menu')).toBe('new');
  await closeMenu();
  expect(bandMenu()).toBeNull();
  expect(document.activeElement).toBe(band('new'));
});

test.skipIf(!hasDom)('a finger held on a band opens its menu as a sheet on a phone; the lift neither toggles the band nor picks an item', async () => {
  if (!hasDom) return;
  calls.length = 0;
  draw(false, SECTIONS, true);
  const expanded = band('new').getAttribute('aria-expanded');
  touch(band('new'), 'touchstart');
  await act(async () => void (await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 80))));
  expect(bandMenu()?.getAttribute('data-band-menu')).toBe('new');
  expect(bandMenu()!.closest('[data-phone]')).not.toBeNull();
  expect(bandMenu()!.querySelector('.ib-pm-title')?.textContent).toBe('New since you looked');
  const lift = touch(band('new'), 'touchend');
  expect(lift.defaultPrevented).toBe(true);
  // The click a browser sends after the lift, on the band: swallowed.
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  act(() => void band('new').dispatchEvent(click));
  expect(click.defaultPrevented).toBe(true);
  expect(band('new').getAttribute('aria-expanded')).toBe(expanded);
  expect(calls).toEqual([]);
  // A tap is a tap: once the hold is over, a tap on the band toggles it.
  await act(async () => void (await new Promise((r) => setTimeout(r, 450))));
  await closeMenu();
  touch(band('new'), 'touchstart');
  touch(band('new'), 'touchend');
  act(() => band('new').click());
  expect(band('new').getAttribute('aria-expanded')).not.toBe(expanded);
  expect(bandMenu()).toBeNull();
});

test.skipIf(!hasDom)('while picking a band has no menu (its box is the picks’); after Done it has again', async () => {
  if (!hasDom) return;
  draw();
  act(() => void rowEl('n1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
  expect(host!.querySelector('[data-pick-bar]')).not.toBeNull();
  const event = await rightClick(band('new'));
  expect(event.defaultPrevented).toBe(false);
  expect(bandMenu()).toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>('[data-pick-done]')!.click());
  await rightClick(band('new'));
  expect(bandMenu()?.getAttribute('data-band-menu')).toBe('new');
});

test.skipIf(!hasDom)('the list ⋮: "Mark all as read" right after "Select threads", taking every row the list shows but the snoozed one', async () => {
  if (!hasDom) return;
  calls.length = 0;
  draw();
  const menu = await openListMenu();
  const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
  expect(labels.indexOf('Mark all as read')).toBe(labels.indexOf('Select threads') + 1);
  act(() => menu.querySelector<HTMLElement>('[data-list-mark-all-read]')!.click());
  await settle();
  expect(calls).toEqual([{ via: 'all', ids: ['w1', 'n1', 'n3'] }]);
});

test.skipIf(!hasDom)('the picks’ bar: Mark read is its own button and not in its ⋯; beside an open thread it stays in the ⋯', async () => {
  if (!hasDom) return;
  calls.length = 0;
  draw();
  act(() => void rowEl('n1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
  const read = host!.querySelector<HTMLButtonElement>('[data-pick-bar] > [data-bulk-action="read"]')!;
  expect(read).not.toBeNull();
  expect(read.textContent).toBe('Mark read');
  act(() => host!.querySelector<HTMLButtonElement>('[data-pick-bar] [data-pick-menu="more"]')!.click());
  await settle();
  expect(document.querySelector('[data-pick-popup="more"] [data-bulk-action="read"]')).toBeNull();
  act(() => read.click());
  expect(calls).toEqual([{ via: 'picks', ids: ['n1'] }]);
  // Narrow (beside an open thread): no room in the bar, so Mark read is the ⋯'s.
  act(() => root?.unmount());
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  draw(true);
  act(() => void rowEl('n1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
  expect(host!.querySelector('[data-pick-bar] > [data-bulk-action="read"]')).toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>('[data-pick-bar] [data-pick-menu="more"]')!.click());
  await settle();
  expect(document.querySelector('[data-pick-popup="more"] [data-bulk-action="read"]')).not.toBeNull();
});

test.skipIf(!hasDom)('the picks’ bar with no room for the whole line (measured): Mark read goes back into its ⋯, and comes out once there is room', async () => {
  if (!hasDom) return;
  // As a browser lays it out: the line never runs past the bar; the count shrinks under the buttons instead (it is cut).
  // The line needs 600 px with Mark read, 505 without. The column gives 552, then 640.
  let column = 552;
  const proto = HTMLElement.prototype;
  const sw = Object.getOwnPropertyDescriptor(proto, 'scrollWidth');
  const cw = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  const need = (bar: Element) => (bar.querySelector(':scope > [data-bulk-action="read"]') ? 600 : 505);
  const width = (el: HTMLElement, scroll: boolean): number => {
    if (el.hasAttribute('data-pick-bar')) return column;
    if (el.classList.contains('ib-pick-n')) return scroll ? 76 : Math.max(0, 76 - Math.max(0, need(el.parentElement!) - column));
    return 0;
  };
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return width(this, true); } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return width(this, false); } });
  try {
    draw();
    act(() => void rowEl('n1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
    expect(host!.querySelector('[data-pick-bar] > [data-bulk-action="read"]')).toBeNull();
    act(() => host!.querySelector<HTMLButtonElement>('[data-pick-bar] [data-pick-menu="more"]')!.click());
    await settle();
    expect(document.querySelector('[data-pick-popup="more"] [data-bulk-action="read"]')).not.toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    // Wider: the next pick measures again and Mark read is the bar's own button.
    column = 640;
    act(() => void rowEl('n3').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
    expect(host!.querySelector('[data-pick-bar] > [data-bulk-action="read"]')).not.toBeNull();
  } finally {
    if (sw) Object.defineProperty(proto, 'scrollWidth', sw);
    else delete (proto as { scrollWidth?: number }).scrollWidth;
    if (cw) Object.defineProperty(proto, 'clientWidth', cw);
    else delete (proto as { clientWidth?: number }).clientWidth;
  }
});

/** The Group tip's host as App hands it (bandTip.ts): due, with a claim the Inbox grants once. */
function tipWorld(busy = () => false) {
  const claims: number[] = [];
  let granted = false;
  tipHost = {
    due: true,
    busy: () => busy(),
    claim: async () => {
      claims.push(Date.now());
      const ok = !granted;
      granted = true;
      return ok;
    },
  };
  return claims;
}
// React's onPointerEnter listens for pointerover with where the pointer came from.
const point = (el: Element, pointerType = 'mouse') => act(() => void el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType, relatedTarget: document.body })));
const tipText = () => [...document.querySelectorAll('[data-pn-tooltip]')].map((el) => el.textContent).join('|');

test.skipIf(!hasDom)('the Group tip: the first hover of a band with a menu shows "Right-click for group actions" once; a press takes it away; never again', async () => {
  if (!hasDom) return;
  const claims = tipWorld();
  draw();
  // A band with no menu (Snoozed) asks nothing.
  point(band('snoozed'));
  await settle();
  expect(claims).toHaveLength(0);
  point(band('new'));
  await settle();
  expect(claims).toHaveLength(1);
  expect(tipText()).toBe('Right-click for group actions');
  act(() => void window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle();
  expect(tipText()).toBe('');
  point(band('waiting'));
  await settle();
  expect(claims).toHaveLength(1);
  expect(tipText()).toBe('');
});

test.skipIf(!hasDom)('the Group tip: the band’s menu opened first retires it (claimed unshown); a hover after shows nothing', async () => {
  if (!hasDom) return;
  const claims = tipWorld();
  draw();
  await rightClick(band('new'));
  expect(bandMenu()).not.toBeNull();
  expect(claims).toHaveLength(1);
  await closeMenu();
  point(band('waiting'));
  await settle();
  expect(claims).toHaveLength(1);
  expect(tipText()).toBe('');
});

test.skipIf(!hasDom)('the Group tip: not while picking rows, not while another one-time thing is up; the next hover after is the one', async () => {
  if (!hasDom) return;
  let reveal = true;
  const claims = tipWorld(() => reveal);
  draw();
  point(band('new'));
  await settle();
  expect(claims).toHaveLength(0);
  reveal = false;
  act(() => void rowEl('n1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
  point(band('waiting'));
  await settle();
  expect(claims).toHaveLength(0);
  act(() => host!.querySelector<HTMLButtonElement>('[data-pick-done]')!.click());
  point(band('waiting'));
  await settle();
  expect(claims).toHaveLength(1);
  expect(tipText()).toBe('Right-click for group actions');
});

test.skipIf(!hasDom)('the Group tip on a phone: the list held still a while shows "Hold a group for actions" on the first band with a menu; a touch first waits again', async () => {
  if (!hasDom) return;
  const real = { ...BAND_TIP_TIMES };
  BAND_TIP_TIMES.phoneViewMs = 120;
  try {
    const claims = tipWorld();
    draw(false, SECTIONS, true);
    await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
    // A touch (a scroll's start, a swipe) before the wait is over: the wait starts again.
    act(() => void window.dispatchEvent(new Event('touchstart')));
    await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
    expect(claims).toHaveLength(0);
    await act(async () => void (await new Promise((r) => setTimeout(r, 120))));
    expect(claims).toHaveLength(1);
    expect(tipText()).toBe('Hold a group for actions');
    // A mouse never asks on a phone, and a touch takes it away.
    act(() => void window.dispatchEvent(new Event('touchstart')));
    await settle();
    expect(tipText()).toBe('');
  } finally {
    Object.assign(BAND_TIP_TIMES, real);
  }
});
