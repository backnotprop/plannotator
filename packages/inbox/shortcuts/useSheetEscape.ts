import { useEffect, useRef } from 'react';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from './guards';

export function useSheetEscape(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event) || modalOpen()) return;
      const from = keyTarget(event);
      if (from && (isEditableTarget(from) || inOverlay(from))) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}
