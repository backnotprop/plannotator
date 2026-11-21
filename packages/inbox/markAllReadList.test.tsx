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
const REAL_TIP_TIMES = { ...BAND_TIP_TIMES };
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
  Object.assign(BAND_TIP_TIMES, REAL_TIP_TIMES);
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
function draw(narrow = false, sections: InboxListSection[] = SECTIONS, phone = false, covered = false): void {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} scope={null} sections={sections} filtered={false} narrow={narrow} phone={phone} covered={covered} selectedThreadId={covered ? 'w1' : null} notice={null} onShowNew={() => {}} onOpen={() => {}} onRowAction={() => {}} bulk={bulk} bandTip={tipHost} pinned={new Set()} tidy={tidy} />
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

test.skipIf(!hasDom)('a band with nothing to take (Snoozed) has no menu: the browser keeps its own; it names no menu key; no band says it opens a menu (Enter toggles it)', async () => {
  if (!hasDom) return;
  draw();
  const event = await rightClick(band('snoozed'));
  expect(event.defaultPrevented).toBe(false);
  expect(bandMenu()).toBeNull();
  expect(band('snoozed').hasAttribute('aria-keyshortcuts')).toBe(false);
  expect(band('new').getAttribute('aria-keyshortcuts')).toBe('Shift+F10');
  expect([band('new'), band('waiting'), band('snoozed')].some((el) => el.hasAttribute('aria-haspopup'))).toBe(false);
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

/** Waits in real time (the hold's timers are real ones). */
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** The parts of a band a pointer can land on: the band's own box (its empty middle), the name's count, the chevron, the tip's anchor. */
const bandParts = (id: string): [string, Element][] => [
  ['the band', band(id)],
  ['the count', band(id).querySelector('.ib-n')!],
  ['the chevron', band(id).querySelector('svg.ib-band-chev')!],
  ['the tip anchor', band(id).querySelector('.ib-band-tipat')!],
];
/** A mouse's right-click as a browser sends it: down, the menu event, up, and no click. */
function mouseRight(el: Element): MouseEvent {
  const at = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 900, clientY: 20 };
  act(() => void el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse' })));
  act(() => void el.dispatchEvent(new MouseEvent('mousedown', at)));
  const menuEvent = new MouseEvent('contextmenu', at);
  act(() => void el.dispatchEvent(menuEvent));
  act(() => void el.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0, pointerType: 'mouse' })));
  act(() => void el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 })));
  return menuEvent;
}
/** A mouse's left click as a browser sends it. */
function mouseLeft(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 900, clientY: 20 };
  act(() => void el.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1, pointerType: 'mouse' })));
  act(() => void el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 })));
  act(() => void el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse' })));
  act(() => void el.dispatchEvent(new MouseEvent('mouseup', at)));
  act(() => void el.dispatchEvent(new MouseEvent('click', { ...at, detail: 1 })));
}
/** One finger's touch event at (x, y), as a phone sends it. */
function finger(target: Element, type: 'touchstart' | 'touchmove' | 'touchend', x = 40, y = 20): Event {
  const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  act(() => void target.dispatchEvent(event));
  return event;
}
/**
 * A finger on `el` for `holdMs`, as a phone's browser reports it: pointerdown and touchstart, a drift to `moveTo` (a
 * scroll's start) when given, the lift (touchend, pointerup), then the mouse events and the click a browser makes of a
 * touch that did not move (`click` false: none, as after a scroll). Returns the touchstart and touchend events.
 */
async function fingerOn(el: Element, holdMs: number, { moveTo, click = !moveTo }: { moveTo?: [number, number]; click?: boolean } = {}) {
  const at = { bubbles: true, cancelable: true, clientX: 40, clientY: 20, pointerType: 'touch', isPrimary: true, pointerId: 7 };
  act(() => void el.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 })));
  const start = finger(el, 'touchstart');
  if (moveTo) {
    await wait(Math.min(100, holdMs));
    finger(el, 'touchmove', ...moveTo);
    act(() => void el.dispatchEvent(new PointerEvent('pointercancel', at)));
    await wait(Math.max(0, holdMs - 100));
  } else await wait(holdMs);
  const end = finger(el, 'touchend', ...(moveTo ?? [40, 20]));
  if (!moveTo) act(() => void el.dispatchEvent(new PointerEvent('pointerup', at)));
  let clicked: MouseEvent | null = null;
  if (click) {
    const mouse = { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 20 };
    act(() => void el.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 })));
    act(() => void el.dispatchEvent(new MouseEvent('mouseup', mouse)));
    clicked = new MouseEvent('click', { ...mouse, detail: 1 });
    act(() => void el.dispatchEvent(clicked!));
  }
  return { start, end, clicked };
}

