/**
 * Syntax highlighting, made ready in idle time after the window's first paint
 * (#2593). The window's scripts are code-split (build/pack-inbox.ts): Pierre's
 * shared highlighter, its themes and each grammar are chunks the Inbox serves.
 * A thread read waits for its fences' grammars before it draws
 * (threadDrawReady.ts), so no fence paints plain; this keeps that wait short
 * and keeps a light/dark switch from painting the fences on screen plain.
 * Once the window is idle it attaches one small grammar (JSON) in the palette's
 * light and dark fence themes, which brings the highlighter and both themes; a
 * thread with code in another language then waits only for its own grammar,
 * and a switch finds its theme already in. It runs again when the palette
 * changes, keeps the theme threadDrawReady attaches grammars in, and draws
 * nothing.
 */

import { useEffect, useLayoutEffect } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useFenceTheme } from '@plannotator/ui/hooks/useFenceTheme';
import { ensureHighlight } from '@plannotator/ui/utils/codeHighlight';
import { resolveFenceTheme, resolveSyntaxTheme } from '@plannotator/ui/utils/syntaxTheme';
import { setDiffThemes, setThreadFenceTheme } from '../threadDrawReady';

/** The grammar attached with the themes: small, and common in agents' messages. */
const WARM_LANG = 'json';

export function WarmCodeHighlight() {
  const theme = useFenceTheme();
  const { colorTheme, resolvedMode } = useTheme();
  const mode = resolvedMode ?? 'dark';
  // On commit, before any read can land (a read is a fetch away): the themes the next read waits in. A render
  // React drops never reaches here, so it cannot leave a theme that was never on screen.
  useLayoutEffect(() => {
    setThreadFenceTheme(theme);
    setDiffThemes(resolveSyntaxTheme(colorTheme, mode));
  }, [theme, colorTheme, mode]);
  useEffect(() => {
    const warm = () => {
      // The theme on screen first: the one the next thread draws in.
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
