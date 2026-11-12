import { monoFontStack, normalizeCssFontSize } from '@plannotator/ui/utils/cssFontFamily';

export function buildPierreFontCSS(fontFamily?: string, fontSize?: string): string {
  const stack = monoFontStack(fontFamily);
  const size = normalizeCssFontSize(fontSize);
  if (!stack && !size) return '';
  return `
      pre, code, [data-line-content], [data-column-number] {
        ${stack ? `font-family: ${stack} !important;` : ''}
        ${size ? `font-size: ${size} !important; line-height: 1.5 !important;` : ''}
      }`;
}
