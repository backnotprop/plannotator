/**
 * The thread panel view's choice (threadPanel.ts) and its ⋮ menu item.
 * What this catches: the view on in a browser that never chose it; a choice forgotten on the next load, or one that
 * leaves a cookie behind when turned off; the panel drawn on a phone or in a stacked window, where it would stand
 * alone; a menu item a screen reader does not hear as a checkbox or that closes the menu; a look option's write wiping
 * the choice. The whole window (the panes, a reload, closing a thread, a phone) is proved in Chromium by
 * tests/e2e/inbox-thread-panel.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TidyController } from './components/Tidy';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_LOOK_OFF, writeListLook } = await import('./listLook');
const { THREAD_PANEL_COOKIE, readThreadPanel, threadPanelShows, writeThreadPanel } = await import('./threadPanel');
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
});

afterEach(() => {
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };

async function menu(threadPanel: { on: boolean; onChange: (on: boolean) => void }): Promise<HTMLElement> {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={[]} filtered={false} narrow={false} phone={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} tidy={TIDY} threadPanel={threadPanel} />
      </SidebarProvider>,
    );
  });
  act(() => host!.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return document.querySelector<HTMLElement>('[data-tidy-menu-popup]')!;
}

const item = (popup: HTMLElement) => popup.querySelector<HTMLElement>('[data-thread-panel-option]');

describe('the choice', () => {
  test('an untouched browser is the wide view and carries no cookie', () => {
    expect(readThreadPanel()).toBe(false);
    expect(threadPanelShows(readThreadPanel(), { phone: false, stacked: false })).toBe(false);
    expect(stored.size).toBe(0);
  });

  test('on is remembered for the next load; off leaves no cookie behind', () => {
    writeThreadPanel(true);
    expect(stored.get(THREAD_PANEL_COOKIE)).toBe('1');
    expect(readThreadPanel()).toBe(true);
    writeThreadPanel(false);
    expect(stored.has(THREAD_PANEL_COOKIE)).toBe(false);
    expect(readThreadPanel()).toBe(false);
  });

  test('only "1" counts as on', () => {
    stored.set(THREAD_PANEL_COOKIE, 'true');
    expect(readThreadPanel()).toBe(false);
  });

  test('writing the look options leaves it alone', () => {
    writeThreadPanel(true);
    writeListLook(LIST_LOOK_OFF);
    expect(readThreadPanel()).toBe(true);
  });

  test('the panel needs two panes side by side: never on a phone, never in a window that stacks', () => {
    expect(threadPanelShows(true, { phone: false, stacked: false })).toBe(true);
    expect(threadPanelShows(true, { phone: true, stacked: false })).toBe(false);
    expect(threadPanelShows(true, { phone: false, stacked: true })).toBe(false);
  });
});

describe.skipIf(!hasDom)('the ⋮ menu item', () => {
  test('a checkbox after the look options, unchecked with no ✓ while off', async () => {
    const popup = await menu({ on: false, onChange: () => {} });
    expect([...popup.querySelectorAll('[role="menuitemcheckbox"]')].at(-1)).toBe(item(popup)!);
    expect(item(popup)!.getAttribute('aria-checked')).toBe('false');
    expect(item(popup)!.querySelector('.ib-pmi-check')).toBeNull();
  });

  test('checked with a ✓ while on, like its neighbours', async () => {
    const popup = await menu({ on: true, onChange: () => {} });
    expect(item(popup)!.getAttribute('aria-checked')).toBe('true');
    expect(item(popup)!.querySelector('.ib-pmi-check')).not.toBeNull();
  });

  test('a click says the new value and leaves the menu open', async () => {
    const asked: boolean[] = [];
    const popup = await menu({ on: false, onChange: (on) => asked.push(on) });
    await act(async () => {
      item(popup)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(asked).toEqual([true]);
    expect(document.querySelector('[data-tidy-menu-popup]')).not.toBeNull();
  });
});
