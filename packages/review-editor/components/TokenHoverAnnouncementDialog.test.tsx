/**
 * DOM-gated tests (DOM_TESTS=1) for the one-time token hover card
 * announcement. Registered in .github/workflows/test.yml's "Run UI
 * seam-contract + DOM tests" step.
 *
 * The failure to catch is a decorative dialog: three options that look like a
 * choice but write nothing, so a reviewer who picks "Off" still gets cards.
 * Dismissal must therefore be "accept what is selected", with no separate
 * confirm step that could drop the selection.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { TokenHoverAnnouncementDialog } from './TokenHoverAnnouncementDialog';

const hasDom = typeof document !== 'undefined';

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let stored: Map<string, string>;

async function mount(node: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

function option(value: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-token-hover-trigger-option="${value}"]`);
  if (!el) throw new Error(`no trigger option "${value}" in the dialog`);
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  if (!hasDom) return;
  // Seed the trigger explicitly rather than relying on the registry default.
  // configStore is a process-global singleton and loadFromBackend keeps its
  // in-memory value when the new backend has nothing to say, so an empty map
  // would inherit whatever the previous test (or test FILE) last set.
  stored = new Map([['plannotator-token-hover-trigger', 'hover']]);
  setStorageBackend({
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: key => { stored.delete(key); },
  });
  configStore.loadFromBackend();
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  resetStorageBackend();
});

describe.skipIf(!hasDom)('TokenHoverAnnouncementDialog', () => {
  test('renders nothing at all when closed', async () => {
    await mount(<TokenHoverAnnouncementDialog isOpen={false} onDismiss={() => {}} />);
    expect(document.querySelector('[data-token-hover-announcement-dialog]')).toBeNull();
  });

  test('the radio applies the trigger immediately, with no confirm step', async () => {
    await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => {}} />);
    expect(configStore.get('tokenHoverTrigger')).toBe('hover');

    await click(option('modifier'));
    expect(configStore.get('tokenHoverTrigger')).toBe('modifier');
    expect(option('modifier').getAttribute('aria-checked')).toBe('true');
    expect(option('hover').getAttribute('aria-checked')).toBe('false');

    await click(option('off'));
    expect(configStore.get('tokenHoverTrigger')).toBe('off');
  });

  test('dismissing keeps the chosen trigger', async () => {
    let dismissed = 0;
    await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => { dismissed += 1; }} />);

    await click(option('off'));
    const done = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Done');
    await click(done!);

    expect(dismissed).toBe(1);
    expect(configStore.get('tokenHoverTrigger')).toBe('off');
  });

  test('arrows move selection within the group, which is one Tab stop', async () => {
    // WAI-ARIA radiogroup. Without roving tabindex a keyboard user Tabs
    // through three options to reach Done; without the arrow handler they
    // cannot change the selection with the keyboard at all.
    await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => {}} />);
    expect(option('hover').tabIndex).toBe(0);
    expect(option('modifier').tabIndex).toBe(-1);

    await act(async () => {
      option('hover').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(configStore.get('tokenHoverTrigger')).toBe('modifier');
    expect(option('modifier').tabIndex).toBe(0);
    expect(option('hover').tabIndex).toBe(-1);

    // Wraps backwards off the first option.
    await act(async () => {
      option('modifier').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(configStore.get('tokenHoverTrigger')).toBe('hover');
    await act(async () => {
      option('hover').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(configStore.get('tokenHoverTrigger')).toBe('off');
  });

  test('Escape dismisses and also keeps the chosen trigger', async () => {
    let dismissed = 0;
    await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => { dismissed += 1; }} />);

    await click(option('modifier'));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(dismissed).toBe(1);
    expect(configStore.get('tokenHoverTrigger')).toBe('modifier');
  });
});
