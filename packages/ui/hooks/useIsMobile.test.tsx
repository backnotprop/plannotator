import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  COMPACT_TOUCH_LAYOUT_MEDIA_QUERY,
  useCompactTouchLayout,
} from './useIsMobile';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;

function Harness() {
  const compact = useCompactTouchLayout();
  return <output data-compact={compact ? 'true' : 'false'} />;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
  originalMatchMedia = undefined;
});

describe('useCompactTouchLayout', () => {
  test('uses compact width and the primary coarse pointer', () => {
    expect(COMPACT_TOUCH_LAYOUT_MEDIA_QUERY)
      .toBe('(max-width: 1024px) and (pointer: coarse)');
    expect(COMPACT_TOUCH_LAYOUT_MEDIA_QUERY).not.toContain('any-pointer');
  });

  test.skipIf(!hasDom)('follows media changes and removes its listener', async () => {
    originalMatchMedia = window.matchMedia;
    let matches = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();

    // SAFETY: The test double implements the MediaQueryList surface consumed by the hook.
    window.matchMedia = ((query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));

    expect(document.querySelector('output')?.getAttribute('data-compact')).toBe('false');
    expect(listeners.size).toBe(1);

    matches = true;
    await act(async () => {
      // SAFETY: The hook reads only `matches` from this synthetic media event.
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
    });
    expect(document.querySelector('output')?.getAttribute('data-compact')).toBe('true');

    await act(async () => root?.unmount());
    root = null;
    expect(listeners.size).toBe(0);
  });
});
