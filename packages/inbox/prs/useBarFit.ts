/**
 * The board's bar while PRs are picked keeps one row however narrow the pane (approval "inbox-pr-board-close-safe";
 * the board as Reviews' right pane is about 700 px): the field shortens first ("Filter"), then Start review thread
 * says "Review", then the field is its icon alone. Measured, not guessed: each step is tried on the bar itself
 * (`data-fit`, prs.css) until its row fits its width, again whenever the bar's width or what it holds changes.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export type BarFit = 'full' | 'short' | 'review' | 'icon';
export const BAR_FITS: readonly BarFit[] = ['full', 'short', 'review', 'icon'];

/** The first step whose row fits; the last when none does. `fits` reads the bar as the step left it. */
export function firstFit(apply: (fit: BarFit) => void, fits: () => boolean): BarFit {
  for (const fit of BAR_FITS) {
    apply(fit);
    if (fits()) return fit;
  }
  return BAR_FITS[BAR_FITS.length - 1]!;
}

/** `on`: the bar holds the picks' actions; `content`: what changes their width (counts, Merge shown). */
export function useBarFit(ref: RefObject<HTMLElement | null>, on: boolean, content: string): BarFit {
  const [fit, setFit] = useState<BarFit>('full');
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar || !on) {
      setFit('full');
      return;
    }
    const measure = () => {
      const chosen = firstFit(
        (step) => bar.setAttribute('data-fit', step),
        () => bar.scrollWidth <= bar.clientWidth,
      );
      bar.setAttribute('data-fit', chosen);
      setFit(chosen);
    };
    measure();
    // Words drawn in the fallback font until the Inbox's own arrives measure narrower.
    let live = true;
    void document.fonts?.ready.then(() => live && measure());
    if (typeof ResizeObserver === 'undefined') {
      return () => void (live = false);
    }
    let width = bar.clientWidth;
    const watch = new ResizeObserver(() => {
      if (bar.clientWidth === width) return;
      width = bar.clientWidth;
      measure();
    });
    watch.observe(bar);
    return () => {
      live = false;
      watch.disconnect();
    };
  }, [ref, on, content]);
  return on ? fit : 'full';
}
