/**
 * The Board is off by default (approval "inbox-board", 2026-10-26). Off, the
 * sidebar has no Board row and a `#board` link shows "The Board is off" with
 * the one way on; a page from the tailnet says to turn it on from this
 * computer instead. What regresses: a Board row (or the Board) shown while it
 * is off, or an off page with no way on.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 * The server half (tools/list, `board_off`, cards kept) is
 * packages/server/inbox-board-switch.test.ts; the whole window on the
 * compiled binary is tests/e2e/inbox-board.spec.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { BoardOff } = (hasDom ? await import('./board/BoardOff') : {}) as typeof import('./board/BoardOff');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<SidebarProvider>{node}</SidebarProvider>));
  return host;
}

function sidebar(onBoard: (() => void) | undefined): HTMLElement {
  const noop = () => {};
  return mount(
    <Sidebar
      page="inbox"
      projectId={null}
      inboxCount={0}
      projects={[]}
      projectCounts={new Map()}
      update={null}
      restarting={false}
      updated={null}
      onInbox={noop}
      onProject={noop}
      onSettings={noop}
      onUpdate={noop}
      onWhatsNew={noop}
      onBoard={onBoard}
    />,
  );
}

test.skipIf(!hasDom)('off: no Board row in the sidebar; on: the row, with no count', () => {
  let host = sidebar(undefined);
  expect(host.querySelector('[data-board-nav]')).toBeNull();
  act(() => root?.unmount());
  document.body.innerHTML = '';
  let opened = 0;
  host = sidebar(() => opened++);
  const row = host.querySelector<HTMLButtonElement>('[data-board-nav]')!;
  expect(row).not.toBeNull();
  expect(row.textContent).toBe('Board');
  act(() => row.click());
  expect(opened).toBe(1);
});

test.skipIf(!hasDom)('a #board link while off: the page says so and Turn it on turns it on', () => {
  let turned = 0;
  const host = mount(<BoardOff via="local" onTurnOn={() => turned++} error={null} />);
  expect(host.querySelector('[data-board-view="off"] h2')?.textContent).toBe('The Board is off');
  // Nothing of the Board is drawn: no lanes, no cards, no New card.
  expect(host.querySelector('.ib-lane, [data-card-id], [data-board-new]')).toBeNull();
  const on = host.querySelector<HTMLButtonElement>('[data-board-turn-on]')!;
  act(() => on.click());
  expect(turned).toBe(1);
  // It points to where the same switch lives now: Settings → Capabilities.
  expect(host.querySelector<HTMLAnchorElement>('[data-board-settings-link] a')?.getAttribute('href')).toBe('#settings/capabilities');
  // A component tooltip rule: no native title.
  expect(host.querySelector('[title]')).toBeNull();
});

test.skipIf(!hasDom)('a refused switch is said; a page from the tailnet gets a note, not the button', () => {
  let host = mount(<BoardOff via="local" onTurnOn={() => {}} error="The Board was not turned on. Try again." />);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('The Board was not turned on. Try again.');
  act(() => root?.unmount());
  document.body.innerHTML = '';
  host = mount(<BoardOff via="tailnet" onTurnOn={() => {}} error={null} />);
  expect(host.querySelector('[data-board-turn-on]')).toBeNull();
  expect(host.querySelector('.ib-boff-note')?.textContent).toContain('this computer');
  expect(host.querySelector('[data-board-settings-link]')).toBeNull();
});
