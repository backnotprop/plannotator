/**
 * The sidebar's "Routines" row shows only while the capability is on (App passes `onScheduled` only then),
 * under Inbox beside Board, and opens the page. What regresses: the row shown while the switch is off, or a row
 * that does not open the page.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('../components/Sidebar') : {}) as typeof import('../components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function sidebar(onScheduled: (() => void) | undefined, page: 'inbox' | 'scheduled' = 'inbox'): HTMLElement {
  const noop = () => {};
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar page={page} projectId={null} inboxCount={0} projects={[]} projectCounts={new Map()} update={null} restarting={false} updated={null} onInbox={noop} onProject={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} onBoard={noop} onScheduled={onScheduled} />
      </SidebarProvider>,
    ),
  );
  return host;
}

test.skipIf(!hasDom)('off: no Routines row; on: the row under Board, and it opens the page', () => {
  let host = sidebar(undefined);
  expect(host.querySelector('[data-scheduled-nav]')).toBeNull();
  expect(host.querySelector('[data-board-nav]')).not.toBeNull();
  act(() => root?.unmount());
  document.body.innerHTML = '';

  let opened = 0;
  host = sidebar(() => opened++);
  const row = host.querySelector<HTMLButtonElement>('[data-scheduled-nav]')!;
  expect(row).not.toBeNull();
  expect(row.querySelector('svg[data-icon="scheduled"], svg')).not.toBeNull();
  // Right after Board, in the top stack.
  const items = [...host.querySelectorAll('[data-sidebar-item]')].map((el) => el.getAttribute('data-sidebar-item'));
  expect(items.indexOf('scheduled')).toBe(items.indexOf('board') + 1);
  act(() => row.click());
  expect(opened).toBe(1);
});

test.skipIf(!hasDom)('on its page the row is the current one', () => {
  const host = sidebar(() => {}, 'scheduled');
  expect(host.querySelector('[data-scheduled-nav]')?.getAttribute('aria-current')).toBe('page');
  expect(host.querySelector('[data-inbox-nav]')?.getAttribute('aria-current')).toBeNull();
});
