import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { storage } from '../utils/storage';
import {
  BUILT_IN_THEMES,
  normalizeThemeMode,
  resolveThemeMode,
  type ThemeInfo,
} from '../utils/themeRegistry';
import { parseThemeMode, type Mode } from './themeModes';

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
  // Color theme (palette)
  colorTheme: string;
  setColorTheme: (theme: string) => void;
  availableThemes: ThemeInfo[];
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
  availableThemes: BUILT_IN_THEMES,
});

/** Sync theme classes on <html> without stripping non-theme classes (e.g. transitions-ready). */
function applyThemeClasses(themeId: string, resolvedMode: 'dark' | 'light'): void {
  const el = document.documentElement;
  const themeClass = `theme-${themeId}`;
  const wantLight = resolvedMode === 'light';

  if (el.classList.contains(themeClass) && el.classList.contains('light') === wantLight) return;

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
  storageKey?: string;
  colorThemeStorageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  defaultColorTheme = 'plannotator',
  storageKey = 'plannotator-theme',
  colorThemeStorageKey = 'plannotator-color-theme',
}: ThemeProviderProps) {
  const [colorTheme, setColorThemeState] = useState<string>(
    () => storage.getItem(colorThemeStorageKey) || defaultColorTheme
  );

  const [mode, setModeState] = useState<Mode>(() => {
    const storedMode = parseThemeMode(storage.getItem(storageKey), defaultTheme);
    return normalizeThemeMode(colorTheme, storedMode);
  });
  const colorThemeRef = useRef(colorTheme);
  const modeRef = useRef(mode);

  const [systemIsLight, setSystemIsLight] = useState(getSystemIsLight);

  // Keep the OS-resolved preference separate from the mode the palette can render.
  const preferredMode: 'dark' | 'light' =
    mode === 'system' ? (systemIsLight ? 'light' : 'dark') : mode;
  const resolvedMode = resolveThemeMode(colorTheme, preferredMode);

  // [P3 fix] Apply theme class synchronously during initialization to prevent
  // flash of unstyled content. CSS tokens live under .theme-* selectors, so
  // without this the first frame has no valid --background/--foreground.
  if (typeof window !== 'undefined') {
    applyThemeClasses(colorTheme, resolvedMode);
  }

  // Keep class in sync after state changes
  useEffect(() => {
    applyThemeClasses(colorTheme, resolvedMode);
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
    const normalizedMode = normalizeThemeMode(colorThemeRef.current, newMode);
    modeRef.current = normalizedMode;
    storage.setItem(storageKey, normalizedMode);
    setModeState(normalizedMode);
  }, [storageKey]);

  const setColorTheme = useCallback((newTheme: string) => {
    const normalizedMode = normalizeThemeMode(newTheme, modeRef.current);
    colorThemeRef.current = newTheme;
    storage.setItem(colorThemeStorageKey, newTheme);
    if (normalizedMode !== modeRef.current) {
      modeRef.current = normalizedMode;
      storage.setItem(storageKey, normalizedMode);
      setModeState(normalizedMode);
    }
    setColorThemeState(newTheme);
  }, [colorThemeStorageKey, storageKey]);

  // Repair invalid or incompatible values left by older versions at the boundary.
  useEffect(() => {
    if (storage.getItem(storageKey) !== mode) storage.setItem(storageKey, mode);
  }, [mode, storageKey]);

  const value = useMemo<ThemeProviderState>(() => ({
    theme: mode,
    setTheme: setMode,
    mode,
    setMode,
    preferredMode,
    resolvedMode,
    colorTheme,
    setColorTheme,
    availableThemes: BUILT_IN_THEMES,
  }), [mode, preferredMode, resolvedMode, colorTheme, setMode, setColorTheme]);

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
