import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../config/configStore';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import {
  BUILT_IN_THEMES,
  DEFAULT_COLOR_THEME,
  normalizeThemePair,
  resetDefaultThemePair,
  seedThemePair,
  themesForHalf,
  themeSupportsHalf,
} from '../utils/themeRegistry';
import { THEME_MODES, isThemeMode, parseThemeMode } from './themeModes';
import { ThemeProvider, useTheme } from './ThemeProvider';
import { ThemeTab } from './ThemeTab';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;
let currentTheme: ReturnType<typeof useTheme> | null = null;
let stored = new Map<string, string>();
let originalMatchMediaDescriptor: PropertyDescriptor | undefined;
let originalFetch: typeof globalThis.fetch | null = null;

function captureConfigPosts(): string[] {
  const posts: string[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/config')) posts.push(String(init?.body ?? ''));
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  }) as typeof globalThis.fetch;
  return posts;
}

async function afterServerSyncDebounce(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 400));
  });
}

async function drainPendingServerSync(posts: string[]): Promise<void> {
  await afterServerSyncDebounce();
  posts.length = 0;
}

function Probe() {
  currentTheme = useTheme();
  return null;
}

function themeState(): ReturnType<typeof useTheme> {
  if (!currentTheme) throw new Error('ThemeProvider is not mounted');
  return currentTheme;
}

function paletteButtons(): HTMLButtonElement[] {
  return Array.from(host!.querySelectorAll('button')).filter(button =>
    button.querySelector('.rounded-full')
  );
}

function paletteNames(): string[] {
  return paletteButtons().map(button => button.textContent?.trim() ?? '');
}

function palette(name: string): HTMLButtonElement {
  const found = paletteButtons().find(button => button.textContent?.trim() === name);
  if (!found) throw new Error(`palette "${name}" is not in the grid`);
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host!.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  );
  if (!found) throw new Error(`button "${label}" did not render`);
  return found;
}

function summaryButton(prefix: string): HTMLButtonElement {
  const found = Array.from(host!.querySelectorAll('button')).find(candidate =>
    candidate.textContent?.trim().startsWith(prefix)
  );
  if (!found) throw new Error(`summary button "${prefix}" did not render`);
  return found;
}

function clickButton(target: HTMLButtonElement): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function installMatchMedia(initialMatches: boolean) {
  const state = new Map<string, boolean>([
    ['(prefers-color-scheme: light)', initialMatches],
    ['print', false],
  ]);
  const listeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>();
  const queries = new Map<string, MediaQueryList>();

  function queryFor(media: string): MediaQueryList {
    const existing = queries.get(media);
    if (existing) return existing;
    const own = new Set<(event: MediaQueryListEvent) => void>();
    listeners.set(media, own);
    const query = {
      get matches() {
        return state.get(media) ?? false;
      },
      media,
      onchange: null,
      addListener(listener: (event: MediaQueryListEvent) => void) {
        own.add(listener);
      },
      removeListener(listener: (event: MediaQueryListEvent) => void) {
        own.delete(listener);
      },
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        own.add(listener as (event: MediaQueryListEvent) => void);
      },
      removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        own.delete(listener as (event: MediaQueryListEvent) => void);
      },
      dispatchEvent() {
        return true;
      },
    } as MediaQueryList;
    queries.set(media, query);
    return query;
  }

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => queryFor(media),
  });

  function emit(media: string, matches: boolean) {
    state.set(media, matches);
    const event = { matches, media } as MediaQueryListEvent;
    for (const listener of listeners.get(media) ?? []) listener(event);
  }

  return {
    setMatches(nextMatches: boolean) {
      emit('(prefers-color-scheme: light)', nextMatches);
    },
    setPrintMedia(printing: boolean) {
      emit('print', printing);
    },
  };
}

async function mountTheme(children?: React.ReactNode): Promise<void> {
  configStore.loadFromBackend();
  await mountThemeFresh(children);
}

