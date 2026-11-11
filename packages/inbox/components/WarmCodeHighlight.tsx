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
  // On commit, before any read can land: a render React drops never reaches here, so it cannot leave a theme that was never on screen.
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
