import { useCallback, useEffect, useRef } from 'react';

/**
 * A phone's pick sheet (the Pull requests board's, the list's picks) is fixed to the bottom and grows with the report, so the window's toast (Close's Undo) would
 * cover its buttons: it marks the Inbox's root (`data-prs-sheet`, its height in `--ib-prs-sheet-h`) and prs.css lifts
 * the toast above it (a mark, not a `:has()` on the root: tests/inbox-page-marks.test.ts).
 */
export function useToastAbove(): (sheet: HTMLDivElement | null) => void {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  return useCallback((sheet: HTMLDivElement | null) => {
    stop.current?.();
    stop.current = null;
    const root = sheet?.closest<HTMLElement>('.pn-inbox');
    if (!sheet || !root) return;
    const say = () => root.style.setProperty('--ib-prs-sheet-h', `${Math.ceil(sheet.getBoundingClientRect().height)}px`);
    root.setAttribute('data-prs-sheet', '');
    say();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(say);
    watch?.observe(sheet);
    stop.current = () => {
      watch?.disconnect();
      root.removeAttribute('data-prs-sheet');
      root.style.removeProperty('--ib-prs-sheet-h');
    };
  }, []);
}
