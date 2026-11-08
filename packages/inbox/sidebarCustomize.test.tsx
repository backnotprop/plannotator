/**
 * Customizing the sidebar (approval "inbox-sidebar-customize"), on the window's own Sidebar and Customize panel:
 * the right-click menu's checkboxes (only items that hide and that this Inbox draws; a tick hides the row at once,
 * keeps the menu open and saves; Reset to default only once changed; nothing that moves), the keyboard's way in
 * (Shift+F10 / the menu key on a focused control) and no menu on a touch; the panel's switches, locks, grip menu,
 * presets, Reset and Escape; an item a capability turns off keeping its place; another window's save arriving; the
 * tour's sidebar ignoring the saved layout. The model itself is packages/core/inbox-sidebar.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxSidebarItem } from '@plannotator/core/inbox-sidebar';
import type { SidebarProps } from './components/Sidebar';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarCustomizer } = (hasDom ? await import('./components/SidebarCustomizer') : {}) as typeof import('./components/SidebarCustomizer');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { drawnSidebarItems } = await import('./sidebarItems');
const { hearSidebarEvent, openSidebarCustomizer, resetSidebarLayoutForTests, SIDEBAR_LAYOUT_COOKIE } = await import('./sidebarLayout');
const { INBOX_SIDEBAR_DEFAULT } = await import('@plannotator/core/inbox-sidebar');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const stored = new Map<string, string>();
const saves: unknown[] = [];
let serverRev = 0;
const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  stored.clear();
  saves.length = 0;
  serverRev = 0;
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  // The settings write: answered with what it saved.
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const sidebar = (JSON.parse(init?.body ?? '{}') as { sidebar: unknown }).sidebar;
    saves.push(sidebar);
    return new Response(JSON.stringify({ sidebar, sidebar_rev: ++serverRev }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  resetSidebarLayoutForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

const noop = () => {};
const BASE: Partial<SidebarProps> = { onSearch: noop, onCompose: noop, onBoard: noop, onFeedback: noop, onDrafts: noop, onShortcuts: noop, draftsCount: 1 };
function draw(over: Partial<SidebarProps> = {}, drawn?: ReadonlySet<InboxSidebarItem>) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const props = { ...BASE, ...over };
  const items = drawn ?? drawnSidebarItems({ board: Boolean(props.onBoard), reviews: Boolean(props.onPulls), shape: false, usage: false, phone: false });
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar
          page="inbox"
          projectId={null}
          inboxCount={3}
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
          {...props}
        />
        <SidebarCustomizer drawn={items} />
      </SidebarProvider>,
    ),
  );
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const item = (id: string) => document.querySelector(`.ib-side [data-sidebar-item="${id}"]`);
const stackOf = (id: string) => (item(id)?.closest('.ib-side-foot') ? 'bottom' : item(id) ? 'top' : null);
const menu = () => document.querySelector<HTMLElement>('[data-sidebar-menu]');
const toggles = () => [...document.querySelectorAll('[data-sidebar-toggle]')].map((el) => el.getAttribute('data-sidebar-toggle'));
const panel = () => document.querySelector<HTMLElement>('[data-sidebar-customizer]');
async function rightClick(el: Element, at = { clientX: 40, clientY: 120 }) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...at });
  await act(async () => void el.dispatchEvent(event));
  return event;
}
async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click');
  await act(async () => (el as HTMLElement).click());
  await flush();
}

test.skipIf(!hasDom)('the right-click menu: a checkbox per item that hides and is drawn, in the sidebar\'s order; Customize; nothing that moves', async () => {
  draw();
  await rightClick(document.querySelector('[data-board-nav]')!);
  expect(menu()).not.toBeNull();
  // No Inbox or Settings (they never hide), no Reviews, Shape or Usage (not drawn here).
  expect(toggles()).toEqual(['logo', 'search', 'new-message', 'board', 'drafts', 'copy-prompt', 'feedback', 'shortcuts', 'theme']);
  const boxes = [...document.querySelectorAll('[data-sidebar-toggle]')];
  expect(boxes.every((box) => box.getAttribute('role') === 'menuitemcheckbox' && box.getAttribute('aria-checked') === 'true')).toBe(true);
  expect(menu()!.textContent).toContain('Customize sidebar…');
  expect(menu()!.textContent).not.toContain('Reset to default');
  expect(menu()!.textContent).not.toMatch(/Move|Hide /);
});

test.skipIf(!hasDom)('a tick hides the row at once, leaves the menu open, saves the layout, and offers Reset; Reset puts it back', async () => {
  draw();
  expect(document.querySelector('[data-feedback-nav]')).not.toBeNull();
  await rightClick(document.querySelector('[data-board-nav]')!);
  await click(document.querySelector('[data-sidebar-toggle="feedback"]'));
  expect(document.querySelector('[data-feedback-nav]')).toBeNull();
  expect(menu()).not.toBeNull();
  expect(document.querySelector('[data-sidebar-toggle="feedback"]')!.getAttribute('aria-checked')).toBe('false');
  expect(saves.at(-1)).toEqual({ ...INBOX_SIDEBAR_DEFAULT, hidden: ['feedback'] });
  // This browser remembers it for the next paint.
  expect(stored.get(SIDEBAR_LAYOUT_COOKIE)).toBe(`${INBOX_SIDEBAR_DEFAULT.top.join(',')};${INBOX_SIDEBAR_DEFAULT.bottom.join(',')};feedback`);
  // The logo and the Settings row's buttons hide too.
  await click(document.querySelector('[data-sidebar-toggle="logo"]'));
  await click(document.querySelector('[data-sidebar-toggle="theme"]'));
  expect(document.querySelector('.ib-brand')).toBeNull();
  expect(document.querySelector('[data-theme-toggle]')).toBeNull();
  expect(document.querySelector('.ib-setrow .ib-nav')).not.toBeNull();
  await click(document.querySelector('[data-sidebar-reset]'));
  expect(document.querySelector('[data-feedback-nav]')).not.toBeNull();
  expect(document.querySelector('.ib-brand')).not.toBeNull();
  expect(saves.at(-1)).toEqual(INBOX_SIDEBAR_DEFAULT);
  expect(stored.has(SIDEBAR_LAYOUT_COOKIE)).toBe(false);
});

test.skipIf(!hasDom)('Shift+F10 or the menu key on a focused control opens the same menu; a touch never does', async () => {
  draw();
  const board = document.querySelector<HTMLElement>('[data-board-nav]')!;
  board.focus();
  // The keyboard's contextmenu has no pointer position.
  const keyed = await rightClick(board, { clientX: 0, clientY: 0 });
  expect(keyed.defaultPrevented).toBe(true);
  expect(menu()).not.toBeNull();
  await act(async () => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await flush();
  expect(menu()).toBeNull();

  const side = document.querySelector('.ib-side')!;
  await act(async () => void side.dispatchEvent(new Event('touchstart', { bubbles: true })));
  const touched = await rightClick(board);
  expect(touched.defaultPrevented).toBe(false);
  expect(menu()).toBeNull();
});

test.skipIf(!hasDom)('"Customize sidebar…" opens the panel, its focus on the title', async () => {
  draw();
  await rightClick(document.querySelector('[data-board-nav]')!);
  await click(document.querySelector('[data-sidebar-customize]'));
  expect(panel()).not.toBeNull();
  expect(panel()!.getAttribute('role')).toBe('dialog');
  expect(document.activeElement?.id).toBe('ib-sbc-title');
});

test.skipIf(!hasDom)('the panel: Top and Bottom in the sidebar\'s order, a switch per item that hides, a lock on Inbox and Settings', async () => {
  draw();
  await act(async () => openSidebarCustomizer(null));
  const rows = (stack: string) => [...panel()!.querySelectorAll(`[data-sbc-zone="${stack}"] [data-sbc-row]`)].map((el) => el.getAttribute('data-sbc-row'));
  expect(rows('top')).toEqual(['search', 'new-message', 'inbox', 'board', 'artifacts', 'drafts']);
  expect(rows('bottom')).toEqual(['copy-prompt', 'feedback', 'settings']);
  // The logo heads Top; the Settings row's buttons sit under Settings: they hide, they have no grip.
  expect(panel()!.querySelector('[data-sbc-fixed="logo"] .ib-sbc-grip')).toBeNull();
  expect(panel()!.querySelector('[data-sbc-fixed="shortcuts"]')).not.toBeNull();
  for (const locked of ['inbox', 'settings']) {
    expect(panel()!.querySelector(`[data-sbc-row="${locked}"] [role="switch"]`)).toBeNull();
    expect(panel()!.querySelector(`[data-sbc-row="${locked}"] [data-sbc-locked]`)!.textContent).toBe('Always shown');
  }
  const feedback = panel()!.querySelector<HTMLElement>('[data-sidebar-switch="feedback"]')!;
  expect(feedback.getAttribute('aria-checked')).toBe('true');
  // Its name is the row's words.
  expect(document.getElementById(feedback.getAttribute('aria-labelledby')!)!.textContent).toBe('Feedback');
  await click(feedback);
  expect(feedback.getAttribute('aria-checked')).toBe('false');
  expect(document.querySelector('[data-feedback-nav]')).toBeNull();
  await click(panel()!.querySelector('[data-sidebar-switch="copy-prompt"]'));
  expect(document.querySelector('[data-connect-prompt]')).toBeNull();
  expect(saves.at(-1)).toEqual({ ...INBOX_SIDEBAR_DEFAULT, hidden: ['copy-prompt', 'feedback'] });
});

test.skipIf(!hasDom)('the grip\'s menu moves an item: Move to bottom, Move up, and Move up is off at the top of a stack', async () => {
  draw();
  await act(async () => openSidebarCustomizer(null));
  expect(stackOf('board')).toBe('top');
  await click(panel()!.querySelector('[data-sidebar-grip="board"]'));
  const moveMenu = document.querySelector('[data-sbc-move-menu="board"]')!;
  expect([...moveMenu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)).toEqual(['Move up', 'Move down', 'Move to bottom']);
  await click(moveMenu.querySelector('[data-sbc-move="bottom"]'));
  expect(stackOf('board')).toBe('bottom');
  // At the start of the bottom stack, next to the lists.
  expect(document.querySelector('.ib-side-foot [data-sidebar-item]')!.getAttribute('data-sidebar-item')).toBe('board');
  await click(panel()!.querySelector('[data-sidebar-grip="search"]'));
  expect(document.querySelector('[data-sbc-move-menu="search"] [data-sbc-move="up"]')!.hasAttribute('data-disabled')).toBe(true);
  await click(document.querySelector('[data-sbc-move-menu="search"] [data-sbc-move="down"]'));
  const top = [...document.querySelectorAll('.ib-side > .ib-side-item')].map((el) => el.getAttribute('data-sidebar-item'));
  expect(top).toEqual(['new-message', 'search', 'inbox', 'drafts']);
});

test.skipIf(!hasDom)('Start from: a preset applies, says it is pressed, and a change reads Custom; Reset is off at the default; Escape closes and focus goes back', async () => {
  draw();
  await act(async () => openSidebarCustomizer(document.querySelector<HTMLElement>('[data-board-nav]')));
  const preset = (name: string) => panel()!.querySelector<HTMLElement>(`[data-preset="${name}"]`)!;
  expect(preset('default').getAttribute('aria-pressed')).toBe('true');
  expect(panel()!.querySelector<HTMLButtonElement>('[data-sidebar-reset]')!.disabled).toBe(true);
  await click(preset('all-top'));
  expect(stackOf('settings')).toBe('top');
  expect(preset('all-top').getAttribute('aria-pressed')).toBe('true');
  await click(preset('minimal'));
  expect(document.querySelector('[data-feedback-nav]')).toBeNull();
  expect(item('new-message')).toBeNull();
  await click(panel()!.querySelector('[data-sidebar-switch="board"]'));
  expect(panel()!.querySelector('[data-sidebar-preset]')!.getAttribute('data-sidebar-preset')).toBe('custom');
  expect(panel()!.textContent).toContain('Custom');
  await click(panel()!.querySelector('[data-sidebar-reset]'));
  expect(preset('default').getAttribute('aria-pressed')).toBe('true');
  await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(panel()).toBeNull();
  // The Board row was drawn again by the moves: focus goes to the same row's control now.
  expect(document.activeElement?.hasAttribute('data-board-nav')).toBe(true);
});

test.skipIf(!hasDom)('an item a capability turns off is in neither the menu nor the panel, and keeps its place for when it comes back', async () => {
  draw();
  await act(async () => openSidebarCustomizer(null));
  await click(panel()!.querySelector('[data-sidebar-grip="board"]'));
  await click(document.querySelector('[data-sbc-move-menu="board"] [data-sbc-move="bottom"]'));
  // The Board is switched off.
  draw({ onBoard: undefined });
  expect(panel()!.querySelector('[data-sbc-row="board"]')).toBeNull();
  expect(item('board')).toBeNull();
  await rightClick(document.querySelector('[data-inbox-nav]')!);
  expect(toggles()).not.toContain('board');
  // And on again: where it was put.
  draw({ onBoard: noop });
  expect(stackOf('board')).toBe('bottom');
});

test.skipIf(!hasDom)('another window\'s save arrives (event: sidebar) and the sidebar takes it; an older one is not taken', async () => {
  draw();
  await act(async () => hearSidebarEvent({ ...INBOX_SIDEBAR_DEFAULT, hidden: ['feedback'] }, 5));
  expect(document.querySelector('[data-feedback-nav]')).toBeNull();
  let doubted = false;
  await act(async () => hearSidebarEvent(INBOX_SIDEBAR_DEFAULT, 4, () => (doubted = true)));
  expect(document.querySelector('[data-feedback-nav]')).toBeNull();
  expect(doubted).toBe(true);
});

test.skipIf(!hasDom)('the tour\'s sidebar draws the default whatever is saved, and has no menu', async () => {
  draw();
  await act(async () => hearSidebarEvent({ ...INBOX_SIDEBAR_DEFAULT, hidden: ['feedback', 'logo'] }, 1));
  draw({ rememberSections: false });
  expect(document.querySelector('[data-feedback-nav]')).not.toBeNull();
  expect(document.querySelector('.ib-brand')).not.toBeNull();
  const event = await rightClick(document.querySelector('[data-board-nav]')!);
  expect(event.defaultPrevented).toBe(false);
  expect(menu()).toBeNull();
});
