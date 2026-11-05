/**
 * The List view in the list (approval "inbox-list-view", 2026-11-05): its ⋮ menu choice, what List draws, and "N new ·
 * Show" in the header.
 *
 * What this catches: a menu choice a screen reader does not hear as one of two with its state; List hiding a thread
 * the grouped view shows (folded Quiet, Sent) or drawing section bands; a choice forgotten on the next load; the tour
 * following this browser's choice; "N new · Show" back in the list's body, where it pushed every row down when it came.
 * Rows not moving in a real browser (their tops measured before and after news), keyboard steps through List and the
 * phone are proved against the compiled binary by tests/e2e/inbox-list-view.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { TidyController } from './components/Tidy';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_VIEW_COOKIE, resetListViewForTests } = await import('./listView');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  resetListViewForTests();
});

afterEach(() => {
  resetStorageBackend();
  resetListViewForTests();
  if (!hasDom) return;
  unmount();
  document.body.innerHTML = '';
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };
const T = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, '0')}:00Z`;

function row(id: string, last_at: string, section: InboxListRow['section'], extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'billing-svc' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' },
    last_at,
    last_agent_at: last_at,
    last_author: 'agent',
    section,
    unread: section !== 'quiet' && section !== 'sent',
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    ...extra,
  } as unknown as InboxListRow;
}

function sections(byGroup: Partial<Record<InboxListGroupId, InboxListRow[]>>): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id === 'quiet' ? 'Quiet' : id === 'snoozed' ? 'Snoozed' : id, threads: byGroup[id] ?? [] })) as InboxListSection[];
}

const LIST = sections({
  waiting: [row('wait', T(9), 'waiting', { questions: { open: 1, picked: 0, stopped: false, holds_up: [] } } as unknown as Partial<InboxListRow>)],
  new: [row('new2', T(8), 'new'), row('new1', T(3), 'new')],
  sent: [row('sent', T(7), 'sent', { last_author: 'person' })],
  quiet: [row('q2', T(6), 'quiet'), row('q1', T(2), 'quiet')],
  snoozed: [row('zz', T(5), 'new', { snoozed: { until: '2026-11-06T09:00:00Z', at: T(4) } } as unknown as Partial<InboxListRow>)],
});

function render(options: { notice?: { count: number; project?: string | null } | null; rememberLook?: boolean; onShowNew?: () => void } = {}): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <InboxList
          title="Inbox"
          path={null}
          sections={LIST}
          sort={{ epoch: 1, keep: null }}
          filtered={false}
          narrow={false}
          phone={false}
          selectedThreadId={null}
          notice={options.notice ?? null}
          onShowNew={options.onShowNew ?? (() => {})}
          onOpen={() => {}}
          tidy={TIDY}
          rememberLook={options.rememberLook}
        />
      </SidebarProvider>,
    );
  });
  return host;
}

async function openMenu(el: HTMLElement): Promise<HTMLElement> {
  act(() => el.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return document.querySelector<HTMLElement>('[data-tidy-menu-popup]')!;
}

async function pick(popup: HTMLElement, value: 'grouped' | 'list') {
  await act(async () => {
    popup.querySelector<HTMLElement>(`[data-list-view="${value}"]`)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const rowIds = (el: HTMLElement) => [...el.querySelectorAll('.ib-lbody [data-thread-id]')].map((node) => node.getAttribute('data-thread-id'));
const bands = (el: HTMLElement) => [...el.querySelectorAll('.ib-lbody .ib-band')].map((node) => node.closest('[data-section-id]')!.getAttribute('data-section-id'));

describe.skipIf(!hasDom)('the ⋮ menu choice', () => {
  test('two choices a screen reader hears with their state, Grouped chosen in an untouched browser', async () => {
    const popup = await openMenu(render());
    const radios = [...popup.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(['Grouped', 'List']);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    // Under its own label, before the rows' options, as the menu's other groups are.
    const group = radios[0]!.closest('[role="group"]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('View');
    expect(popup.textContent!.indexOf('View')).toBeLessThan(popup.textContent!.indexOf('Rows'));
  });

  test('List draws one run of rows, newest first, no bands but the Snoozed one; every thread the groups show is in it', async () => {
    const el = render();
    // Grouped: Quiet starts folded; open it to count every thread the groups show.
    const grouped = new Set(LIST.filter((s) => s.id !== 'snoozed').flatMap((s) => s.threads.map((r) => r.thread_id)));
    const popup = await openMenu(el);
    await pick(popup, 'list');
    expect(rowIds(el)).toEqual(['wait', 'new2', 'sent', 'q2', 'new1', 'q1']);
    expect(new Set(rowIds(el))).toEqual(grouped);
    expect(bands(el)).toEqual(['snoozed']);
    // The snoozed thread keeps the grouped view's rule: folded in its band.
    expect(el.querySelector('[data-thread-id="zz"]')).toBeNull();
    expect([...popup.querySelectorAll('[role="menuitemradio"]')].map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    // The menu stays open, as a tick leaves it.
    expect(document.querySelector('[data-tidy-menu-popup]')).not.toBeNull();
  });

  test('the choice is remembered: a new load draws List; Grouped again leaves no cookie', async () => {
    let el = render();
    await pick(await openMenu(el), 'list');
    expect(stored.get(LIST_VIEW_COOKIE)).toBe('list');
    unmount();
    resetListViewForTests();
    el = render();
    expect(bands(el)).toEqual(['snoozed']);
    await pick(await openMenu(el), 'grouped');
    expect(stored.has(LIST_VIEW_COOKIE)).toBe(false);
    expect(bands(el)).toEqual(['waiting', 'new', 'sent', 'quiet', 'snoozed']);
  });

  test('the tour draws the groups whatever this browser chose, and offers no choice', () => {
    stored.set(LIST_VIEW_COOKIE, 'list');
    const el = render({ rememberLook: false });
    expect(bands(el)).toContain('quiet');
  });
});

describe.skipIf(!hasDom)('"N new · Show" in the header', () => {
  for (const view of ['grouped', 'list'] as const) {
    test(`beside the title, never in the list's body (${view})`, () => {
      if (view === 'list') stored.set(LIST_VIEW_COOKIE, 'list');
      const shown: number[] = [];
      const el = render({ notice: { count: 2, project: 'docs-site' }, onShowNew: () => shown.push(1) });
      const notice = el.querySelector<HTMLButtonElement>('[data-inbox-notice]')!;
      expect(notice.closest('.ib-lhead')).not.toBeNull();
      expect(el.querySelector('.ib-lbody [data-inbox-notice]')).toBeNull();
      // Right after the title, before the header's buttons.
      expect(notice.closest('[data-tip-trigger], .ib-lhead > *')!.previousElementSibling?.matches('h1, [hidden]')).toBe(true);
      expect(notice.textContent).toBe('2 new in docs-siteShow');
      act(() => notice.click());
      expect(shown).toEqual([1]);
    });
  }
});
