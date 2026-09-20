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
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { isMac, modEventKey } from '@plannotator/ui/utils/platform';
import { DEFAULT_TOKEN_HOVER_DELAY_MS } from '@plannotator/shared/token-hover';
import { EXAMPLE_HOVER, TokenHoverAnnouncementDialog } from './TokenHoverAnnouncementDialog';

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
  // Same reason as tokenHoverAnnouncement.test.ts: the store is a process
  // global that this file re-resolved against a fake backend, so hand it back
  // to the real one rather than leaving it holding this file's values.
  configStore.loadFromBackend();
});

describe.skipIf(!hasDom)('TokenHoverAnnouncementDialog', () => {
  test('renders nothing at all when closed', async () => {
    await mount(<TokenHoverAnnouncementDialog isOpen={false} onDismiss={() => {}} />);
    expect(document.querySelector('[data-token-hover-announcement-dialog]')).toBeNull();
  });

  test('the try-it is labeled, and its mock code stays out of the reading order', async () => {
    // It is interactive now, so hiding the whole block would make it
    // unreachable and unexplained. The region carries the label; the mock code
    // inside is decorative (read aloud it is a wall of invented identifiers)
    // and the visible prompt line carries the meaning instead.
    await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => {}} />);
    const region = document.querySelector('[data-token-hover-example]')!;
    expect(region.getAttribute('aria-hidden')).toBeNull();
    expect(region.getAttribute('role')).toBe('group');
    expect(region.getAttribute('aria-label')).toBeTruthy();
    expect(
      document.querySelector('[data-token-hover-example-code]')!.getAttribute('aria-hidden'),
    ).toBe('true');
    // The prompt names the token the reviewer is being asked to hover.
    const prompt = document.querySelector('[data-token-hover-tryit-prompt]')!;
    expect(prompt.textContent).toContain('withRetry');
  });

  test('hovering the try-it token opens the real card from the fixture', async () => {
    // This is the whole point of the seam: real dwell, real card component,
    // fixture answer. If someone reimplements the demo with its own timing or
    // its own markup, the card either stops matching the product or stops
    // behaving like it.
    jest.useFakeTimers();
    try {
      await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => {}} />);
      const token = document.querySelector('[data-token-hover-example-token]')!;

      await act(async () => {
        token.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      });
      // Nothing before the dwell elapses.
      expect(document.querySelector('[data-token-hover-card]')).toBeNull();

      // The try-it reads the live `tokenHoverDelay`, which the seeded backend
      // says nothing about, so the dwell here is the registry default.
      await act(async () => { jest.advanceTimersByTime(DEFAULT_TOKEN_HOVER_DELAY_MS); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      // `data-token-hover-card` is the real component's own marker.
      const card = document.querySelector('[data-token-hover-card]');
      expect(card).not.toBeNull();
      expect(card!.textContent).toContain(EXAMPLE_HOVER.symbol);
      expect(card!.textContent).toContain(EXAMPLE_HOVER.definition!.filePath);
      // No References panel behind the demo, so its locations are neither
      // tabbable nor advertised as clickable, and the card is out of the
      // reading order (it portals to <body>, outside the aria-modal dialog).
      for (const b of card!.querySelectorAll('button')) {
        expect(b.tabIndex).toBe(-1);
        expect(b.className).toContain('cursor-default');
      }
      expect(card!.getAttribute('aria-hidden')).toBe('true');
      // The card portals to <body> like every other instance, so the dialog it
      // is demonstrated INSIDE would cover it without an explicit layer. This
      // is the seam's whole reason for existing: a buried demo card is exactly
      // the failure a live try-it is supposed to make impossible.
      expect(card!.className).toContain('z-[110]');
    } finally {
      jest.useRealTimers();
    }
  });

  test('the try-it obeys the trigger the radio currently says', async () => {
    // Choosing the hold-modifier option has to be feelable BEFORE committing
    // to it, which is why the try-it reads the live setting, not a prop.
    jest.useFakeTimers();
    try {
      await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => {}} />);
      await click(option('modifier'));

      const token = document.querySelector('[data-token-hover-example-token]')!;
      await act(async () => {
        token.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      });
      await act(async () => { jest.advanceTimersByTime(2000); });
      await act(async () => { await Promise.resolve(); });
      expect(document.querySelector('[data-token-hover-card]')).toBeNull();

      // Modifier down, and the same rest opens it.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: modEventKey,
          metaKey: isMac,
          ctrlKey: !isMac,
        }));
      });
      await act(async () => { jest.advanceTimersByTime(DEFAULT_TOKEN_HOVER_DELAY_MS); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(document.querySelector('[data-token-hover-card]')).not.toBeNull();

      // And Off takes an open card away with it.
      await click(option('off'));
      expect(document.querySelector('[data-token-hover-card]')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
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