async function mountThemeFresh(children?: React.ReactNode): Promise<void> {
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

describe('theme registry', () => {
  test('keeps ids unique and registers the colorblind palette for both modes', () => {
    const ids = BUILT_IN_THEMES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);

    const theme = BUILT_IN_THEMES.find(candidate => candidate.id === 'colorblind');
    if (!theme) throw new Error('colorblind palette is not registered');
    expect(theme.modeSupport).toBe('both');
    expect(theme.syntaxHighlighting).toBe(true);
    expect(theme.colors.dark.background).not.toBe(theme.colors.light.background);
  });

  test('offers each palette only for the half it can render', () => {
    const light = themesForHalf(BUILT_IN_THEMES, 'light').map(({ id }) => id);
    const dark = themesForHalf(BUILT_IN_THEMES, 'dark').map(({ id }) => id);

    expect(light).toContain('kanagawa-lotus');
    expect(light).not.toContain('kanagawa-wave');
    expect(dark).toContain('kanagawa-wave');
    expect(dark).not.toContain('kanagawa-lotus');

    for (const id of ['rose-pine', 'colorblind']) {
      expect(light).toContain(id);
      expect(dark).toContain(id);
      expect(themeSupportsHalf(id, 'light')).toBe(true);
      expect(themeSupportsHalf(id, 'dark')).toBe(true);
    }
  });

  test('seeds both halves from the single palette older releases stored', () => {
    expect(seedThemePair('rose-pine', 'system')).toEqual({
      mode: 'system',
      light: 'rose-pine',
      dark: 'rose-pine',
    });

    expect(seedThemePair('kanagawa-wave', 'dark')).toEqual({
      mode: 'dark',
      light: DEFAULT_COLOR_THEME,
      dark: 'kanagawa-wave',
    });
    expect(seedThemePair('kanagawa-lotus', 'light')).toEqual({
      mode: 'light',
      light: 'kanagawa-lotus',
      dark: DEFAULT_COLOR_THEME,
    });

    expect(seedThemePair(null, 'system')).toEqual({
      mode: 'system',
      light: DEFAULT_COLOR_THEME,
      dark: DEFAULT_COLOR_THEME,
    });
    expect(seedThemePair('gone-in-this-build', 'dark')).toEqual({
      mode: 'dark',
      light: DEFAULT_COLOR_THEME,
      dark: DEFAULT_COLOR_THEME,
    });
  });

  test('repairs a pair whose halves hold unusable palettes', () => {
    const fallback = { mode: 'system', light: 'rose-pine', dark: 'kanagawa-wave' } as const;

    expect(normalizeThemePair({ mode: 'light', light: 'tinacious', dark: 'vesper' }, fallback)).toEqual({
      mode: 'light',
      light: 'tinacious',
      dark: 'vesper',
    });

    expect(normalizeThemePair({ mode: 'sepia', light: 'vesper', dark: 'tinacious' }, fallback)).toEqual({
      mode: 'system',
      light: 'rose-pine',
      dark: 'kanagawa-wave',
    });

    expect(normalizeThemePair(undefined)).toEqual({
      mode: 'dark',
      light: DEFAULT_COLOR_THEME,
      dark: DEFAULT_COLOR_THEME,
    });
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
    configStore.resetServerSync();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
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

  test.skipIf(!hasDom)('takes over an inline color-scheme set before it mounted, and adds none where there was none', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-color-theme', 'plannotator');
    const media = installMatchMedia(false);
    document.documentElement.style.colorScheme = 'dark';
    try {
      await mountTheme();
      expect(document.documentElement.style.colorScheme).toBe('dark');
      await act(async () => media.setMatches(true));
      expect(document.documentElement.style.colorScheme).toBe('light');

      await unmountTheme();
      document.documentElement.style.colorScheme = '';
      await mountTheme();
      await act(async () => media.setMatches(false));
      expect(document.documentElement.style.colorScheme).toBe('');
    } finally {
      document.documentElement.style.colorScheme = '';
    }
  });

  test.skipIf(!hasDom)('flips between the two halves of the pair when the OS scheme changes', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-light-theme', 'kanagawa-lotus');
    stored.set('plannotator-dark-theme', 'kanagawa-wave');
    const media = installMatchMedia(true);

    await mountTheme();
    expect(themeState().lightTheme).toBe('kanagawa-lotus');
    expect(themeState().darkTheme).toBe('kanagawa-wave');
    expect(themeState().colorTheme).toBe('kanagawa-lotus');
    expect(themeState().resolvedMode).toBe('light');
    expect(document.documentElement.classList.contains('theme-kanagawa-lotus')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(true);

    await act(async () => media.setMatches(false));
    expect(themeState().colorTheme).toBe('kanagawa-wave');
    expect(themeState().resolvedMode).toBe('dark');
    expect(document.documentElement.classList.contains('theme-kanagawa-wave')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);

    expect(stored.get('plannotator-color-theme')).toBe('kanagawa-wave');
  });

  test.skipIf(!hasDom)('migrates a stored dark-only palette into the dark half only', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-color-theme', 'kanagawa-wave');
    installMatchMedia(true);

    await mountTheme();
    expect(themeState().darkTheme).toBe('kanagawa-wave');
    expect(themeState().lightTheme).toBe(DEFAULT_COLOR_THEME);
    expect(themeState().mode).toBe('system');
    expect(themeState().preferredMode).toBe('light');
    expect(themeState().resolvedMode).toBe('light');
    expect(themeState().colorTheme).toBe(DEFAULT_COLOR_THEME);

    expect(stored.get('plannotator-light-theme')).toBe(DEFAULT_COLOR_THEME);
    expect(stored.get('plannotator-dark-theme')).toBe('kanagawa-wave');
    expect(stored.get('plannotator-color-theme')).toBe(DEFAULT_COLOR_THEME);
  });

  test.skipIf(!hasDom)('keeps every mode selectable while a dark-only palette owns the dark half', async () => {
    stored.set('plannotator-theme', 'dark');
    stored.set('plannotator-light-theme', 'rose-pine');
    stored.set('plannotator-dark-theme', 'dracula');
    installMatchMedia(false);

    await mountTheme(<ThemeTab />);
    expect(themeState().colorTheme).toBe('dracula');

    const modeButtons = Array.from(host!.querySelectorAll('button')).filter(button =>
      ['Light', 'Dark', 'System'].includes(button.textContent?.trim() ?? '')
    );
    expect(modeButtons.length).toBe(3);
    expect(modeButtons.some(button => button.disabled)).toBe(false);

    await act(async () => themeState().setMode('light'));
    expect(themeState().mode).toBe('light');
    expect(themeState().colorTheme).toBe('rose-pine');
    expect(themeState().resolvedMode).toBe('light');
    expect(stored.get('plannotator-theme')).toBe('light');
    expect(stored.get('plannotator-dark-theme')).toBe('dracula');
  });

  test.skipIf(!hasDom)('repairs invalid persisted values before exposing state', async () => {
    stored.set('plannotator-theme', 'sepia');
    stored.set('plannotator-light-theme', 'dracula');
    stored.set('plannotator-dark-theme', 'gone-in-this-build');
    stored.set('plannotator-color-theme', 'andromeeda');
    installMatchMedia(true);

    await mountTheme();
    expect(themeState().mode).toBe('dark');
    expect(themeState().lightTheme).toBe(DEFAULT_COLOR_THEME);
    expect(themeState().darkTheme).toBe('andromeeda');
    expect(themeState().resolvedMode).toBe('dark');
    expect(stored.get('plannotator-theme')).toBe('dark');
  });

  test.skipIf(!hasDom)('assigns one half at a time from its own grid', async () => {
    stored.set('plannotator-theme', 'light');
    stored.set('plannotator-light-theme', DEFAULT_COLOR_THEME);
    stored.set('plannotator-dark-theme', DEFAULT_COLOR_THEME);
    installMatchMedia(true);

    await mountTheme(<ThemeTab />);

    expect(paletteNames()).toContain('Kanagawa Lotus');
    expect(paletteNames()).not.toContain('Kanagawa Wave');

    await act(async () => clickButton(palette('Tinacious')));
    expect(themeState().lightTheme).toBe('tinacious');
    expect(themeState().colorTheme).toBe('tinacious');

    const swatches = palette('Tinacious').querySelectorAll<HTMLElement>('.rounded-full');
    const tinacious = BUILT_IN_THEMES.find(theme => theme.id === 'tinacious');
    if (!tinacious) throw new Error('Tinacious palette is not registered');
    expect(swatches[3]?.style.backgroundColor).toBe(tinacious.colors.light.background);

    await act(async () => clickButton(button('Dark theme')));
    expect(paletteNames()).toContain('Kanagawa Wave');
    expect(paletteNames()).not.toContain('Kanagawa Lotus');

    await act(async () => clickButton(palette('Dracula')));
    expect(themeState().darkTheme).toBe('dracula');
    expect(themeState().mode).toBe('light');
    expect(themeState().colorTheme).toBe('tinacious');

    expect(host!.textContent).toContain('Tinacious');
    expect(host!.textContent).toContain('Dracula');
    await act(async () => clickButton(summaryButton('Light:')));
    expect(paletteNames()).toContain('Kanagawa Lotus');
  });

  test.skipIf(!hasDom)('every change of what is shown lands without the colour fade, and the hold then goes', async () => {
    stored.set('plannotator-theme', 'dark');
    stored.set('plannotator-light-theme', DEFAULT_COLOR_THEME);
    stored.set('plannotator-dark-theme', DEFAULT_COLOR_THEME);
    const media = installMatchMedia(false);
    const html = document.documentElement;
    const held = () => html.classList.contains('pn-theme-switching');
    const afterTwoFrames = () => act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 120));
    });

    await mountTheme(<ThemeTab />);
    await afterTwoFrames();
    expect(held()).toBe(false);

    await act(async () => clickButton(button('Light')));
    expect(html.classList.contains('light')).toBe(true);
    expect(held()).toBe(true);
    await afterTwoFrames();
    expect(held()).toBe(false);

    await act(async () => clickButton(palette('Tinacious')));
    expect(html.classList.contains('theme-tinacious')).toBe(true);
    expect(held()).toBe(true);
    await afterTwoFrames();
    expect(held()).toBe(false);

    await act(async () => clickButton(button('Dark theme')));
    await act(async () => clickButton(palette('Dracula')));
    expect(themeState().darkTheme).toBe('dracula');
    expect(held()).toBe(false);

    await act(async () => clickButton(button('System')));
    expect(html.classList.contains('theme-dracula')).toBe(true);
    expect(held()).toBe(true);
    await afterTwoFrames();
    expect(held()).toBe(false);
    await act(async () => media.setMatches(true));
    expect(html.classList.contains('light')).toBe(true);
    expect(held()).toBe(true);
    await afterTwoFrames();
    expect(held()).toBe(false);
  });

  test.skipIf(!hasDom)('honors a host\'s own storage keys when migrating to a pair', async () => {
    stored.set('host-mode', 'system');
    stored.set('host-palette', 'kanagawa-wave');
    installMatchMedia(false);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ThemeProvider storageKey="host-mode" colorThemeStorageKey="host-palette">
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(themeState().mode).toBe('system');
    expect(themeState().darkTheme).toBe('kanagawa-wave');
    expect(themeState().colorTheme).toBe('kanagawa-wave');
    expect(stored.get('host-mode')).toBe('system');
    expect(stored.get('host-palette')).toBe('kanagawa-wave');
  });
});

