import { useEffect, useLayoutEffect } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useFenceTheme } from '@plannotator/ui/hooks/useFenceTheme';
import { ensureHighlight } from '@plannotator/ui/utils/codeHighlight';
import { resolveFenceTheme, resolveSyntaxTheme } from '@plannotator/ui/utils/syntaxTheme';
import { setDiffThemes, setThreadFenceTheme } from '../threadDrawReady';

const WARM_LANG = 'json';

export function WarmCodeHighlight() {
  const theme = useFenceTheme();
  const { colorTheme, resolvedMode } = useTheme();
  const mode = resolvedMode ?? 'dark';
  useLayoutEffect(() => {
    setThreadFenceTheme(theme);
    setDiffThemes(resolveSyntaxTheme(colorTheme, mode));
  }, [theme, colorTheme, mode]);
  useEffect(() => {
    const warm = () => {
      void ensureHighlight(WARM_LANG, theme).then(() => {
        for (const mode of ['light', 'dark'] as const) void ensureHighlight(WARM_LANG, resolveFenceTheme(colorTheme, mode));
      });
    };
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(warm, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 500);
    return () => clearTimeout(id);
  }, [theme, colorTheme]);
  return null;
}
