import { useEffect, useState } from 'react';

/**
 * "Is this document being rendered for paper right now?"
 *
 * Two signals, because neither one alone covers every path:
 *
 *  - `beforeprint` / `afterprint` — what a real Cmd+P and the browser's print
 *    preview fire. Handlers run BEFORE the print snapshot, so a DOM or class
 *    write made from one is in the printed output; a React state update
 *    scheduled from one is not guaranteed to be.
 *  - `matchMedia('print')` change — what headless print emulation
 *    (`page.emulateMedia({ media: 'print' })`) and some preview
 *    implementations fire instead; there the page keeps living in print media,
 *    so async work (a diagram re-render) does land.
 *
 * Firefox may skip `afterprint` when a preview is dismissed, so a
 * `visibilitychange` back to a visible document also exits print mode.
 */
export function subscribePrintMedia(setPrinting: (printing: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onBeforePrint = () => setPrinting(true);
  const onAfterPrint = () => setPrinting(false);
  const onVisibilityChange = () => {
    if (!document.hidden) setPrinting(false);
  };

  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', onAfterPrint);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const query = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
  const onMediaChange = (event: MediaQueryListEvent) => setPrinting(event.matches);
  query?.addEventListener?.('change', onMediaChange);
  if (query?.matches) setPrinting(true);

  return () => {
    window.removeEventListener('beforeprint', onBeforePrint);
    window.removeEventListener('afterprint', onAfterPrint);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    query?.removeEventListener?.('change', onMediaChange);
  };
}

/**
 * React binding over `subscribePrintMedia`. `onEnter` / `onExit` run inside the
 * event handler itself, which is the only place a change is guaranteed to
 * reach a real print snapshot; the returned boolean is the ordinary (async)
 * state for everything that can wait.
 */
export function usePrintMedia(callbacks?: { onEnter?: () => void; onExit?: () => void }): boolean {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    let active = false;
    return subscribePrintMedia((next) => {
      if (next === active) return;
      active = next;
      if (next) callbacks?.onEnter?.();
      else callbacks?.onExit?.();
      setPrinting(next);
    });
    // The callbacks are read through the closure on purpose: re-subscribing on
    // every render would drop the listener mid-print.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return printing;
}