describe('ThemeProvider server write-back', () => {
  let posts: string[] = [];

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
    posts = captureConfigPosts();
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
    configStore.resetServerSync();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('posts nothing when mounting with no stored preference', async () => {
    await drainPendingServerSync(posts);
    installMatchMedia(false);

    await mountThemeFresh();
    await afterServerSyncDebounce();

    expect(posts).toEqual([]);
    expect(themeState().colorTheme).toBe(DEFAULT_COLOR_THEME);
    expect(stored.get('plannotator-light-theme')).toBe(DEFAULT_COLOR_THEME);
  });

  test.skipIf(!hasDom)('posts a real choice, so the pair still reaches config.json', async () => {
    await drainPendingServerSync(posts);
    installMatchMedia(false);

    await mountThemeFresh();
    await act(async () => themeState().setHalfTheme('dark', 'vesper'));
    await afterServerSyncDebounce();

    expect(posts.length).toBe(1);
    expect(JSON.parse(posts[0]!)).toEqual({
      theme: { mode: 'dark', light: DEFAULT_COLOR_THEME, dark: 'vesper' },
    });
  });

  test.skipIf(!hasDom)('keeps the legacy setColorTheme cookie-only', async () => {
    await drainPendingServerSync(posts);
    installMatchMedia(false);

    await mountThemeFresh();
    await act(async () => themeState().setColorTheme('vesper'));
    await afterServerSyncDebounce();

    expect(posts).toEqual([]);
    expect(themeState().darkTheme).toBe('vesper');
    expect(stored.get('plannotator-dark-theme')).toBe('vesper');
  });
});

