/**
 * Picking thread rows on the window's own InboxList (approval "inbox-multi-select", 1B + 2A): ⌘ and a click picks a
 * row and opens nothing; Shift and a click picks the rows between, in the order drawn; while picking a plain click
 * picks; the header is the bar ("2 selected", said by a live region), the rows say they are pressed, and a picked row
 * draws again with its fill (the row memo compares `picked`); the bar's Archive takes the picked rows and ends
 * picking; Escape and Done leave; the row menu's Select starts picking with that row; a picked row's menu acts on all
 * the picks; another scope ends picking.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';
import type { BulkWrites } from './bulkWrites';

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

const AGO = '2026-10-10T10:00:00.000Z';
function row(id: string, section: InboxSectionId = 'waiting'): InboxListRow {
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
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'alpha' },
    thread_name: null,
    section,
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    priority: null,
  } as InboxListRow;
}

const SECTIONS: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: ['a', 'b', 'c', 'd'].map((id) => row(id)) }];

const calls: { what: string; ids: string[] }[] = [];
const bulk = {
  archive: async (rows: readonly InboxListRow[]) => void calls.push({ what: 'archive', ids: rows.map((r) => r.thread_id) }),
  snooze: async (rows: readonly InboxListRow[]) => void calls.push({ what: 'snooze', ids: rows.map((r) => r.thread_id) }),
  markRead: async (rows: readonly InboxListRow[]) => void calls.push({ what: 'read', ids: rows.map((r) => r.thread_id) }),
  markUnread: async () => {},
  star: async (rows: readonly InboxListRow[], on: boolean) => void calls.push({ what: on ? 'star' : 'unstar', ids: rows.map((r) => r.thread_id) }),
  priority: async () => {},
} as unknown as BulkWrites;

let opened: string[] = [];
function draw(scope: string | null = null): void {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} scope={scope} sections={SECTIONS} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={(r) => void opened.push(r.thread_id)} onRowAction={() => {}} bulk={bulk} pinned={new Set()} />
        </div>
      </SidebarProvider>,
    );
  });
}

const rowEl = (id: string) => host!.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`)!;
const bar = () => host!.querySelector<HTMLElement>('[data-pick-bar]');
const count = () => host!.querySelector<HTMLElement>('[data-pick-bar] [role="status"]')?.textContent ?? null;
const press = (id: string, init: MouseEventInit = {}) => act(() => void rowEl(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })));
const pressed = () => [...host!.querySelectorAll('.ib-lbody [data-thread-id][aria-pressed="true"]')].map((el) => el.getAttribute('data-thread-id'));
const escape = () => act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
const menu = () => document.querySelector<HTMLElement>('[data-row-menu]');
async function rightClick(id: string) {
  await act(async () => {
    rowEl(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  for (let i = 0; i < 40 && !menu(); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
}

test.skipIf(!hasDom)('⌘ and a click picks a row and opens nothing; Shift picks the rows between; the bar counts them aloud', () => {
  if (!hasDom) return;
  opened = [];
  draw();
  expect(bar()).toBeNull();
  press('a', { metaKey: true });
  expect(opened).toEqual([]);
  expect(count()).toBe('1 selected');
  // The header gives its place to the bar; the rows are toggles now.
  expect(host!.querySelector<HTMLElement>('.ib-lhead:not([data-pick-bar])')!.hidden).toBe(true);
  expect(pressed()).toEqual(['a']);
  press('c', { shiftKey: true });
  expect(pressed()).toEqual(['a', 'b', 'c']);
  expect(count()).toBe('3 selected');
  // While picking, a plain click picks or lets go.
  press('b');
  expect(pressed()).toEqual(['a', 'c']);
  expect(opened).toEqual([]);
  // Ctrl works as ⌘ does (Windows and Linux).
  press('d', { ctrlKey: true });
  expect(pressed()).toEqual(['a', 'c', 'd']);
});

test.skipIf(!hasDom)('a picked row draws again with its fill, and only it: the row memo compares picked', () => {
  if (!hasDom) return;
  draw();
  const before = rowEl('b');
  press('a', { metaKey: true });
  expect(rowEl('a').classList.contains('ib-picked')).toBe(true);
  expect(rowEl('b').classList.contains('ib-picked')).toBe(false);
  press('a');
  expect(rowEl('a').classList.contains('ib-picked')).toBe(false);
  // The row's box sits beside its button, never inside it.
  expect(rowEl('b').querySelector('[data-pick-box]')).toBeNull();
  expect(rowEl('b').parentElement!.querySelector(':scope > [data-pick-box="row"]')!.getAttribute('aria-label')).toBe('Select Thread b');
  expect(rowEl('b')).toBe(before);
});

test.skipIf(!hasDom)('Archive takes every picked row at once and ends picking; Escape and Done leave, the thread list as it was', () => {
  if (!hasDom) return;
  calls.length = 0;
  draw();
  press('a', { metaKey: true });
  press('b', { metaKey: true });
  act(() => bar()!.querySelector<HTMLElement>('[data-bulk-action="archive"]')!.click());
  expect(calls).toEqual([{ what: 'archive', ids: ['a', 'b'] }]);
  expect(bar()).toBeNull();
  press('c', { metaKey: true });
  escape();
  expect(bar()).toBeNull();
  expect(pressed()).toEqual([]);
  press('d', { metaKey: true });
  act(() => bar()!.querySelector<HTMLElement>('[data-pick-done]')!.click());
  expect(bar()).toBeNull();
  // Outside picking a click opens again.
  opened = [];
  press('a');
  expect(opened).toEqual(['a']);
});

test.skipIf(!hasDom)('when picking ends from the bar, focus goes to the list: the row after the last pick, not the page', async () => {
  if (!hasDom) return;
  draw();
  press('a', { metaKey: true });
  press('b', { metaKey: true });
  const archive = bar()!.querySelector<HTMLElement>('[data-bulk-action="archive"]')!;
  archive.focus();
  act(() => archive.click());
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
  expect(document.activeElement?.closest('[data-thread-id]')?.getAttribute('data-thread-id')).toBe('c');
  press('d', { metaKey: true });
  const done = bar()!.querySelector<HTMLElement>('[data-pick-done]')!;
  done.focus();
  act(() => done.click());
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
  // Nothing after the last pick: the pick itself.
  expect(document.activeElement?.closest('[data-thread-id]')?.getAttribute('data-thread-id')).toBe('d');
});

test.skipIf(!hasDom)('the box over every row picks them all, then lets them all go; nothing picked, the bar says how to pick', () => {
  if (!hasDom) return;
  draw();
  press('a', { metaKey: true });
  const all = () => bar()!.querySelector<HTMLElement>('[aria-label="Select all"]')!;
  expect(all().getAttribute('aria-checked')).toBe('mixed');
  act(() => all().click());
  expect(count()).toBe('4 selected');
  act(() => all().click());
  expect(count()).toBe('Click threads to select them');
  expect(bar()).not.toBeNull();
});

test.skipIf(!hasDom)('the row menu: Select starts picking with the row; a picked row’s menu acts on every pick', async () => {
  if (!hasDom) return;
  calls.length = 0;
  draw();
  await rightClick('b');
  expect(menu()!.querySelector('[data-row-action="select"]')!.textContent).toBe('Select');
  await act(async () => menu()!.querySelector<HTMLElement>('[data-row-action="select"]')!.click());
  expect(pressed()).toEqual(['b']);
  press('d');
  await rightClick('d');
  expect(menu()!.getAttribute('aria-label')).toBe('2 selected threads');
  await act(async () => menu()!.querySelector<HTMLElement>('[data-bulk-action="star"]')!.click());
  expect(calls).toEqual([{ what: 'star', ids: ['b', 'd'] }]);
  // Starring keeps the picks, so another action can follow.
  expect(pressed()).toEqual(['b', 'd']);
});

test.skipIf(!hasDom)('another scope (a project, a tag) ends picking', () => {
  if (!hasDom) return;
  draw('prj_1');
  press('a', { metaKey: true });
  expect(bar()).not.toBeNull();
  draw('prj_2');
  expect(bar()).toBeNull();
});