test.skipIf(!hasDom)('a right-click anywhere on a band (the band itself, its count, its chevron, the tip’s spot) opens its menu and never toggles it; a left click anywhere on it toggles it', async () => {
  if (!hasDom) return;
  draw();
  for (const [part, el] of bandParts('new')) {
    const expanded = band('new').getAttribute('aria-expanded');
    const event = mouseRight(el);
    await settle();
    expect([part, event.defaultPrevented, bandMenu()?.getAttribute('data-band-menu')]).toEqual([part, true, 'new']);
    expect([part, band('new').getAttribute('aria-expanded')]).toEqual([part, expanded]);
    await closeMenu();
  }
  for (const [part, el] of bandParts('new')) {
    const expanded = band('new').getAttribute('aria-expanded');
    mouseLeft(el);
    await settle();
    expect([part, band('new').getAttribute('aria-expanded')]).toEqual([part, expanded === 'true' ? 'false' : 'true']);
    expect(bandMenu()).toBeNull();
  }
});

test.skipIf(!hasDom)('a phone: a tap on a band toggles it at its click, with nothing held back (no menu, ever); the hold is LONG_PRESS_MS, the rows’ own', async () => {
  if (!hasDom) return;
  draw(false, SECTIONS, true);
  // The rows and the bands share one menu and one hold: the trigger's LONG_PRESS_MS (450 ms).
  expect(LONG_PRESS_MS).toBe(450);
  const expanded = band('new').getAttribute('aria-expanded');
  const tap = await fingerOn(band('new'), 90);
  // Nothing cancels the browser's own click (a cancelled touchstart or touchend would), and the click toggles at once.
  expect(tap.start.defaultPrevented).toBe(false);
  expect(tap.end.defaultPrevented).toBe(false);
  expect(tap.clicked!.defaultPrevented).toBe(false);
  expect(band('new').getAttribute('aria-expanded')).not.toBe(expanded);
  await wait(LONG_PRESS_MS + 100);
  expect(bandMenu()).toBeNull();
  // Just short of the hold: still a tap.
  const short = await fingerOn(band('new'), LONG_PRESS_MS - 120);
  expect(short.clicked!.defaultPrevented).toBe(false);
  expect(band('new').getAttribute('aria-expanded')).toBe(expanded);
  await wait(200);
  expect(bandMenu()).toBeNull();
});

test.skipIf(!hasDom)('a phone: a hold opens the sheet and its lift does not toggle the band; once the sheet is closed by a tap outside, the next tap on the band toggles it', async () => {
  if (!hasDom) return;
  calls.length = 0;
  draw(false, SECTIONS, true);
  const expanded = band('new').getAttribute('aria-expanded');
  const hold = await fingerOn(band('new'), LONG_PRESS_MS + 120);
  expect(bandMenu()?.getAttribute('data-band-menu')).toBe('new');
  expect(bandMenu()!.closest('[data-phone]')).not.toBeNull();
  expect(hold.clicked!.defaultPrevented).toBe(true);
  expect(band('new').getAttribute('aria-expanded')).toBe(expanded);
  expect(calls).toEqual([]);
  // A tap outside the sheet (on the page under its scrim) closes it.
  await wait(150);
  await fingerOn(document.body, 80);
  await settle();
  expect(bandMenu()).toBeNull();
  expect(calls).toEqual([]);
  // The very next tap on the band is a tap again.
  const tap = await fingerOn(band('new'), 80);
  expect(tap.clicked!.defaultPrevented).toBe(false);
  expect(band('new').getAttribute('aria-expanded')).not.toBe(expanded);
  expect(bandMenu()).toBeNull();
});

