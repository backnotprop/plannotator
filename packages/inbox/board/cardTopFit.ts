/**
 * Fitting a phone's opened Board card's top bar on one line (the owner,
 * 2026-11-02, from a phone: the column pill read "In / progress" on two lines
 * and "+ Create thread" ran off the right edge). The bar is ‹ Board, the
 * column pill and the card's thread action (Create thread, or Open thread).
 *
 * Every control keeps its 44 px target and the pill its words. When the row is
 * short it gives way in this order, keeping the first way that fits:
 *   icon  the thread action shows its icon alone ("Create thread" stays its name)
 *   back  the way back shows its chevron alone ("Board" stays its name)
 * A way fits when nothing ends past the row's edge and the pill's label is
 * drawn whole (it may only end in "…" when even the last way is short).
 *
 * As headFit.ts does for the thread header: the rule is pure, and
 * `fitCardTop` tries each way against the page's own layout before paint.
 */

/** One way the bar gives way. */
export type CardTopStep = 'icon' | 'back';

/** The ways to try, best first, as the bar's `data-fit` tokens. */
export const CARD_TOP_FITS: readonly (readonly CardTopStep[])[] = [[], ['icon'], ['icon', 'back']];

/** What one try measured: how far the last control ends past the row's edge, and whether the pill's label is cut. */
export interface CardTopMeasure {
  overflow: number;
  labelCut: boolean;
}

/** Fits: nothing past the edge and the pill's label whole. */
export function cardTopFits({ overflow, labelCut }: CardTopMeasure): boolean {
  return overflow <= 0.5 && !labelCut;
}

function measure(top: HTMLElement): CardTopMeasure {
  const box = top.getBoundingClientRect();
  const end = box.right - (parseFloat(getComputedStyle(top).paddingRight) || 0);
  let right = box.left;
  for (const child of top.children) {
    const r = child.getBoundingClientRect();
    if (r.width > 0) right = Math.max(right, r.right);
  }
  const label = top.querySelector<HTMLElement>('.ib-crdp-col-l');
  return { overflow: right - end, labelCut: label !== null && label.scrollWidth > label.clientWidth + 0.5 };
}

function draw(top: HTMLElement, fit: readonly CardTopStep[]): void {
  if (fit.length > 0) top.setAttribute('data-fit', fit.join(' '));
  else top.removeAttribute('data-fit');
}

/**
 * Tries each way on the bar itself and leaves it drawn the first way that fits
 * (none does: the last). Returns the way drawn; null where there is no layout.
 */
export function fitCardTop(top: HTMLElement): readonly CardTopStep[] | null {
  if (top.getBoundingClientRect().width <= 0) return null;
  const fit =
    CARD_TOP_FITS.find((candidate) => {
      draw(top, candidate);
      return cardTopFits(measure(top));
    }) ?? CARD_TOP_FITS[CARD_TOP_FITS.length - 1]!;
  draw(top, fit);
  return fit;
}

/** Back to the bar's own drawing (a desktop panel): no step taken. */
export function clearCardTop(top: HTMLElement): void {
  top.removeAttribute('data-fit');
}
