import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { storage } from '../utils/storage';
import { BUILT_IN_THEMES, type ThemeInfo } from '../utils/themeRegistry';

export type Mode = 'dark' | 'light' | 'system';

type ThemeProviderState = {
  // Mode (dark/light/system) — backward-compatible with old "theme" API
  theme: Mode;
  setTheme: (mode: Mode) => void;
  mode: Mode;
  setMode: (mode: Mode) => void;
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
  resolvedMode: 'dark',
  colorTheme: 'plannotator',
  setColorTheme: () => null,
  availableThemes: BUILT_IN_THEMES,
});

/** Resolve the class string for a theme + mode combination */
function resolveThemeClasses(themeId: string, effectiveMode: 'dark' | 'light'): string {
  const themeInfo = BUILT_IN_THEMES.find(t => t.id === themeId);
  const modeSupport = themeInfo?.modeSupport ?? 'both';

  let applyLight = effectiveMode === 'light';
  if (modeSupport === 'dark-only') applyLight = false;
  if (modeSupport === 'light-only') applyLight = true;

  return `theme-${themeId}${applyLight ? ' light' : ''}`;
}

/** Sync theme classes on <html> without stripping non-theme classes (e.g. transitions-ready). */
function applyThemeClasses(themeId: string, effectiveMode: 'dark' | 'light'): void {
  const el = document.documentElement;
  const themeClass = `theme-${themeId}`;
  const wantLight = resolveThemeClasses(themeId, effectiveMode).includes(' light');

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
  const [mode, setModeState] = useState<Mode>(
    () => (storage.getItem(storageKey) as Mode) || defaultTheme
  );

  const [colorTheme, setColorThemeState] = useState<string>(
    () => storage.getItem(colorThemeStorageKey) || defaultColorTheme
  );

  const [systemIsLight, setSystemIsLight] = useState(getSystemIsLight);

  // Compute resolved mode once — consumers use this instead of re-querying matchMedia
  const resolvedMode: 'dark' | 'light' = mode === 'system' ? (systemIsLight ? 'light' : 'dark') : mode;

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
    storage.setItem(storageKey, newMode);
    setModeState(newMode);
  }, [storageKey]);

  const setColorTheme = useCallback((newTheme: string) => {
    storage.setItem(colorThemeStorageKey, newTheme);
    setColorThemeState(newTheme);
  }, [colorThemeStorageKey]);

  const value = useMemo<ThemeProviderState>(() => ({
    theme: mode,
    setTheme: setMode,
    mode,
    setMode,
    resolvedMode,
    colorTheme,
    setColorTheme,
    availableThemes: BUILT_IN_THEMES,
  }), [mode, resolvedMode, colorTheme, setMode, setColorTheme]);

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
