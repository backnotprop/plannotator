/**
 * Syntax highlighting, made ready in idle time after the window's first paint
 * (#2593). The window's scripts are code-split (build/pack-inbox.ts): Pierre's
 * shared highlighter, its theme and each grammar are chunks the Inbox serves.
 * Inlined, they were there before the first thread opened, so a code fence
 * painted highlighted at once; split, the first fence of a tab would paint
 * plain while they arrive. So once the window is idle this attaches the
 * current fence theme with one small grammar (JSON), which brings the
 * highlighter and the theme; a fence in another language then waits only for
 * its own grammar. It runs again when the theme changes, and draws nothing.
 */

import { useEffect } from 'react';
import { useFenceTheme } from '@plannotator/ui/hooks/useFenceTheme';
import { ensureHighlight } from '@plannotator/ui/utils/codeHighlight';

/** The grammar attached with the theme: small, and common in agents' messages. */
const WARM_LANG = 'json';

export function WarmCodeHighlight() {
  const theme = useFenceTheme();
  useEffect(() => {
    const warm = () => void ensureHighlight(WARM_LANG, theme);
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(warm, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 500);
    return () => clearTimeout(id);
  }, [theme]);
  return null;
}
