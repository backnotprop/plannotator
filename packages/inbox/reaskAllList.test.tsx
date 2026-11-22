/**
 * Re-ask all on the window's own InboxList (markAllRead.ts `bandMenuOf`): a band of open questions (Holding up work,
 * Waiting on you, Stopped on you) has "Re-ask all" in its menu, after Mark all as read and Archive all, and it hands
 * bulkWrites.ts `reaskAll` only that band's rows with a question open that were not asked again already; any other
 * band has no such item. On a phone the held band's sheet has it too.
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

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  resetListGroupsForTests();
});

const AGO = '2026-11-20T07:00:00.000Z';
const qs = (n: number) => ({ open: n, picked: 0, stopped: false, holds_up: n > 0 ? ['the release'] : [], prompt: null, actions: 0 });
function row(id: string, section: InboxListRow['section'], over: Partial<InboxListRow> = {}): InboxListRow {
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
    questions: qs(1),
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
    ...over,
  } as InboxListRow;
}

const SECTIONS: InboxListSection[] = [
  { id: 'holding', label: 'Holding up work', threads: [row('h1', 'holding'), row('h2', 'holding', { reask_pending: true })] },
  { id: 'waiting', label: 'Waiting on you', threads: [row('w1', 'waiting')] },
  { id: 'new', label: 'New since you looked', threads: [row('n1', 'new', { questions: qs(0), unseen: 1 })] },
];

const calls: string[][] = [];
const bulk = {
  markAllRead: async () => true,
  archiveAll: async () => true,
  reaskAll: async (rows: readonly InboxListRow[]) => (calls.push(rows.map((r) => r.thread_id)), true),
} as unknown as BulkWrites;
const tidy: TidyController = { surface: 'list', scope: null, plan: { serverSession: 's', count: 0, agents: [], run: null } as unknown as InboxTidyPlan as TidyController['plan'], run: null, start: async () => null, refresh: () => {} };

function draw(phone = false): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} scope={null} sections={SECTIONS} filtered={false} narrow={false} phone={phone} covered={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} onRowAction={() => {}} bulk={bulk} pinned={new Set()} tidy={tidy} />
        </div>
      </SidebarProvider>,
    );
  });
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
const band = (id: string) => host!.querySelector<HTMLButtonElement>(`[data-section-id="${id}"] > button.ib-band`)!;
const bandMenu = () => document.querySelector<HTMLElement>('[data-band-menu]');
const bandItems = () => [...(bandMenu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((el) => el.textContent);
async function rightClick(el: Element) {
  act(() => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 20 })));
  await settle();
}
async function closeMenu() {
  act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
}

test.skipIf(!hasDom)('a band of open questions has Re-ask all, last; it takes only the rows with a question open not asked again; another band has none', async () => {
  if (!hasDom) return;
  calls.length = 0;
  draw();
  await rightClick(band('holding'));
  expect(bandItems().at(-1)).toBe('Re-ask all');
  act(() => bandMenu()!.querySelector<HTMLElement>('[data-band-action="reask"]')!.click());
  await settle();
  expect(calls).toEqual([['h1']]);
  await rightClick(band('waiting'));
  expect(bandItems()).toContain('Re-ask all');
  await closeMenu();
  await rightClick(band('new'));
  expect(bandItems()).not.toContain('Re-ask all');
});

test.skipIf(!hasDom)('a finger held on a band of open questions: its sheet has Re-ask all', async () => {
  if (!hasDom) return;
  draw(true);
  const target = band('waiting');
  const point = { identifier: 1, clientX: 40, clientY: 20, pageX: 40, pageY: 20, target };
  const start = new Event('touchstart', { bubbles: true, cancelable: true });
  Object.defineProperty(start, 'touches', { value: [point] });
  Object.defineProperty(start, 'changedTouches', { value: [point] });
  act(() => void target.dispatchEvent(start));
  await act(async () => void (await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 80))));
  expect(bandMenu()!.closest('[data-phone]')).not.toBeNull();
  expect(bandItems()).toContain('Re-ask all');
});
