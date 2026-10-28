import { useEffect, useState } from 'react';
import { useTheme } from '../components/ThemeProvider';
import { themesForHalf, type ThemeHalf, type ThemeInfo } from '../utils/themeRegistry';

export interface ThemePaletteHalves {
  /** Which half the picker assigns to. */
  half: ThemeHalf;
  setHalf: (half: ThemeHalf) => void;
  /** The palette each half holds now. */
  pair: Record<ThemeHalf, string>;
  /** The palettes the current half can take, from the registry (so a new palette shows by itself). */
  themes: ThemeInfo[];
  nameOf: (id: string) => string;
  /** Assign a palette to a half (ThemeProvider's setHalfTheme). */
  choose: (half: ThemeHalf, id: string) => void;
}

/**
 * The palette picker's state, without its layout: the half being assigned
 * (it follows the mode on screen, so opening Settings in dark mode edits the
 * dark half first), the pair, and the palettes that half can take. ThemeTab
 * draws it for plan review, annotate and code review; the Inbox draws the
 * same choices in its own Settings rows.
 */
export function useThemePaletteHalves(): ThemePaletteHalves {
  const { lightTheme, darkTheme, setHalfTheme, availableThemes, preferredMode } = useTheme();
  const [half, setHalf] = useState<ThemeHalf>(preferredMode);
  useEffect(() => setHalf(preferredMode), [preferredMode]);
  return {
    half,
    setHalf,
    pair: { light: lightTheme, dark: darkTheme },
    themes: themesForHalf(availableThemes, half),
    nameOf: (id: string) => availableThemes.find(theme => theme.id === id)?.name ?? id,
    choose: setHalfTheme,
  };
}
