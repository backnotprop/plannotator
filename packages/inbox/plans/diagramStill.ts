/**
 * A drawn diagram's svg as the markup of a still picture (a face's, a row thumbnail's). An svg drawn as an `<img>` has
 * no page around it, so every `var(--x)` in it is put in first, from where the live page would read it: the svg's own
 * custom properties (Pele writes every colour as `var(--_s)`, `var(--_l)`, … and defines those names, and the theme's
 * `--pele-*` it reads them from, on its own root), then the window's (a themed Mermaid svg reads the page's tokens),
 * then the reference's fallback, else `currentColor`.
 */

const VAR_REF = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;
/** Enough for the longest chain a drawing writes (Pele: `var(--_s)` → `var(--pele-surface,#f3f3f3)` → a colour). */
const ROUNDS = 6;

/**
 * A looked-up value as markup text: it goes into an attribute or a `<style>`, so a quote in it (a theme's
 * `"Inter", system-ui` font) must not end the attribute. A fallback is read from the markup, so it is already escaped.
 */
const asMarkup = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** `css` with every `var(--x)` put in, each name read through `lookup` (empty: not defined). */
export function withVariables(css: string, lookup: (name: string) => string): string {
  let out = css;
  for (let round = 0; round < ROUNDS && out.includes('var('); round++) {
    out = out.replace(VAR_REF, (_, name: string, fallback: string | undefined) => asMarkup(lookup(name).trim()) || fallback?.trim() || 'currentColor');
  }
  return out;
}

/** The svg, sized to its own box, as standalone markup with its variables put in (`page`: the window's root style). */
export function stillDiagramMarkup(svg: SVGSVGElement, page: CSSStyleDeclaration): string {
  const box = svg.viewBox?.baseVal;
  const width = box && box.width > 0 ? box.width : Number.parseFloat(svg.getAttribute('width') ?? '') || 600;
  const height = box && box.height > 0 ? box.height : Number.parseFloat(svg.getAttribute('height') ?? '') || 400;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.style.maxWidth = '';
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const own = svg.style;
  return withVariables(new XMLSerializer().serializeToString(svg), (name) => own.getPropertyValue(name).trim() || page.getPropertyValue(name));
}
