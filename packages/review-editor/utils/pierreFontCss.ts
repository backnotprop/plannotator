/**
 * Font override CSS for Pierre's shadow DOM.
 *
 * Single home for the font-family/font-size injection block shared by
 * usePierreTheme (live diff theme) and DiffHunkPreview (synchronous tooltip
 * theme). fontFamily is free text since custom fonts (#851) — escape so a
 * name containing quotes/backslashes can't break out of the CSS string.
 */
export function buildPierreFontCSS(fontFamily?: string, fontSize?: string): string {
  const safeFontFamily = fontFamily?.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (!safeFontFamily && !fontSize) return '';
  return `
      pre, code, [data-line-content], [data-column-number] {
        ${safeFontFamily ? `font-family: '${safeFontFamily}', monospace !important;` : ''}
        ${fontSize ? `font-size: ${fontSize} !important; line-height: 1.5 !important;` : ''}
      }`;
}
