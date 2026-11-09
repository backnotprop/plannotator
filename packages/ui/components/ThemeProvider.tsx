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
  // Mode (dark/light/system) — backward-compatible with old "theme" API
  theme: Mode;
  setTheme: (mode: Mode) => void;
  mode: Mode;
  setMode: (mode: Mode) => void;
  preferredMode: 'dark' | 'light';
  resolvedMode: 'dark' | 'light';
  // Color theme (the palette the current mode renders — pair[preferredMode])
  colorTheme: string;
  setColorTheme: (theme: string) => void;
  // The pair itself: one palette per half, assignable independently
  lightTheme: string;
  darkTheme: string;
  setHalfTheme: (half: ThemeHalf, theme: string) => void;
  availableThemes: ThemeInfo[];
  /**
   * Whether this provider owns the document's favicon. Published so the Settings
   * UI can hide the favicon control on hosts that did not opt in: a knob that
   * changes nothing is worse than no knob.
   */
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
 * Held on <html> while a theme change lands. theme.css sets every transition's
 * duration and delay to 0 s under it, so a switch paints its new colours in one
 * frame. Without it, theme.css's global 150 ms colour transition starts on every
 * element at once, and the page froze for a third of a second before it faded.
 * Only the timing changes: a transition already running (a sheet sliding, a
 * menu fading) keeps going, and hover fades are back when the class goes.
 */
export const THEME_SWITCHING_CLASS = 'pn-theme-switching';

let themeSwitchHold = 0;

/**
 * Hold THEME_SWITCHING_CLASS for the next two frames. Called again (by the
 * swap, then by the commit that follows it), it restarts the two frames, so
 * the hold always outlasts the React commit that redraws the new theme.
 *
 * ThemeProvider calls it on every switch. A host that swaps the theme classes
 * on <html> itself calls it just before its swap, for the same instant switch.
 */
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
 * For a part that redraws in the new theme a step later than the switch (it
 * reads the new colours in a frame callback, say): call this just before that
 * redraw, and while a switch is landing its two frames start again, so the
 * redraw lands without the colour fade too. Outside a switch it does nothing,
 * so calling it on any other change is harmless.
 */
export function extendThemeSwitch(): void {
  if (typeof document === 'undefined' || !document.documentElement.classList.contains(THEME_SWITCHING_CLASS)) return;
  holdThemeSwitch();
}

/**
 * Sync theme classes on <html> without stripping non-theme classes (e.g. transitions-ready).
 *
 * A page that sets an inline `color-scheme` on <html> before its scripts run
 * (Plannotator's packed pages do, so the empty page does not paint white under
 * a dark theme) hands it over here: from the first render it follows the mode
 * on screen, so it never goes stale after a theme switch. A host page that sets
 * none keeps none.
 *
 * Every change of palette or mode passes here (a click in any surface, Match
 * system following the OS, config.json arriving, printing), so this is where
 * the switch is made instant: see THEME_SWITCHING_CLASS.
 */
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

