/**
 * Mark all as read on the window's own InboxList (markAllRead.ts): the button on the "New since you looked" band
 * takes that band's rows only, never a snoozed one, and is gone while picking (the group's box is the header's
 * then); the list's ⋮ offers "Mark all as read" after "Select threads", taking every row the list shows that takes
 * Mark read; the picks' bar shows Mark read as its own button where there is room, and its ⋯ then does not list it
 * again. Mark all as read goes through bulkWrites.ts `markAllRead` (each thread as it is now, the picks' warning, toast
 * and Undo); the bar's button through the picks' Mark read.
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

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
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
];

const calls: { via: 'all' | 'picks'; ids: string[] }[] = [];
const bulk = {
  archive: async () => {},
  snooze: async () => {},
  markRead: async (rows: readonly InboxListRow[]) => (calls.push({ via: 'picks', ids: rows.map((r) => r.thread_id) }), true),
  markAllRead: async (rows: readonly InboxListRow[]) => (calls.push({ via: 'all', ids: rows.map((r) => r.thread_id) }), true),
  markUnread: async () => {},
  star: async () => {},
  priority: async () => {},
  hidePulls: async () => {},
} as unknown as BulkWrites;

const tidy: TidyController = { surface: 'list', scope: null, plan: { serverSession: 's', count: 0, agents: [], run: null } as unknown as InboxTidyPlan as TidyController['plan'], run: null, start: async () => null, refresh: () => {} };

function draw(narrow = false, sections: InboxListSection[] = SECTIONS): void {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} scope={null} sections={sections} filtered={false} narrow={narrow} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} onRowAction={() => {}} bulk={bulk} pinned={new Set()} tidy={tidy} />
        </div>
      </SidebarProvider>,
    );
  });
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
const bandButton = () => host!.querySelector<HTMLButtonElement>('[data-section-id="new"] > [data-band-mark-all-read]');
const rowEl = (id: string) => host!.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`)!;
async function openListMenu() {
  act(() => host!.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  return document.querySelector<HTMLElement>('[data-tidy-menu-popup]')!;
}

test.skipIf(!hasDom)('the New band’s button: icon only, named "Mark all as read", takes that band’s rows and never a snoozed one', () => {
  if (!hasDom) return;
  calls.length = 0;
  draw();
  const button = bandButton()!;
  expect(button).not.toBeNull();
  expect(button.getAttribute('aria-label')).toBe('Mark all as read');
  expect(button.textContent).toBe('');
  // Beside the band, never inside it: the band is the group's toggle.
  expect(button.previousElementSibling!.classList.contains('ib-band')).toBe(true);
  expect(host!.querySelector('[data-section-id="waiting"] > [data-band-mark-all-read]')).toBeNull();
  act(() => button.click());
  expect(calls).toEqual([{ via: 'all', ids: ['n1', 'n3'] }]);
});

test.skipIf(!hasDom)('while picking the band’s button is gone (the group’s box is there); it comes back after Done', () => {
  if (!hasDom) return;
  draw();
  act(() => void rowEl('n1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
  expect(host!.querySelector('[data-pick-bar]')).not.toBeNull();
  expect(bandButton()).toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>('[data-pick-done]')!.click());
  expect(bandButton()).not.toBeNull();
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

test.skipIf(!hasDom)('the band’s button gone after its click (nothing left to take): focus that was on it goes to the band, not the page', async () => {
  if (!hasDom) return;
  draw();
  const button = bandButton()!;
  const read = SECTIONS.map((s) => (s.id === 'new' ? { ...s, threads: s.threads.map((r) => ({ ...r, unread: false, unseen: 0, section: 'quiet' as const, read_at: AGO })) } : s));
  const real = bulk.markAllRead;
  (bulk as { markAllRead: unknown }).markAllRead = async () => {
    draw(false, read);
    return true;
  };
  try {
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => {
      button.click();
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(bandButton()).toBeNull();
    expect(document.activeElement).toBe(host!.querySelector('[data-section-id="new"] > .ib-band'));
  } finally {
    (bulk as { markAllRead: unknown }).markAllRead = real;
  }
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
