import { useLayoutEffect } from 'react';
import { useConfigValue } from '../config';
import { applyDocumentFont } from '../utils/documentFont';

/** A layout effect, so a remembered font is on the page before its first paint. */
export function useDocumentFont(): void {
  const family = useConfigValue('documentFontFamily');
  useLayoutEffect(() => {
    applyDocumentFont(document.documentElement, family);
  }, [family]);
  useLayoutEffect(() => () => applyDocumentFont(document.documentElement, ''), []);
}
