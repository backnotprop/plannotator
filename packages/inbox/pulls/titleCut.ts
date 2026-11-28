/**
 * Whether a compact Reviews row's title is cut on screen (ReviewRow.tsx), for its tooltip: the row shows its full
 * title only while the line cuts it. Only what is drawn is measured: the title's own text, or, a title split so its
 * end stays, the two pieces and the line that holds them. The full title kept for a screen reader (`.ib-sr`) is never
 * measured, and a difference of half a pixel or less is layout rounding, not a cut.
 */

/** How wide an element's text is laid out, and how wide its box's content is, in CSS pixels. */
export interface PartWidths {
  text: number;
  box: number;
}

export type MeasurePart = (el: HTMLElement) => PartWidths;

/**
 * A text wider than its box by no more than this is rounding: nothing a person would see cut. Past it the line draws
 * its "…", so the tooltip shows: a cut under a whole pixel still shows the "…".
 */
export const CUT_TOLERANCE_PX = 0.5;

/** The drawn parts of a row's title (`.ib-rvr-t`): the title itself, or a split title's line, head and tail. */
export function titleParts(title: Element | null | undefined): HTMLElement[] {
  if (typeof HTMLElement === 'undefined' || !(title instanceof HTMLElement)) return [];
  if (!title.hasAttribute('data-reviews-title-split')) return [title];
  return [...title.querySelectorAll<HTMLElement>('.ib-rvr-tin, .ib-rvr-th, .ib-rvr-tt')];
}

export function titleIsCut(title: Element | null | undefined, measure: MeasurePart = measureLayout): boolean {
  return titleParts(title).some((part) => {
    const { text, box } = measure(part);
    return text - box > CUT_TOLERANCE_PX;
  });
}

function measureLayout(el: HTMLElement): PartWidths {
  if (typeof document.createRange !== 'function') return { text: 0, box: 0 };
  const range = document.createRange();
  range.selectNodeContents(el);
  const text = range.getBoundingClientRect?.().width ?? 0;
  const style = getComputedStyle(el);
  const px = (value: string) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  const box = el.getBoundingClientRect().width - px(style.paddingLeft) - px(style.paddingRight) - px(style.borderLeftWidth) - px(style.borderRightWidth);
  return { text, box };
}
