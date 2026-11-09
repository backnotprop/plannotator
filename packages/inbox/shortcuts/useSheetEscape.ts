/**
 * Escape closes an open sheet wherever focus is: a click on nothing leaves focus on the page, and WebKit never moves it
 * to a clicked button. Not a new shortcut: the same Escape, read the way App's pages read it. What already used this
 * key (a composer, a card, a menu: they stop or mark it) and a place to type keep it: a second Escape closes the sheet.
 * Not `selectionToolbarShowing`: ui's toolbar is never on the page these sheets belong to, whose selection toolbar is
 * review-editor's own. Unlike App's Settings path it does not skip `[aria-expanded="true"]`: the sheet's own button is one, and a menu marks the key.
 */

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
