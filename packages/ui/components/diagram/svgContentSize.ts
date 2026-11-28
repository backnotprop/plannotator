import type { ContentSize } from './useDiagramViewport';

/**
 * The rendered diagram's intrinsic size — a pure read of two svg attributes.
 *
 * It lives apart from `DiagramCanvas` (which re-exports it, so every
 * published path still resolves) because the document's fence block needs
 * it to size its inline box and nothing else of the canvas: importing it
 * from the canvas dragged the whole zoom/pan surface, its viewport hook and
 * lucide into any closure that touched a diagram block. The type import is
 * erased, so this file's runtime dependencies are none.
 */

/**
 * The largest scale an inline diagram is fitted at. A Pele drawing is laid
 * out at the page's text size, so an inline one is never fitted above it (a
 * two-node flowchart would otherwise be blown up to fill the box, its words
 * three times the size of the page's). Unlimited for other drawings, as before.
 */
export function inlineFitMaxScale(svg: SVGSVGElement): number {
  return svg.classList.contains('pele') ? 1 : Number.POSITIVE_INFINITY;
}

/** A numeric svg length: `206`, `206pt`, `206px`. */
function svgLength(value: string | null): number {
  if (value === null) return Number.NaN;
  return Number.parseFloat(value);
}

/** The svg's intrinsic size, from its viewBox (Mermaid and Graphviz always
 * write one), else its `width` / `height` attributes (a `pt` or `px` suffix
 * is accepted, as Graphviz writes them). */
export function svgContentSize(svg: SVGSVGElement): ContentSize | null {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox !== null) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    const width = parts[2];
    const height = parts[3];
    if (
      parts.length === 4 &&
      width !== undefined &&
      height !== undefined &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return { width, height };
    }
  }
  const width = svgLength(svg.getAttribute('width'));
  const height = svgLength(svg.getAttribute('height'));
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}
