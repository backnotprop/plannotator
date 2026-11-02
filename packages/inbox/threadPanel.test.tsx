/**
 * The thread panel view's choice (threadPanel.ts) and its ⋮ menu item.
 * What this catches: the view on in a browser that never chose it; a choice forgotten on the next load, or one that
 * leaves a cookie behind when turned off; the panel drawn on a phone or in a stacked window, where it would stand
 * alone; a menu item a screen reader does not hear as a checkbox or that closes the menu; a look option's write wiping
 * the choice; the panel's art starting anywhere but the keycap, losing the approved order or the way back to the
 * keycap, or drawing the wrong mode's mask. The whole window (the panes, a reload, closing a thread, a phone, the art's
 * keyboard path, the masks really painting) is proved in Chromium by tests/e2e/inbox-thread-panel.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TidyController } from './components/Tidy';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { EmptyThreadPanel } = (hasDom ? await import('./components/EmptyThreadPanel') : {}) as typeof import('./components/EmptyThreadPanel');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
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

describe.skipIf(!hasDom)('the empty panel\'s art', () => {
  /** The owner's order, spread out on purpose (`.product/approved/inbox-thread-panel-art/`). */
  const ORDER = ['keycap', 'saturn', 'anvil', 'android', 'newton', 'moon', 'sketchbook', 'pilot', 'vacuumtube', 'blackhole', 'vise', 'voyager', 'dividers', 'astronaut', 'telescope'];

  function Rotating() {
    const [piece, setPiece] = useState(0);
    return <EmptyThreadPanel piece={piece} onPiece={setPiece} />;
  }

  function panel(mode: 'light' | 'dark'): HTMLButtonElement {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <ThemeProvider defaultTheme={mode}>
          <Rotating />
        </ThemeProvider>,
      );
    });
    return host.querySelector('button')!;
  }

  const mask = (button: HTMLElement) => button.querySelector<HTMLElement>('.ib-pempty-piece')!.style.getPropertyValue('--ib-pempty-mask');

  test('opens on the keycap, and a click moves to saturn', () => {
    const button = panel('light');
    expect(button.dataset.piece).toBe('keycap');
    act(() => button.click());
    expect(button.dataset.piece).toBe('saturn');
  });

  test('walks all 15 in the approved order, and after the telescope goes back to the keycap', () => {
    const button = panel('light');
    const seen: string[] = [];
    for (let i = 0; i <= ORDER.length; i++) {
      seen.push(button.dataset.piece!);
      act(() => button.click());
    }
    expect(seen).toEqual([...ORDER, 'keycap']);
  });

  test('every piece has its own mask, and the dark mode draws its dark cut', () => {
    const button = panel('dark');
    for (const slug of ORDER) {
      expect(mask(button)).toContain(`${slug}-dark.png`);
      act(() => button.click());
    }
  });

  test('the light mode draws the light cut', () => {
    const button = panel('light');
    for (const slug of ORDER) {
      expect(mask(button)).toContain(`${slug}.png`);
      expect(mask(button)).not.toContain('-dark');
      act(() => button.click());
    }
  });
});
