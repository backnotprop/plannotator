import { useLayoutEffect } from 'react';
import { useConfigValue } from '../config';
import { applyDocumentFont } from '../utils/documentFont';

/**
 * Apply the `documentFontFamily` setting (Settings → Display → Document font)
 * to the document element for as long as the calling component is mounted. A
 * layout effect, so a remembered font is on the page before its first paint.
 * On unmount the theme's font is put back.
 */
export function useDocumentFont(): void {
  const family = useConfigValue('documentFontFamily');
  useLayoutEffect(() => {
    applyDocumentFont(document.documentElement, family);
  }, [family]);
  useLayoutEffect(() => () => applyDocumentFont(document.documentElement, ''), []);
}
