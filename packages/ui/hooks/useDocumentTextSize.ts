import { useLayoutEffect } from 'react';
import { useConfigValue } from '../config';
import { applyDocumentTextSize, DEFAULT_DOCUMENT_TEXT_SIZE } from '../utils/documentTextSize';

/** A layout effect, so a remembered size is on the page before its first paint. */
export function useDocumentTextSize(): void {
  const size = useConfigValue('documentTextSize');
  useLayoutEffect(() => {
    applyDocumentTextSize(document.documentElement, size);
  }, [size]);
  useLayoutEffect(
    () => () => applyDocumentTextSize(document.documentElement, DEFAULT_DOCUMENT_TEXT_SIZE),
    [],
  );
}
