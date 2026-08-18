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

/** Capture every request the default server-sync transport would make. */
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

/** Let the store's 300ms server-sync debounce fire (or prove it never does). */
async function afterServerSyncDebounce(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 400));
  });
}

/** Flush writes an earlier test queued, so only this test's posts are counted. */
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

/** Every palette card in the grid — the only buttons carrying color swatches. */
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
  // The config store is a process-wide singleton: re-read it from the storage
  // backend this test installed so seeded cookies (not a previous test's
  // values) decide the pair.
  configStore.loadFromBackend();
  await mountThemeFresh(children);
}

/** Mount WITHOUT pre-seeding the store, i.e. what a cookie-less visit hits. */
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

    // A `both` palette — the colorblind theme included — belongs to each half.
    for (const id of ['rose-pine', 'colorblind']) {
      expect(light).toContain(id);
      expect(dark).toContain(id);
      expect(themeSupportsHalf(id, 'light')).toBe(true);
      expect(themeSupportsHalf(id, 'dark')).toBe(true);
    }
  });

  test('seeds both halves from the single palette older releases stored', () => {
    // A palette that renders both modes takes over the whole pair.
    expect(seedThemePair('rose-pine', 'system')).toEqual({
      mode: 'system',
      light: 'rose-pine',
      dark: 'rose-pine',
    });

    // A mode-restricted one keeps its half; the other half falls back.
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

    // Nothing stored, or a palette this build does not ship.
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

    // A dark-only palette can never occupy the light half, and vice versa.
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

    // Older releases read the single-palette key, so it keeps tracking the
    // palette actually on screen — a downgrade never lands unstyled.
    expect(stored.get('plannotator-color-theme')).toBe('kanagawa-wave');
  });

  test.skipIf(!hasDom)('migrates a stored dark-only palette into the dark half only', async () => {
    stored.set('plannotator-theme', 'system');
    stored.set('plannotator-color-theme', 'kanagawa-wave');
    installMatchMedia(true);

    await mountTheme();
    expect(themeState().darkTheme).toBe('kanagawa-wave');
    expect(themeState().lightTheme).toBe(DEFAULT_COLOR_THEME);
    // The OS is light, so the migrated pair renders its light half — the mode
    // is no longer coerced to keep a dark-only palette on screen.
    expect(themeState().mode).toBe('system');
    expect(themeState().preferredMode).toBe('light');
    expect(themeState().resolvedMode).toBe('light');
    expect(themeState().colorTheme).toBe(DEFAULT_COLOR_THEME);

    // The migrated pair is persisted on arrival — the legacy key it was
    // derived from is immediately overwritten with the active palette.
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

    // The grid opens on the half the user is actually looking at.
    expect(paletteNames()).toContain('Kanagawa Lotus');
    expect(paletteNames()).not.toContain('Kanagawa Wave');

    await act(async () => clickButton(palette('Tinacious')));
    expect(themeState().lightTheme).toBe('tinacious');
    expect(themeState().colorTheme).toBe('tinacious');

    const swatches = palette('Tinacious').querySelectorAll<HTMLElement>('.rounded-full');
    const tinacious = BUILT_IN_THEMES.find(theme => theme.id === 'tinacious');
    if (!tinacious) throw new Error('Tinacious palette is not registered');
    expect(swatches[3]?.style.backgroundColor).toBe(tinacious.colors.light.background);

    // Assigning the other half leaves the visible palette alone.
    await act(async () => clickButton(button('Dark theme')));
    expect(paletteNames()).toContain('Kanagawa Wave');
    expect(paletteNames()).not.toContain('Kanagawa Lotus');

    await act(async () => clickButton(palette('Dracula')));
    expect(themeState().darkTheme).toBe('dracula');
    expect(themeState().mode).toBe('light');
    expect(themeState().colorTheme).toBe('tinacious');

    // The summary names both halves and jumps the grid back to the light one.
    expect(host!.textContent).toContain('Tinacious');
    expect(host!.textContent).toContain('Dracula');
    await act(async () => clickButton(summaryButton('Light:')));
    expect(paletteNames()).toContain('Kanagawa Lotus');
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

    // The host's stored preference is migrated, not discarded.
    expect(themeState().mode).toBe('system');
    expect(themeState().darkTheme).toBe('kanagawa-wave');
    expect(themeState().colorTheme).toBe('kanagawa-wave');
    // And the mirror keeps writing the host's keys, not Plannotator's.
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

  // A cookie-less visit (fresh profile, incognito, cleared cookies) must not
  // write anything to ~/.plannotator/config.json: that POST would land after
  // the server config arrives and reset the user's real theme to defaults.
  test.skipIf(!hasDom)('posts nothing when mounting with no stored preference', async () => {
    // Drain anything an earlier test's debounce still had in flight.
    await drainPendingServerSync(posts);
    installMatchMedia(false);

    await mountThemeFresh();
    await afterServerSyncDebounce();

    expect(posts).toEqual([]);
    // The pair still resolved and was persisted locally.
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

  // The legacy single-palette API was cookie-only before pairs existed, and a
  // host that never installed a serverSync transport has no endpoint to post to.
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
    // The other half keeps the user's assignment.
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
    // Still System: a dark-only palette does not yank the user out of it.
    expect(themeState().mode).toBe('system');
    expect(themeState().colorTheme).toBe('one-light');

    // And it is what renders as soon as the OS goes dark.
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
