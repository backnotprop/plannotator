/**
 * Scoped Theme Provider for embedded contexts.
 *
 * Unlike the standard ThemeProvider which modifies document.documentElement,
 * this provider scopes theme classes to a specific container element.
 * This is essential for embedding in environments like Obsidian where
 * we can't modify the root document.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

type Theme = 'dark' | 'light' | 'system';

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  effectiveTheme: 'dark' | 'light';
}

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: 'dark',
  setTheme: () => null,
  effectiveTheme: 'dark',
});

interface ScopedThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  /**
   * The container element to apply theme classes to.
   * If not provided, falls back to finding the nearest .plannotator-root element.
   */
  containerRef?: HTMLElement;
}

export function ScopedThemeProvider({
  children,
  defaultTheme = 'dark',
  storageKey = 'plannotator-theme',
  containerRef,
}: ScopedThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(
    () => (storage.getItem(storageKey) as Theme) || defaultTheme
  );

  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => {
    if (theme === 'system') {
      return typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    }
    return theme;
  });

  // Find the container element
  const getContainer = useCallback((): HTMLElement | null => {
    if (containerRef) return containerRef;
    // Fallback: find the nearest plannotator-root
    if (typeof document !== 'undefined') {
      return document.querySelector('.plannotator-root');
    }
    return null;
  }, [containerRef]);

  // Apply theme class to container
  useEffect(() => {
    const container = getContainer();
    if (!container) return;

    // Remove existing theme class
    container.classList.remove('light', 'dark');

    let resolvedTheme: 'dark' | 'light' = theme === 'system' ? 'dark' : theme;

    if (theme === 'system' && typeof window !== 'undefined') {
      resolvedTheme = window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    }

    // Apply theme class (dark is default, but we add it for explicitness in embedded contexts)
    container.classList.add(resolvedTheme);
    setEffectiveTheme(resolvedTheme);
  }, [theme, getContainer]);

  // Listen for system theme changes
  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => {
      const container = getContainer();
      if (!container) return;

      container.classList.remove('light', 'dark');
      const newTheme = mediaQuery.matches ? 'light' : 'dark';
      container.classList.add(newTheme);
      setEffectiveTheme(newTheme);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme, getContainer]);

  const setTheme = useCallback(
    (newTheme: Theme) => {
      storage.setItem(storageKey, newTheme);
      setThemeState(newTheme);
    },
    [storageKey]
  );

  const value = {
    theme,
    setTheme,
    effectiveTheme,
  };

  return (
    <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>
  );
}

export const useScopedTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error('useScopedTheme must be used within a ScopedThemeProvider');
  }
  return context;
};

// Re-export useTheme as an alias for compatibility
export const useTheme = useScopedTheme;
