import { useLayoutEffect, useState } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { readThemeTokenValues } from '@plannotator/ui/utils/themeTokens';
import { DIFF_COUNT_TOKEN_NAMES, diffCountColors } from '../utils/diffCountColors';

/**
 * The "All changes" row's +/- colours for the palette on screen, read from
 * the live tokens again whenever the palette or mode changes. Undefined until
 * they can be read: the row then falls back to the plain `--success` /
 * `--destructive` tokens.
 */
export function useDiffCountColors(): { additions: string; deletions: string } | undefined {
  const { colorTheme, resolvedMode } = useTheme();
  const [colors, setColors] = useState<{ additions: string; deletions: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const next = diffCountColors(readThemeTokenValues(DIFF_COUNT_TOKEN_NAMES));
    setColors((prev) => (prev?.additions === next?.additions && prev?.deletions === next?.deletions ? prev : next));
  }, [colorTheme, resolvedMode]);
  return colors;
}
