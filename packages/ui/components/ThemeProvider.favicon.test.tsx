import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../config/configStore';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { ThemeProvider } from './ThemeProvider';
import {
  CLASSIC_FAVICON_DATA_URL,
  FAVICON_PNG_DATA_URL,
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

  test.skipIf(!hasDom)('updates document link[rel="icon"] href, type, and sizes when faviconStyle changes', async () => {
    stored.set('plannotator-favicon', 'totman');
    configStore.loadFromBackend();

    await mount();

    const link = getFaviconLink();
    expect(link).not.toBeNull();
    expect(link?.href).toBe(FAVICON_PNG_DATA_URL);
    expect(link?.type).toBe('image/png');
    expect(link?.getAttribute('sizes')).toBe('64x64');

    await act(async () => {
      configStore.set('faviconStyle', 'classic');
    });

    const updatedLink = getFaviconLink();
    expect(updatedLink?.href).toBe(CLASSIC_FAVICON_DATA_URL);
    expect(updatedLink?.type).toBe('image/svg+xml');
    expect(updatedLink?.hasAttribute('sizes')).toBe(false);

    await act(async () => {
      configStore.set('faviconStyle', 'totman');
    });

    const revertedLink = getFaviconLink();
    expect(revertedLink?.href).toBe(FAVICON_PNG_DATA_URL);
    expect(revertedLink?.type).toBe('image/png');
    expect(revertedLink?.getAttribute('sizes')).toBe('64x64');
  });

  test.skipIf(!hasDom)('initializes with classic style when stored in backend', async () => {
    stored.set('plannotator-favicon', 'classic');
    configStore.loadFromBackend();

    await mount();

    const link = getFaviconLink();
    expect(link).not.toBeNull();
    expect(link?.href).toBe(CLASSIC_FAVICON_DATA_URL);
    expect(link?.type).toBe('image/svg+xml');
    expect(link?.hasAttribute('sizes')).toBe(false);
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

    expect(getFaviconLink()?.href).toBe(CLASSIC_FAVICON_DATA_URL);
  });
});