/** Read system preference synchronously */
function getSystemIsLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Mode;
  defaultColorTheme?: string;
  /**
   * Where the mode is stored. Read when resolving the initial pair and written
   * by the legacy mirror, so a host's already-stored preference survives the
   * upgrade to pairs.
   */
  storageKey?: string;
  /**
   * Where the single pre-pair palette is stored. Read as the migration source
   * for both halves and kept in sync with the palette on screen.
   *
   * Note: the two halves themselves are a new concept with no pre-existing
   * host data, so they always live under `plannotator-light-theme` /
   * `plannotator-dark-theme`; these props rename only the two legacy values.
   */
  colorThemeStorageKey?: string;
  /**
   * Opt in to letting this provider own `<link rel="icon">` on the document.
   *
   * OFF by default, and deliberately so: `@plannotator/ui` is installed into
   * host applications with their own branding, and a mounted provider must not
   * silently replace a host page's favicon with Plannotator's. Plannotator's own
   * apps pass `manageFavicon`; hosts opt in only if they want the same feature.
   *
   * The value also gates the Settings favicon control (see ThemeTab), so a host
   * that leaves it off never renders a switch that would do nothing.
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

  // Resolve the pair this provider starts on from ITS OWN storage keys: what
  // the user persisted (migrating a host's pre-pair values), else these props.
  // The config store is a singleton that may already have resolved a default of
  // its own, so storage is asked directly rather than trusting that value.
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
    // Loaded only where the app owns the favicon: the icons' bytes stay out of a
    // host's bundle (the guides.show viewer has a size budget). The page's first
    // frame already shows the chosen icon from the server's /favicon.png.
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

  // Hand the resolved pair to the store as a SEED, not a user choice: seeding
  // writes memory + cookies only. Routing it through set() would queue a
  // server write of a value nobody picked, which (flushing after the server
  // config arrives) would overwrite the user's real ~/.plannotator/config.json
  // theme from any cookie-less visit.
  useEffect(() => {
    const seed = pendingSeed.current;
    if (!seed) return;
    pendingSeed.current = null;
    configStore.seed('themePair', seed);
    setSeedApplied(true);
  }, []);

  const [systemIsLight, setSystemIsLight] = useState(getSystemIsLight);

  // Paper is white: printing renders the LIGHT half of the user's pair, on
  // every surface at once. That is what the print stylesheet has always
  // assumed (white ground, near-black text) and what a dark-palette page could
  // not deliver on its own — a Mermaid label, drawn as HTML inside
  // `<foreignObject>`, took the stylesheet's near-black text onto a near-black
  // node fill and printed illegibly. Light-mode users see no change.
  const printThemeRef = useRef<{ enter: () => void; exit: () => void }>({ enter: () => {}, exit: () => {} });
  const printing = usePrintMedia({
    // Applied from inside `beforeprint`, because the print snapshot is taken
    // before React would flush the state update below. The re-render then
    // applies the same classes, so the two can never disagree.
    onEnter: () => printThemeRef.current.enter(),
    onExit: () => printThemeRef.current.exit(),
  });

  // Keep the OS-resolved preference separate from the half it selects.
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

  // [P3 fix] Apply theme class synchronously during initialization to prevent
  // flash of unstyled content. CSS tokens live under .theme-* selectors, so
  // without this the first frame has no valid --background/--foreground.
  if (typeof window !== 'undefined') {
    applyThemeClasses(colorTheme, resolvedMode);
    // theme.css scopes the Linux-only font-feature rule to this class (#1961).
    markRootPlatform();
  }

  // Keep class in sync after state changes
  useEffect(() => {
    applyThemeClasses(colorTheme, resolvedMode);
  }, [resolvedMode, colorTheme]);

  // The classes were swapped in render, before the tree below redrew in the
  // new theme. Restart the instant-switch hold once that redraw has committed,
  // so the two frames count from the commit however long it took.
  const committedTheme = useRef<string | null>(null);
  useLayoutEffect(() => {
    const shown = `${colorTheme}:${resolvedMode}`;
    if (committedTheme.current !== null && committedTheme.current !== shown) holdThemeSwitch();
    committedTheme.current = shown;
  }, [resolvedMode, colorTheme]);

  // Enable color transitions after mount settles — prevents the global *
  // transition rule from firing during initial load.
  useEffect(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.add('transitions-ready');
    });
  }, []);

  // [P2 fix] Listen for system theme changes AND re-read current value when
  // entering system mode (OS may have changed while pinned to explicit mode)
  useEffect(() => {
    if (mode !== 'system') return;

    // Sync immediately — OS preference may have changed since we last checked
    setSystemIsLight(getSystemIsLight());

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => setSystemIsLight(mediaQuery.matches);

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [mode]);

  const setMode = useCallback((newMode: Mode) => {
    configStore.set('themePair', { ...configStore.get('themePair'), mode: newMode });
  }, []);

  /** Assign one palette to one half of the pair. */
  const setHalfTheme = useCallback((half: ThemeHalf, newTheme: string) => {
    if (!themeSupportsHalf(newTheme, half)) return;
    configStore.set('themePair', { ...configStore.get('themePair'), [half]: newTheme });
  }, []);

  /**
   * Legacy single-palette API, kept for published consumers. It assigns exactly
   * ONE half and changes nothing else:
   *
   *  - a palette that renders both modes goes to the half currently on screen,
   *    leaving the other half's assignment alone;
   *  - a mode-restricted palette goes to the half it supports without touching
   *    the mode, because render-time resolution (`resolveThemeMode`) already
   *    keeps a System user on a palette that can be drawn.
   *
   * Persistence stays cookie-only unless a host installed a serverSync
   * transport, matching the side effects this API had before the pair existed.
   */
  const setColorTheme = useCallback((newTheme: string) => {
    const current = configStore.get('themePair');
    const unsupported = getUnsupportedMode(newTheme);
    const half: ThemeHalf = unsupported
      ? (unsupported === 'light' ? 'dark' : 'light')
      : preferredModeRef.current;
    configStore.setLocal('themePair', { ...current, [half]: newTheme });
  }, []);

  // Mirror the resolved choice onto the keys older releases read, so a
  // downgrade lands on the user's palette instead of an unstyled first frame.
  // The pair itself is written first: a pair migrated from the legacy
  // single-palette key is derived, and the mirror below overwrites the key it
  // was derived from.
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