describe('ThemeProvider legacy setColorTheme', () => {
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
    configStore.resetServerSync();
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('assigns a both-mode palette to the half on screen only', async () => {
    stored.set('plannotator-theme', 'dark');
    stored.set('plannotator-light-theme', 'one-light');
    stored.set('plannotator-dark-theme', 'vesper');
    installMatchMedia(false);

    await mountTheme();
    await act(async () => themeState().setColorTheme('gruvbox'));

    expect(themeState().darkTheme).toBe('gruvbox');
    expect(themeState().lightTheme).toBe('one-light');
    expect(themeState().mode).toBe('dark');
  });

  test.skipIf(!hasDom)('assigns a mode-restricted palette without moving the mode', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-light-theme', 'one-light');
    stored.set('plannotator-dark-theme', 'nord');
    const media = installMatchMedia(true);

    await mountTheme();
    expect(themeState().colorTheme).toBe('one-light');

    await act(async () => themeState().setColorTheme('vesper'));
    expect(themeState().darkTheme).toBe('vesper');
    expect(themeState().lightTheme).toBe('one-light');
    expect(themeState().mode).toBe('system');
    expect(themeState().colorTheme).toBe('one-light');

    await act(async () => media.setMatches(false));
    expect(themeState().colorTheme).toBe('vesper');
  });

  test.skipIf(!hasDom)('assigns a light-only palette to the light half from dark mode', async () => {
    stored.set('plannotator-theme', 'dark');
    stored.set('plannotator-light-theme', 'one-light');
    stored.set('plannotator-dark-theme', 'nord');
    installMatchMedia(false);

    await mountTheme();
    await act(async () => themeState().setColorTheme('kanagawa-lotus'));

    expect(themeState().lightTheme).toBe('kanagawa-lotus');
    expect(themeState().darkTheme).toBe('nord');
    expect(themeState().mode).toBe('dark');
  });
});

