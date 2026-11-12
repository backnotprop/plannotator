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
  configStore.loadFromBackend();
});

describe.skipIf(!hasDom)('TokenHoverAnnouncementDialog', () => {
  test('renders nothing at all when closed', async () => {
    await mount(<TokenHoverAnnouncementDialog isOpen={false} onDismiss={() => {}} />);
    expect(document.querySelector('[data-token-hover-announcement-dialog]')).toBeNull();
  });

  test('the try-it is labeled, and its mock code stays out of the reading order', async () => {
    await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => {}} />);
    const region = document.querySelector('[data-token-hover-example]')!;
    expect(region.getAttribute('aria-hidden')).toBeNull();
    expect(region.getAttribute('role')).toBe('group');
    expect(region.getAttribute('aria-label')).toBeTruthy();
    expect(
      document.querySelector('[data-token-hover-example-code]')!.getAttribute('aria-hidden'),
    ).toBe('true');
    const prompt = document.querySelector('[data-token-hover-tryit-prompt]')!;
    expect(prompt.textContent).toContain('withRetry');
  });

  test('hovering the try-it token opens the real card from the fixture', async () => {
    jest.useFakeTimers();
    try {
      await mount(<TokenHoverAnnouncementDialog isOpen onDismiss={() => {}} />);
      const token = document.querySelector('[data-token-hover-example-token]')!;

      await act(async () => {
        token.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      });
      expect(document.querySelector('[data-token-hover-card]')).toBeNull();

      await act(async () => { jest.advanceTimersByTime(DEFAULT_TOKEN_HOVER_DELAY_MS); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const card = document.querySelector('[data-token-hover-card]');
      expect(card).not.toBeNull();
      expect(card!.textContent).toContain(EXAMPLE_HOVER.symbol);
      expect(card!.textContent).toContain(EXAMPLE_HOVER.definition!.filePath);
      for (const b of card!.querySelectorAll('button')) {
        expect(b.tabIndex).toBe(-1);
        expect(b.className).toContain('cursor-default');
      }
      expect(card!.getAttribute('aria-hidden')).toBe('true');
      expect(card!.className).toContain('z-[110]');
    } finally {
      jest.useRealTimers();
    }
  });

  test('the try-it obeys the trigger the radio currently says', async () => {
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
