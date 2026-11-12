import type { ContentSize } from './useDiagramViewport';

function svgLength(value: string | null): number {
  if (value === null) return Number.NaN;
  return Number.parseFloat(value);
}

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
