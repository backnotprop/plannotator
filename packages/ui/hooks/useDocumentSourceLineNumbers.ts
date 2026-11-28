import { useLayoutEffect } from 'react';
import { useConfigValue } from '../config';

/**
 * Show the `documentSourceLineNumbers` setting (Settings → Display → Source
 * line numbers) for as long as the calling component is mounted: puts
 * `data-doc-source-lines` on the document element while the setting is on,
 * and theme.css then draws each block's label. A host that never calls this
 * never shows labels, whatever the shared cookie says. On unmount the
 * attribute goes.
 */
export function useDocumentSourceLineNumbers(): void {
  const show = useConfigValue('documentSourceLineNumbers');
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-doc-source-lines', show);
  }, [show]);
  useLayoutEffect(() => () => document.documentElement.removeAttribute('data-doc-source-lines'), []);
}