test.skipIf(!hasDom)('a phone: a finger that moves (a scroll) opens nothing and toggles nothing, however long it stays; a quick double tap opens no sheet', async () => {
  if (!hasDom) return;
  draw(false, SECTIONS, true);
  const expanded = band('new').getAttribute('aria-expanded');
  // Down on the band, then the list scrolls under it: past the slop, held well past the hold's time.
  await fingerOn(band('new'), LONG_PRESS_MS + 300, { moveTo: [40, 60] });
  expect(bandMenu()).toBeNull();
  expect(band('new').getAttribute('aria-expanded')).toBe(expanded);
  // Two quick taps: each is a tap (as on main, the band toggles twice), and no sheet comes after.
  await fingerOn(band('new'), 70);
  await wait(60);
  await fingerOn(band('new'), 70);
  expect(band('new').getAttribute('aria-expanded')).toBe(expanded);
  await wait(LONG_PRESS_MS + 100);
  expect(bandMenu()).toBeNull();
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

/** The Group tip's host as App hands it (bandTip.ts): due, with a claim the Inbox grants once, and `used` heard. */
function tipWorld(busy = () => false, due = true) {
  const claims: number[] = [];
  used.length = 0;
  let granted = false;
  tipHost = {
    due,
    busy: () => busy(),
    claim: async () => {
      claims.push(Date.now());
      const ok = !granted;
      granted = true;
      return ok;
    },
    used: () => void used.push(Date.now()),
  };
  // Short times, so each test runs the real rules quickly (afterEach puts them back).
  BAND_TIP_TIMES.restMs = 60;
  BAND_TIP_TIMES.phoneViewMs = 120;
  return claims;
}
/** The "a band's menu opened" retirements the Inbox heard (`used`). */
const used: number[] = [];
// React's onPointerEnter listens for pointerover with where the pointer came from; onPointerLeave, pointerout.
const point = (el: Element, pointerType = 'mouse') => act(() => void el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType, relatedTarget: document.body })));
const unpoint = (el: Element) => act(() => void el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })));
/** The pointer comes onto the band and rests there past BAND_TIP_TIMES.restMs. */
async function rest(el: Element) {
  point(el);
  await wait(BAND_TIP_TIMES.restMs + 40);
  await settle();
}
const tipText = () => [...document.querySelectorAll('[data-pn-tooltip]')].map((el) => el.textContent).join('|');
/** The band the shown tip hangs on, and where on it: covering no row, it sits on the band (GroupBand.tsx). */
const tipAt = () => {
  const anchor = document.querySelector('.ib-band-tipat[data-popup-open]');
  return anchor ? { band: anchor.closest('[data-section-id]')?.getAttribute('data-section-id'), inBand: anchor.parentElement?.matches('button.ib-band'), end: anchor.hasAttribute('data-end') } : null;
};
/** No tip bubble is drawn empty: one still there while it fades out keeps its words. */
const noEmptyBubble = () => [...document.querySelectorAll('[data-pn-tooltip]')].every((el) => (el.textContent ?? '').trim() !== '');

