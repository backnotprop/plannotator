import { useEffect } from 'react';
import { subscribePrintMedia } from './usePrintMedia';

/**
 * Manages print mode by toggling 'plannotator-print' class on <html>.
 *
 * Driven by `subscribePrintMedia`, so the class is applied for print media
 * emulation (`page.emulateMedia({ media: 'print' })`, which fires no
 * `beforeprint`) as well as for a real print, and is removed again on
 * `afterprint` or on the visibility change Firefox leaves behind when a
 * preview is dismissed without printing.
 */
export function usePrintMode() {
  useEffect(() => {
    const unsubscribe = subscribePrintMedia((printing) => {
      document.documentElement.classList.toggle('plannotator-print', printing);
    });
    return () => {
      unsubscribe();
      document.documentElement.classList.remove('plannotator-print');
    };
  }, []);
}
