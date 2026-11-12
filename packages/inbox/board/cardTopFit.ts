export type CardTopStep = 'icon' | 'back';

export const CARD_TOP_FITS: readonly (readonly CardTopStep[])[] = [[], ['icon'], ['icon', 'back']];

export interface CardTopMeasure {
  overflow: number;
  labelCut: boolean;
}

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

export function clearCardTop(top: HTMLElement): void {
  top.removeAttribute('data-fit');
}