describe('ThemeProvider print mode', () => {
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
    configStore.resetServerSync();
    resetStorageBackend();
  });

  async function mountDarkPair(): Promise<void> {
    stored.set('plannotator-theme', 'dark');
    stored.set('plannotator-light-theme', 'one-light');
    stored.set('plannotator-dark-theme', 'plannotator');
    installMatchMedia(false);
    await mountTheme();
    expect(themeState().resolvedMode).toBe('dark');
    expect(themeState().colorTheme).toBe('plannotator');
  }

  test.skipIf(!hasDom)('beforeprint flips to the light half and afterprint restores', async () => {
    await mountDarkPair();

    await act(async () => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(themeState().resolvedMode).toBe('light');
    expect(themeState().colorTheme).toBe('one-light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('theme-one-light')).toBe(true);
    expect(themeState().mode).toBe('dark');
    expect(themeState().darkTheme).toBe('plannotator');

    await act(async () => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(themeState().resolvedMode).toBe('dark');
    expect(themeState().colorTheme).toBe('plannotator');
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  test.skipIf(!hasDom)('the light tokens are on <html> before the print snapshot, not a tick later', async () => {
    await mountDarkPair();

    await act(async () => {
      window.dispatchEvent(new Event('beforeprint'));
      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('theme-one-light')).toBe(true);
    });

    await act(async () => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  test.skipIf(!hasDom)('the print media query drives it too (headless print emulation)', async () => {
    stored.set('plannotator-theme', 'dark');
    stored.set('plannotator-light-theme', 'one-light');
    stored.set('plannotator-dark-theme', 'plannotator');
    const media = installMatchMedia(false);
    await mountTheme();
    expect(themeState().resolvedMode).toBe('dark');

    await act(async () => media.setPrintMedia(true));
    expect(themeState().resolvedMode).toBe('light');
    expect(themeState().colorTheme).toBe('one-light');

    await act(async () => media.setPrintMedia(false));
    expect(themeState().resolvedMode).toBe('dark');
    expect(themeState().colorTheme).toBe('plannotator');
  });

  test.skipIf(!hasDom)('a light-mode user sees no change at all', async () => {
    stored.set('plannotator-theme', 'light');
    stored.set('plannotator-light-theme', 'one-light');
    stored.set('plannotator-dark-theme', 'plannotator');
    installMatchMedia(true);
    await mountTheme();
    const before = { ...themeState() };

    await act(async () => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(themeState().resolvedMode).toBe(before.resolvedMode);
    expect(themeState().colorTheme).toBe(before.colorTheme);
  });
});
