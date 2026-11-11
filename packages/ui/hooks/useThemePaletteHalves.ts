import { useEffect, useState } from 'react';
import { useTheme } from '../components/ThemeProvider';
import { themesForHalf, type ThemeHalf, type ThemeInfo } from '../utils/themeRegistry';

export interface ThemePaletteHalves {
  half: ThemeHalf;
  setHalf: (half: ThemeHalf) => void;
  pair: Record<ThemeHalf, string>;
  themes: ThemeInfo[];
  nameOf: (id: string) => string;
  choose: (half: ThemeHalf, id: string) => void;
}

/**
 * The palette picker's state, without its layout: the half being assigned (it follows the mode
 * on screen, so opening Settings in dark mode edits the dark half first).
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
