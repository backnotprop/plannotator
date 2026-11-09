import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../config/configStore';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { ThemeProvider } from './ThemeProvider';
import {
  FACE_FAVICON_PNG_DATA_URL,
  FAVICON_ICO_DATA_URL,
  P_FAVICON_PNG_DATA_URL,
} from '@plannotator/core/favicon';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();

function getFaviconLink(): HTMLLinkElement | null {
  if (!hasDom) return null;
  return document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

async function mount(manageFavicon = true): Promise<void> {
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ThemeProvider manageFavicon={manageFavicon}>
        <div>App</div>
      </ThemeProvider>,
    );
  });
}

async function unmount(): Promise<void> {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
}

describe('ThemeProvider favicon synchronization', () => {
  beforeEach(() => {
    stored.clear();
    setStorageBackend({
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: (key) => {
        stored.delete(key);
      },
    });
    if (hasDom) {
      const existing = getFaviconLink();
      if (existing) existing.remove();
    }
  });

  afterEach(async () => {
    if (hasDom) {
      await unmount();
      const existing = getFaviconLink();
      if (existing) existing.remove();
    }
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('nothing stored draws Glass', async () => {
    configStore.loadFromBackend();

    await mount();

    // The .ico with its three frames, so the tab takes the hand-pixelled 16 or 32.
    const link = getFaviconLink();
    expect(link?.href).toBe(FAVICON_ICO_DATA_URL);
    expect(link?.type).toBe('image/x-icon');
    expect(link?.getAttribute('sizes')).toBe('16x16 32x32 48x48');
  });

  test.skipIf(!hasDom)('updates document link[rel="icon"] href, type, and sizes when faviconStyle changes', async () => {
    // 'totman', the id people stored when the Face icon was the default, still draws the Face icon.
    stored.set('plannotator-favicon', 'totman');
    configStore.loadFromBackend();

    await mount();

    const link = getFaviconLink();
    expect(link).not.toBeNull();
    expect(link?.href).toBe(FACE_FAVICON_PNG_DATA_URL);
    expect(link?.type).toBe('image/png');
    expect(link?.getAttribute('sizes')).toBe('64x64');

    await act(async () => {
      configStore.set('faviconStyle', 'classic');
    });

    const updatedLink = getFaviconLink();
    expect(updatedLink?.href).toBe(P_FAVICON_PNG_DATA_URL);
    expect(updatedLink?.type).toBe('image/png');
    expect(updatedLink?.getAttribute('sizes')).toBe('192x192');

    await act(async () => {
      configStore.set('faviconStyle', 'glass');
    });

    const glassLink = getFaviconLink();
    expect(glassLink?.href).toBe(FAVICON_ICO_DATA_URL);
    expect(glassLink?.type).toBe('image/x-icon');
    expect(glassLink?.getAttribute('sizes')).toBe('16x16 32x32 48x48');
  });

  test.skipIf(!hasDom)('classic, stored by anyone who chose the old navy P, draws the P icon', async () => {
    stored.set('plannotator-favicon', 'classic');
    configStore.loadFromBackend();

    await mount();

    const link = getFaviconLink();
    expect(link).not.toBeNull();
    expect(link?.href).toBe(P_FAVICON_PNG_DATA_URL);
    expect(link?.type).toBe('image/png');
  });
});

/**
 * The published package installs into host applications with their own
 * branding. Mounting the provider must not repaint a host's tab icon, so favicon
 * ownership is opt-in and these two cases are the contract: the default mount
 * leaves document.head exactly as it found it, the opt-in mount does not.
 */
describe('ThemeProvider favicon ownership is opt-in', () => {
  beforeEach(() => {
    stored.clear();
    setStorageBackend({
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: (key) => {
        stored.delete(key);
      },
    });
    if (hasDom) {
      for (const link of document.head.querySelectorAll('link[rel="icon"]')) link.remove();
    }
  });

  afterEach(async () => {
    if (hasDom) {
      await unmount();
      for (const link of document.head.querySelectorAll('link[rel="icon"]')) link.remove();
    }
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('a default mount creates no favicon link', async () => {
    stored.set('plannotator-favicon', 'classic');
    configStore.loadFromBackend();

    await mount(false);

    expect(getFaviconLink()).toBeNull();
  });

  test.skipIf(!hasDom)("a default mount leaves a host's own favicon link untouched", async () => {
    const hostLink = document.createElement('link');
    hostLink.rel = 'icon';
    hostLink.type = 'image/png';
    hostLink.href = 'https://host.example/brand.png';
    document.head.appendChild(hostLink);

    stored.set('plannotator-favicon', 'classic');
    configStore.loadFromBackend();

    await mount(false);

    expect(getFaviconLink()?.href).toBe('https://host.example/brand.png');
    expect(getFaviconLink()?.type).toBe('image/png');

    // And a later preference change is still ignored while ownership is off.
    await act(async () => {
      configStore.set('faviconStyle', 'totman');
    });
    expect(getFaviconLink()?.href).toBe('https://host.example/brand.png');
  });

  test.skipIf(!hasDom)("an opt-in mount does take over the host's favicon link", async () => {
    const hostLink = document.createElement('link');
    hostLink.rel = 'icon';
    hostLink.type = 'image/png';
    hostLink.href = 'https://host.example/brand.png';
    document.head.appendChild(hostLink);

    stored.set('plannotator-favicon', 'classic');
    configStore.loadFromBackend();

    await mount(true);

    expect(getFaviconLink()?.href).toBe(P_FAVICON_PNG_DATA_URL);
  });
});
