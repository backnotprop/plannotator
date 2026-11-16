/**
 * The sidebar's "Plans" row shows only while Plans is on (App passes `onPlans` only then), second under Inbox, with
 * the number of plans changed since you looked; off, it is in neither the sidebar nor its menu and Customize panel.
 * What regresses: a trace of Plans while it is off (the owner: nothing of it shows), a row in the wrong place, a
 * count that is not "changed since you looked", or a row that does not open the page.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanSummary } from '@plannotator/core/plans';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('../components/Sidebar') : {}) as typeof import('../components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { drawnSidebarItems } = (hasDom ? await import('../sidebarItems') : {}) as typeof import('../sidebarItems');
const { resetPlansForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');

let root: Root | null = null;
afterEach(() => {
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
