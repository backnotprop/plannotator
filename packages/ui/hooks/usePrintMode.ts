import { useEffect } from 'react';
import { subscribePrintMedia } from './usePrintMedia';

/** Manages print mode by toggling 'plannotator-print' class on <html>. */
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
