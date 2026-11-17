/**
 * The sidebar's "Plans" row shows only while Plans is on (App passes `onPlans` only then), second under Inbox, with
 * the number of plans changed since you looked; off, it is in neither the sidebar nor its menu and Customize panel.
 * What regresses: a trace of Plans while it is off (the owner: nothing of it shows), a row in the wrong place, a
 * count that is not "changed since you looked", or a row that does not open the page; and a window already open when
 * Plans is turned on or off (`plannotator plans` in a terminal, saved through the Inbox) that does not follow until a
 * reload: the row must come with `event: capabilities` naming Plans on, and go with the frame naming it off, taking a
 * window on `#plans` back to the Inbox.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanSummary } from '@plannotator/core/plans';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('../components/Sidebar') : {}) as typeof import('../components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { drawnSidebarItems } = (hasDom ? await import('../sidebarItems') : {}) as typeof import('../sidebarItems');
const { resetPlansForTests, usePlansOn } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { PlansRoute } = (hasDom ? await import('./PlansPage') : {}) as typeof import('./PlansPage');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { dispatchInboxFrame } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { namesCapability, withCapabilities } = (hasDom ? await import('../capabilities') : {}) as typeof import('../capabilities');
const { writeSidebarLayout, readSidebarLayout, adoptSavedSidebar, resetSidebarLayoutForTests, SIDEBAR_LAYOUT_COOKIE } = (hasDom ? await import('../sidebarLayout') : {}) as typeof import('../sidebarLayout');
const { setPlansOn } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { setStorageBackend, resetStorageBackend } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');
const { INBOX_SIDEBAR_DEFAULT } = (hasDom ? await import('@plannotator/core/inbox-sidebar') : {}) as typeof import('@plannotator/core/inbox-sidebar');

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  if (hasDom) resetPlansForTests();
});

const summary = (id: string, changed: boolean): PlanSummary => ({
  id,
  name: id,
  project_id: null,
  project_name: 'api',
  status: 'active',
  created_at: '2026-11-01T09:00:00.000Z',
  updated_at: '2026-11-02T09:00:00.000Z',
  primary_doc_id: 'doc_01JD0000000000000000000000',
  head_version_number: 3,
  decision: null,
  counts: { documents: 1, versions: 3, comments: 0, artifacts: 0, events: 0 },
  looked_at: changed ? '2026-11-01T10:00:00.000Z' : null,
  seen_version_number: changed ? 1 : null,
  changed,
});

function sidebar(onPlans: (() => void) | undefined, page: 'inbox' | 'plans' = 'inbox'): HTMLElement {
  const noop = () => {};
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar page={page} projectId={null} inboxCount={0} projects={[]} projectCounts={new Map()} update={null} restarting={false} updated={null} onInbox={noop} onProject={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} onBoard={noop} onPlans={onPlans} />
      </SidebarProvider>,
    ),
  );
  return host;
}

test.skipIf(!hasDom)('off: no Plans row, and nothing of it in the menu or Customize; on: the row second under Inbox, and it opens the page', () => {
  resetPlansForTests(null, false);
  let host = sidebar(undefined);
  expect(host.querySelector('[data-plans-nav]')).toBeNull();
  expect(host.textContent).not.toContain('Plans');
  expect(host.textContent).not.toContain('Spaces');
  expect(drawnSidebarItems({ board: true, reviews: true, shape: true, usage: true, phone: false }).has('plans')).toBe(false);
  expect(drawnSidebarItems({ board: true, plans: false, reviews: true, shape: true, usage: true, phone: false }).has('plans')).toBe(false);
  act(() => root?.unmount());
  document.body.innerHTML = '';

  let opened = 0;
  host = sidebar(() => opened++);
  const row = host.querySelector<HTMLButtonElement>('[data-plans-nav]')!;
  expect(row).not.toBeNull();
  const items = [...host.querySelectorAll('[data-sidebar-item]')].map((el) => el.getAttribute('data-sidebar-item'));
  expect(items.indexOf('plans')).toBe(items.indexOf('inbox') + 1);
  expect(drawnSidebarItems({ board: true, plans: true, reviews: true, shape: true, usage: true, phone: false }).has('plans')).toBe(true);
  act(() => row.click());
  expect(opened).toBe(1);
});

test.skipIf(!hasDom)('its number is the plans changed since you looked; on its page it is the current row', () => {
  resetPlansForTests([summary('pln_a', true), summary('pln_b', false), summary('pln_c', true)], true);
  const host = sidebar(() => {}, 'plans');
  const row = host.querySelector('[data-plans-nav]')!;
  expect(row.querySelector('.ib-n')?.textContent).toBe('2');
  expect(row.querySelector('.ib-n')?.getAttribute('aria-label')).toBe('2 changed since you looked');
  expect(row.getAttribute('aria-current')).toBe('page');
  expect(host.querySelector('[data-inbox-nav]')?.getAttribute('aria-current')).toBeNull();
});

test.skipIf(!hasDom)('a window already open follows `plannotator plans` live: on, the row comes; off, it goes and #plans goes back to the Inbox', async () => {
  resetPlansForTests(null, false);
  window.history.replaceState(null, '', '/');
  globalThis.fetch = (async () => Response.json({ plans: [summary('pln_a', true)], importing: false })) as unknown as typeof fetch;
  type Held = { serverSession: string; board: { on: boolean }; plans?: { on: boolean } };
  let hearFrame: (data: string) => void = () => {};
  // What App does: settings held in state, `event: capabilities` merged into them, the row and the page from them.
  function Window() {
    const [settings, setSettings] = useState<Held>({ serverSession: 's', board: { on: false } });
    const [route, setRoute] = useState(readRoute());
    useEffect(() => {
      const moved = () => setRoute(readRoute());
      window.addEventListener('hashchange', moved);
      return () => window.removeEventListener('hashchange', moved);
    }, []);
    hearFrame = (data) =>
      dispatchInboxFrame({ name: 'capabilities', id: null, data }, {
        onRecord: () => {},
        onStatus: () => {},
        onCapabilities: (capabilities) => {
          if (namesCapability(capabilities)) setSettings((current) => withCapabilities(current, capabilities));
        },
      });
    const plansOn = usePlansOn(settings);
    const noop = () => {};
    return (
      <SidebarProvider>
        <Sidebar page={route.page === 'plans' ? 'plans' : 'inbox'} projectId={null} inboxCount={0} projects={[]} projectCounts={new Map()} update={null} restarting={false} updated={null} onInbox={noop} onProject={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} onBoard={noop} onPlans={plansOn ? () => (window.location.hash = '#plans') : undefined} />
        {route.page === 'plans' && <PlansRoute route={route} on={plansOn} settingsKnown phone={false} />}
      </SidebarProvider>
    );
  }
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Window />));
  const settle = async () => {
    for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 5)));
  };
  expect(host.querySelector('[data-plans-nav]')).toBeNull();

  // `plannotator plans`: the Inbox saved it and told every window (the frame as inbox.ts sends it).
  act(() => hearFrame(JSON.stringify({ board: { on: false }, steps: { on: true }, plans: { on: true } })));
  await settle();
  const row = host.querySelector<HTMLButtonElement>('[data-plans-nav]');
  expect(row).not.toBeNull();
  expect(row!.querySelector('.ib-n')?.textContent).toBe('1');
  act(() => row!.click());
  await settle();
  expect(window.location.hash).toBe('#plans');
  expect(host.querySelector('[data-plans-nav]')?.getAttribute('aria-current')).toBe('page');

  // A frame for another switch leaves Plans as it is.
  act(() => hearFrame(JSON.stringify({ board: { on: true }, steps: { on: true }, plans: { on: true } })));
  await settle();
  expect(host.querySelector('[data-plans-nav]')).not.toBeNull();

  // `plannotator plans off`: the row goes, and the window on #plans goes back to the Inbox.
  act(() => hearFrame(JSON.stringify({ board: { on: true }, steps: { on: true }, plans: { on: false } })));
  await settle();
  expect(host.querySelector('[data-plans-nav]')).toBeNull();
  expect(window.location.hash).toBe('');
  expect(host.textContent).not.toContain('Plans');
  expect(host.textContent).not.toContain('Spaces');
});

test.skipIf(!hasDom)('`plannotator plans` with a window open: the show frame names the Plans page for that window, never a thread', () => {
  const heard: [string, string, string | undefined][] = [];
  const handlers = { onRecord: () => {}, onStatus: () => {}, onShow: (thread: string, target: string, page?: 'plans') => void heard.push([thread, target, page]) };
  dispatchInboxFrame({ name: 'show', id: null, data: JSON.stringify({ page: 'plans', window: 'w1' }) }, handlers);
  dispatchInboxFrame({ name: 'show', id: null, data: JSON.stringify({ page: 'elsewhere', window: 'w1' }) }, handlers);
  dispatchInboxFrame({ name: 'show', id: null, data: JSON.stringify({ thread_id: 'thr_1', window: 'w1' }) }, handlers);
  expect(heard).toEqual([['', 'w1', 'plans'], ['thr_1', 'w1', undefined]]);
});

test.skipIf(!hasDom)('off, Plans is never kept in the cookie; the save sends the layout whole (the server leaves an off Plans out); on, with it', async () => {
  const saved: { top: string[]; bottom: string[]; hidden: string[] }[] = [];
  const cookie = new Map<string, string>();
  setStorageBackend({ getItem: (k) => cookie.get(k) ?? null, setItem: (k, v) => void cookie.set(k, v), removeItem: (k) => void cookie.delete(k) });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const sidebar = (JSON.parse(init?.body ?? '{}') as { sidebar: { top: string[]; bottom: string[]; hidden: string[] } }).sidebar;
    saved.push(sidebar);
    return Response.json({ sidebar, sidebar_rev: saved.length });
  }) as unknown as typeof fetch;
  try {
    resetSidebarLayoutForTests();
    resetPlansForTests(null, false);
    // A person who never turned Plans on hides Feedback: this browser's cookie names nothing of Plans. What the
    // server stores is its own rule (packages/server/inbox-sidebar-save.test.ts).
    await writeSidebarLayout({ ...INBOX_SIDEBAR_DEFAULT, hidden: ['feedback'] });
    expect(saved.at(-1)!.hidden).toEqual(['feedback']);
    expect(cookie.get(SIDEBAR_LAYOUT_COOKIE)).not.toContain('plans');

    // Plans on: its row is part of the layout saved and of the cookie.
    setPlansOn(true);
    await writeSidebarLayout({ ...INBOX_SIDEBAR_DEFAULT, hidden: ['copy-prompt'] });
    expect(saved.at(-1)!.top.indexOf('plans')).toBe(saved.at(-1)!.top.indexOf('inbox') + 1);
    expect(cookie.get(SIDEBAR_LAYOUT_COOKIE)).toContain('plans');
  } finally {
    setPlansOn(false);
    resetSidebarLayoutForTests();
    resetStorageBackend();
  }
});

test.skipIf(!hasDom)('Plans on, its row hidden on the desktop: a window that never heard Plans is on (a phone) saves another change, and the row stays hidden', async () => {
  const saved: { top: string[]; bottom: string[]; hidden: string[] }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const sidebar = (JSON.parse(init?.body ?? '{}') as { sidebar: { top: string[]; bottom: string[]; hidden: string[] } }).sidebar;
    saved.push(sidebar);
    return Response.json({ sidebar, sidebar_rev: 1 + saved.length });
  }) as unknown as typeof fetch;
  try {
    resetSidebarLayoutForTests();
    // The phone's page: Plans not heard (its settings never name it); the server's layout read, Plans hidden and moved last.
    resetPlansForTests(null, false);
    const server = { ...INBOX_SIDEBAR_DEFAULT, top: [...INBOX_SIDEBAR_DEFAULT.top.filter((id) => id !== 'plans'), 'plans'], hidden: ['plans'] };
    adoptSavedSidebar(server, 1);
    const now = readSidebarLayout();
    await writeSidebarLayout({ ...now, hidden: [...now.hidden, 'feedback'] });
    expect(saved.at(-1)!.hidden).toEqual(['plans', 'feedback']);
    expect(saved.at(-1)!.top.at(-1)).toBe('plans');
  } finally {
    resetSidebarLayoutForTests();
  }
});
