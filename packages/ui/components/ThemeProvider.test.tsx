import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { BUILT_IN_THEMES } from '../utils/themeRegistry';
import { THEME_MODES, isThemeMode, parseThemeMode } from './themeModes';
import { ThemeProvider, useTheme } from './ThemeProvider';
import { ThemeTab } from './ThemeTab';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;
let currentTheme: ReturnType<typeof useTheme> | null = null;
let stored = new Map<string, string>();
let originalMatchMediaDescriptor: PropertyDescriptor | undefined;

function Probe() {
  currentTheme = useTheme();
  return null;
}

function themeState(): ReturnType<typeof useTheme> {
  if (!currentTheme) throw new Error('ThemeProvider is not mounted');
  return currentTheme;
}

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = '(prefers-color-scheme: light)';
  const query = {
    get matches() {
      return matches;
    },
    media,
    onchange: null,
    addListener(listener: (event: MediaQueryListEvent) => void) {
      listeners.add(listener);
    },
    removeListener(listener: (event: MediaQueryListEvent) => void) {
      listeners.delete(listener);
    },
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    dispatchEvent() {
      return true;
    },
  } as MediaQueryList;

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => query,
  });

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

async function mountTheme(children?: React.ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Probe />
        {children}
      </ThemeProvider>,
    );
  });
}

async function unmountTheme(): Promise<void> {
  if (root) {
    await act(async () => root!.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  currentTheme = null;
}

describe('theme mode catalog', () => {
  test('is the one Light/Dark/System source and parses persisted input', () => {
    expect(THEME_MODES.map(({ id }) => id)).toEqual(['light', 'dark', 'system']);
    expect(isThemeMode('system')).toBe(true);
    expect(isThemeMode('sepia')).toBe(false);
    expect(parseThemeMode('light', 'dark')).toBe('light');
    expect(parseThemeMode('sepia', 'dark')).toBe('dark');
  });
});

describe('ThemeProvider', () => {
  beforeEach(() => {
    if (hasDom) {
      originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    }
    stored = new Map<string, string>();
    setStorageBackend({
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: key => {
        stored.delete(key);
      },
    });
  });

  afterEach(async () => {
    if (hasDom) {
      await unmountTheme();
      document.documentElement.className = '';
      if (originalMatchMediaDescriptor) {
        Object.defineProperty(window, 'matchMedia', originalMatchMediaDescriptor);
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
      originalMatchMediaDescriptor = undefined;
    }
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('persists System and follows live OS changes across reloads', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-color-theme', 'plannotator');
    const media = installMatchMedia(false);

    await mountTheme();
    expect(themeState().mode).toBe('system');
    expect(themeState().preferredMode).toBe('dark');
    expect(themeState().resolvedMode).toBe('dark');

    await act(async () => media.setMatches(true));
    expect(themeState().mode).toBe('system');
    expect(themeState().preferredMode).toBe('light');
    expect(themeState().resolvedMode).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(stored.get('plannotator-theme')).toBe('system');

    await unmountTheme();
    media.setMatches(false);
    await mountTheme();
    expect(themeState().mode).toBe('system');
    expect(themeState().resolvedMode).toBe('dark');
  });

  test.skipIf(!hasDom)('keeps System coherent and normalizes explicit modes for constrained palettes', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-color-theme', 'andromeeda');
    const media = installMatchMedia(true);

    await mountTheme();
    expect(themeState().mode).toBe('system');
    expect(themeState().preferredMode).toBe('light');
    expect(themeState().resolvedMode).toBe('dark');
    expect(document.documentElement.classList.contains('theme-andromeeda')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);

    await act(async () => media.setMatches(false));
    expect(themeState().mode).toBe('system');
    expect(themeState().preferredMode).toBe('dark');
    expect(themeState().resolvedMode).toBe('dark');

    await act(async () => themeState().setColorTheme('kanagawa-lotus'));
    expect(themeState().mode).toBe('system');
    expect(themeState().resolvedMode).toBe('light');
    expect(stored.get('plannotator-theme')).toBe('system');

    await act(async () => themeState().setMode('dark'));
    expect(themeState().mode).toBe('light');
    expect(themeState().resolvedMode).toBe('light');
    expect(stored.get('plannotator-theme')).toBe('light');

    await act(async () => themeState().setColorTheme('andromeeda'));
    expect(themeState().mode).toBe('dark');
    expect(themeState().resolvedMode).toBe('dark');
    expect(stored.get('plannotator-theme')).toBe('dark');

    await act(async () => {
      themeState().setColorTheme('plannotator');
      themeState().setMode('light');
      themeState().setColorTheme('andromeeda');
      themeState().setMode('light');
    });
    expect(themeState().mode).toBe('dark');
    expect(themeState().resolvedMode).toBe('dark');
    expect(stored.get('plannotator-theme')).toBe('dark');
  });

  test.skipIf(!hasDom)('repairs invalid persisted modes before exposing state', async () => {
    stored.set('plannotator-theme', 'sepia');
    stored.set('plannotator-color-theme', 'andromeeda');
    installMatchMedia(true);

    await mountTheme();
    expect(themeState().mode).toBe('dark');
    expect(themeState().resolvedMode).toBe('dark');
    expect(stored.get('plannotator-theme')).toBe('dark');
  });

  test.skipIf(!hasDom)('previews a constrained palette using the mode it actually renders', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-color-theme', 'tinacious');
    installMatchMedia(false);

    await mountTheme(<ThemeTab />);
    expect(themeState().preferredMode).toBe('dark');
    expect(themeState().resolvedMode).toBe('light');

    const paletteButton = Array.from(host!.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Tinacious')
    );
    if (!paletteButton) throw new Error('Tinacious palette preview did not render');
    const swatches = paletteButton.querySelectorAll<HTMLElement>('.rounded-full');
    const palette = BUILT_IN_THEMES.find(theme => theme.id === 'tinacious');
    if (!palette) throw new Error('Tinacious palette is not registered');

    expect(swatches[3]?.style.backgroundColor).toBe(palette.colors.light.background);
    expect(swatches[3]?.style.backgroundColor).not.toBe(palette.colors.dark.background);
  });
});
