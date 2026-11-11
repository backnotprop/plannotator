import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { configStore } from '../config/configStore';
import { readThemePairCookies, writeThemePairCookies } from '../config/settings';
import { useConfigValue } from '../config/useConfig';
import { storage } from '../utils/storage';
import {
  BUILT_IN_THEMES,
  getUnsupportedMode,
  resolvePairTheme,
  resolveThemeMode,
  seedThemePair,
  setDefaultThemePair,
  themeSupportsHalf,
  type ThemeHalf,
  type ThemeInfo,
  type ThemePair,
} from '../utils/themeRegistry';
import type { Mode } from './themeModes';
import { usePrintMedia } from '../hooks/usePrintMedia';
import { markRootPlatform } from '../utils/platform';

// Kept here because published consumers already import Mode from ThemeProvider.
export type { Mode } from './themeModes';

type ThemeProviderState = {
  theme: Mode;
  setTheme: (mode: Mode) => void;
  mode: Mode;
  setMode: (mode: Mode) => void;
  preferredMode: 'dark' | 'light';
  resolvedMode: 'dark' | 'light';
  colorTheme: string;
  setColorTheme: (theme: string) => void;
  lightTheme: string;
  darkTheme: string;
  setHalfTheme: (half: ThemeHalf, theme: string) => void;
  availableThemes: ThemeInfo[];
  manageFavicon: boolean;
};

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: 'dark',
  setTheme: () => null,
  mode: 'dark',
  setMode: () => null,
  preferredMode: 'dark',
  resolvedMode: 'dark',
  colorTheme: 'plannotator',
  setColorTheme: () => null,
  lightTheme: 'plannotator',
  darkTheme: 'plannotator',
  setHalfTheme: () => null,
  availableThemes: BUILT_IN_THEMES,
  manageFavicon: false,
});

/**
 * Held on <html> while a theme change lands. theme.css sets every transition's duration and
 * delay to 0 s under it, so a switch paints its new colours in one frame.
 */
export const THEME_SWITCHING_CLASS = 'pn-theme-switching';

let themeSwitchHold = 0;

export function holdThemeSwitch(): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  el.classList.add(THEME_SWITCHING_CLASS);
  const hold = ++themeSwitchHold;
  const nextFrame = (cb: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16));
  nextFrame(() => nextFrame(() => {
    if (hold === themeSwitchHold) el.classList.remove(THEME_SWITCHING_CLASS);
  }));
}

/**
 * For a part that redraws in the new theme a step later than the switch (it reads the new
 * colours in a frame callback, say): call this just before that redraw.
 */
export function extendThemeSwitch(): void {
  if (typeof document === 'undefined' || !document.documentElement.classList.contains(THEME_SWITCHING_CLASS)) return;
  holdThemeSwitch();
}

function applyThemeClasses(themeId: string, resolvedMode: 'dark' | 'light'): void {
  const el = document.documentElement;
  const themeClass = `theme-${themeId}`;
  const wantLight = resolvedMode === 'light';
  const unchanged = el.classList.contains(themeClass) && el.classList.contains('light') === wantLight;
  const schemeStale = !!el.style.colorScheme && el.style.colorScheme !== resolvedMode;
  if (unchanged && !schemeStale) return;

  holdThemeSwitch();

  if (schemeStale) el.style.colorScheme = resolvedMode;

  if (unchanged) return;

  for (const cls of Array.from(el.classList)) {
    if (cls.startsWith('theme-')) el.classList.remove(cls);
  }
  el.classList.remove('light');

  el.classList.add(themeClass);
  if (wantLight) el.classList.add('light');
}

function getSystemIsLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Mode;
  defaultColorTheme?: string;
  /**
   * Read when resolving the initial pair and written by the legacy mirror, so a host's
   * already-stored preference survives the upgrade to pairs.
   */
  storageKey?: string;
  colorThemeStorageKey?: string;
  /**
   * OFF by default, and deliberately so: `@plannotator/ui` is installed into host applications
   * with their own branding, and a mounted provider must not silently replace a host page's
   * favicon with Plannotator's.
   */
  manageFavicon?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  defaultColorTheme = 'plannotator',
  storageKey = 'plannotator-theme',
  colorThemeStorageKey = 'plannotator-color-theme',
  manageFavicon = false,
}: ThemeProviderProps) {
  const legacyKeys = useMemo(
    () => ({ mode: storageKey, colorTheme: colorThemeStorageKey }),
    [storageKey, colorThemeStorageKey],
  );

  const [initialPair] = useState<ThemePair>(() => {
    const resolved = readThemePairCookies(legacyKeys)
      ?? seedThemePair(defaultColorTheme, defaultTheme);
    setDefaultThemePair(resolved);
    return resolved;
  });
  const pendingSeed = useRef<ThemePair | null>(initialPair);
  const [, setSeedApplied] = useState(false);

  const storePair = useConfigValue('themePair');
  const pair = pendingSeed.current ?? storePair;
  const mode = pair.mode;
  const faviconStyle = useConfigValue('faviconStyle');

  useEffect(() => {
    if (!manageFavicon) return;
    if (typeof document === 'undefined') return;
    let cancelled = false;
    void import('@plannotator/core/favicon').then(({ faviconDataUrl, faviconLinkType }) => {
      if (cancelled) return;
      let link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      const { type, sizes } = faviconLinkType(faviconStyle);
      link.type = type;
      link.setAttribute('sizes', sizes);
      link.href = faviconDataUrl(faviconStyle);
    });
    return () => {
      cancelled = true;
    };
  }, [faviconStyle, manageFavicon]);

  useEffect(() => {
    const seed = pendingSeed.current;
    if (!seed) return;
    pendingSeed.current = null;
    configStore.seed('themePair', seed);
    setSeedApplied(true);
  }, []);

  const [systemIsLight, setSystemIsLight] = useState(getSystemIsLight);

  const printThemeRef = useRef<{ enter: () => void; exit: () => void }>({ enter: () => {}, exit: () => {} });
  const printing = usePrintMedia({
    // Applied from inside `beforeprint`, because the print snapshot is taken before React would
    // flush the state update below.
    onEnter: () => printThemeRef.current.enter(),
    onExit: () => printThemeRef.current.exit(),
  });

  const screenPreferredMode: 'dark' | 'light' =
    mode === 'system' ? (systemIsLight ? 'light' : 'dark') : mode;
  const preferredMode: 'dark' | 'light' = printing ? 'light' : screenPreferredMode;
  const colorTheme = resolvePairTheme(pair, preferredMode);
  const resolvedMode = resolveThemeMode(colorTheme, preferredMode);

  const applyHalf = useCallback((half: ThemeHalf) => {
    const theme = resolvePairTheme(configStore.get('themePair'), half);
    applyThemeClasses(theme, resolveThemeMode(theme, half));
  }, []);
  printThemeRef.current = {
    enter: () => applyHalf('light'),
    exit: () => applyHalf(screenPreferredMode),
  };

  // Read by the legacy setColorTheme, which must target the half on screen
  // without re-creating its callback on every mode change.
  const preferredModeRef = useRef(preferredMode);
  preferredModeRef.current = preferredMode;

  // [P3 fix] Apply theme class synchronously during initialization to prevent flash of unstyled
  // content.
  if (typeof window !== 'undefined') {
    applyThemeClasses(colorTheme, resolvedMode);
    markRootPlatform();
  }

  useEffect(() => {
    applyThemeClasses(colorTheme, resolvedMode);
  }, [resolvedMode, colorTheme]);

  const committedTheme = useRef<string | null>(null);
  useLayoutEffect(() => {
    const shown = `${colorTheme}:${resolvedMode}`;
    if (committedTheme.current !== null && committedTheme.current !== shown) holdThemeSwitch();
    committedTheme.current = shown;
  }, [resolvedMode, colorTheme]);

  useEffect(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.add('transitions-ready');
    });
  }, []);

  useEffect(() => {
    if (mode !== 'system') return;

    setSystemIsLight(getSystemIsLight());

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => setSystemIsLight(mediaQuery.matches);

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [mode]);

  const setMode = useCallback((newMode: Mode) => {
    configStore.set('themePair', { ...configStore.get('themePair'), mode: newMode });
  }, []);

  const setHalfTheme = useCallback((half: ThemeHalf, newTheme: string) => {
    if (!themeSupportsHalf(newTheme, half)) return;
    configStore.set('themePair', { ...configStore.get('themePair'), [half]: newTheme });
  }, []);

  const setColorTheme = useCallback((newTheme: string) => {
    const current = configStore.get('themePair');
    const unsupported = getUnsupportedMode(newTheme);
    const half: ThemeHalf = unsupported
      ? (unsupported === 'light' ? 'dark' : 'light')
      : preferredModeRef.current;
    configStore.setLocal('themePair', { ...current, [half]: newTheme });
  }, []);

  // Mirror the resolved choice onto the keys older releases read, so a downgrade lands on the
  // user's palette instead of an unstyled first frame.
  useEffect(() => {
    writeThemePairCookies(pair, legacyKeys);
    if (storage.getItem(colorThemeStorageKey) !== colorTheme) {
      storage.setItem(colorThemeStorageKey, colorTheme);
    }
  }, [pair, colorTheme, colorThemeStorageKey, legacyKeys]);

  const value = useMemo<ThemeProviderState>(() => ({
    theme: mode,
    setTheme: setMode,
    mode,
    setMode,
    preferredMode,
    resolvedMode,
    colorTheme,
    setColorTheme,
    lightTheme: pair.light,
    darkTheme: pair.dark,
    setHalfTheme,
    availableThemes: BUILT_IN_THEMES,
    manageFavicon,
  }), [mode, preferredMode, resolvedMode, colorTheme, pair.light, pair.dark, setMode, setColorTheme, setHalfTheme, manageFavicon]);

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