test.skipIf(!hasDom)('the Group tip: a pointer that rests on a band with a menu shows "Right-click for group actions" once, on the band after its name; a press takes it away; never again', async () => {
  if (!hasDom) return;
  const claims = tipWorld();
  draw();
  // A band with no menu (Snoozed) asks nothing.
  await rest(band('snoozed'));
  expect(claims).toHaveLength(0);
  await rest(band('new'));
  expect(claims).toHaveLength(1);
  expect(tipText()).toBe('Right-click for group actions');
  // On the band, just after its name and count: never over the first row.
  expect(tipAt()).toEqual({ band: 'new', inBand: true, end: false });
  act(() => void window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle();
  expect(tipAt()).toBeNull();
  expect(noEmptyBubble()).toBe(true);
  await rest(band('waiting'));
  expect(claims).toHaveLength(1);
  expect(tipAt()).toBeNull();
});

test.skipIf(!hasDom)('the Group tip: a pointer only crossing a band spends nothing; it shows after a rest and goes when the pointer leaves, as a tooltip does', async () => {
  if (!hasDom) return;
  const claims = tipWorld();
  draw();
  point(band('waiting'));
  await wait(BAND_TIP_TIMES.restMs / 2);
  unpoint(band('waiting'));
  point(band('new'));
  await wait(BAND_TIP_TIMES.restMs / 2);
  unpoint(band('new'));
  await wait(BAND_TIP_TIMES.restMs + 40);
  expect(claims).toHaveLength(0);
  expect(tipAt()).toBeNull();
  await rest(band('new'));
  expect(claims).toHaveLength(1);
  expect(tipAt()?.band).toBe('new');
  unpoint(band('new'));
  await settle();
  expect(tipAt()).toBeNull();
  expect(noEmptyBubble()).toBe(true);
});

test.skipIf(!hasDom)('the Group tip: a band’s menu opened first retires it for good (`used`, never a claim); a hover after shows nothing', async () => {
  if (!hasDom) return;
  const claims = tipWorld();
  draw();
  await rightClick(band('new'));
  expect(bandMenu()).not.toBeNull();
  expect(used).toHaveLength(1);
  await closeMenu();
  await rightClick(band('waiting'));
  await closeMenu();
  // Once per page.
  expect(used).toHaveLength(1);
  await rest(band('waiting'));
  expect(claims).toHaveLength(0);
  expect(tipAt()).toBeNull();
});

test.skipIf(!hasDom)('the Group tip: opening a band’s menu retires it even when it is not due yet (the first day, a dialog’s gap): the Inbox stamps it then', async () => {
  if (!hasDom) return;
  const claims = tipWorld(() => false, false);
  draw();
  await rest(band('new'));
  expect(claims).toHaveLength(0);
  await rightClick(band('new'));
  expect(bandMenu()).not.toBeNull();
  expect(used).toHaveLength(1);
});

test.skipIf(!hasDom)('the Group tip: a short touch (a 200 ms tap) or a paused scroll on a band retires nothing; only a hold that opens the menu does', async () => {
  if (!hasDom) return;
  const claims = tipWorld();
  draw(false, SECTIONS, true);
  // The press takes its look 120 ms in; a tap of 200 ms is still a tap.
  await fingerOn(band('new'), 200);
  // A finger that rests, then scrolls on.
  await fingerOn(band('waiting'), 600, { moveTo: [40, 80] });
  expect(bandMenu()).toBeNull();
  expect(used).toHaveLength(0);
  // A hold that lasts opens the sheet: that retires it.
  await fingerOn(band('new'), LONG_PRESS_MS + 100);
  expect(bandMenu()).not.toBeNull();
  expect(used).toHaveLength(1);
  expect(claims).toHaveLength(0);
});

test.skipIf(!hasDom)('the Group tip: not while picking rows, not while another one-time thing is up; the next rest after is the one', async () => {
  if (!hasDom) return;
  let reveal = true;
  const claims = tipWorld(() => reveal);
  draw();
  await rest(band('new'));
  expect(claims).toHaveLength(0);
  reveal = false;
  act(() => void rowEl('n1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
  await rest(band('waiting'));
  expect(claims).toHaveLength(0);
  act(() => host!.querySelector<HTMLButtonElement>('[data-pick-done]')!.click());
  await rest(band('waiting'));
  expect(claims).toHaveLength(1);
  expect(tipText()).toBe('Right-click for group actions');
});

/** Band rects as a phone lays them out (happy-dom draws none): `top` by section, 44 px tall, in a 390 × 844 window. */
function layBands(tops: Record<string, number>): () => void {
  const proto = HTMLElement.prototype;
  const real = proto.getBoundingClientRect;
  const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const id = this.matches('button.ib-band') ? this.parentElement?.getAttribute('data-section-id') : null;
    const top = id ? tops[id] : undefined;
    return top === undefined ? real.call(this) : ({ top, bottom: top + 44, left: 0, right: 390, width: 390, height: 44, x: 0, y: top } as DOMRect);
  };
  return () => {
    proto.getBoundingClientRect = real;
    if (innerHeight) Object.defineProperty(window, 'innerHeight', innerHeight);
  };
}

test.skipIf(!hasDom)('the Group tip on a phone: the list held still shows "Hold a group for actions" inside the first band on screen, at its right end; a touch first waits again', async () => {
  if (!hasDom) return;
  // Scrolled: the Waiting band is above the window, New is on screen.
  const tops: Record<string, number> = { waiting: -300, new: 200, snoozed: 600 };
  const unlay = layBands(tops);
  try {
    const claims = tipWorld();
    draw(false, SECTIONS, true);
    await wait(80);
    // A touch (a scroll's start, a swipe) before the wait is over: the wait starts again.
    act(() => void window.dispatchEvent(new Event('touchstart')));
    await wait(80);
    expect(claims).toHaveLength(0);
    await wait(120);
    expect(claims).toHaveLength(1);
    expect(tipText()).toBe('Hold a group for actions');
    expect(tipAt()).toEqual({ band: 'new', inBand: true, end: true });
    // A touch takes it away.
    act(() => void window.dispatchEvent(new Event('touchstart')));
    await settle();
    expect(tipAt()).toBeNull();
  } finally {
    unlay();
  }
});

test.skipIf(!hasDom)('the Group tip on a phone: no band with a menu on screen, no tip yet; once one scrolls into view and the list holds still, it shows there', async () => {
  if (!hasDom) return;
  const tops: Record<string, number> = { waiting: -300, new: -200, snoozed: 300 };
  const unlay = layBands(tops);
  try {
    const claims = tipWorld();
    draw(false, SECTIONS, true);
    await wait(300);
    expect(claims).toHaveLength(0);
    tops.new = 100;
    act(() => void window.dispatchEvent(new Event('scroll')));
    await wait(200);
    expect(claims).toHaveLength(1);
    expect(tipAt()?.band).toBe('new');
  } finally {
    unlay();
  }
});

test.skipIf(!hasDom)('the Group tip on a phone: never while a thread covers the list (it waits, unclaimed, and shows over no thread); once the list is back it may', async () => {
  if (!hasDom) return;
  // The bands are laid out on screen (the list is drawn, under the thread).
  const unlay = layBands({ waiting: 100, new: 300, snoozed: 600 });
  try {
    const claims = tipWorld();
    draw(false, SECTIONS, true, true);
    await wait(400);
    expect(claims).toHaveLength(0);
    expect(tipText()).toBe('');
    // Back on the list.
    draw(false, SECTIONS, true, false);
    await wait(200);
    expect(claims).toHaveLength(1);
    expect(tipAt()?.band).toBe('waiting');
    // A thread opens over it: the tip goes at once.
    draw(false, SECTIONS, true, true);
    await settle();
    expect(tipAt()).toBeNull();
  } finally {
    unlay();
  }
});
