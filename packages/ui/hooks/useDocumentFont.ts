import { useLayoutEffect } from 'react';
import { useConfigValue } from '../config';
import { applyDocumentFont } from '../utils/documentFont';

export function useDocumentFont(): void {
  const family = useConfigValue('documentFontFamily');
  useLayoutEffect(() => {
    applyDocumentFont(document.documentElement, family);
  }, [family]);
  useLayoutEffect(() => () => applyDocumentFont(document.documentElement, ''), []);
}
