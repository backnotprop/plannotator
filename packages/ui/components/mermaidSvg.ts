// Pure SVG-markup helpers for MermaidBlock. Kept free of React and the
// mermaid library so they can be unit-tested without loading mermaid's
// browser-only `initialize()` (which throws in headless test environments).

// Bake sizing attrs into the SVG markup so they survive repeated
// dangerouslySetInnerHTML re-injection — imperative setAttribute gets wiped.
export function normalizeMermaidSvgMarkup(markup: string): string {
  return markup.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    let next = attrs;

    if (/\bstyle\s*=\s*"/i.test(next)) {
      next = next.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_m, styleVal: string) => {
        const rules = styleVal
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !/^max-width\s*:/i.test(s));
        rules.push('max-width: none');
        return `style="${rules.join('; ')}"`;
      });
    } else {
      next += ' style="max-width: none"';
    }

    if (!/\bpreserveAspectRatio\s*=/i.test(next)) {
      next += ' preserveAspectRatio="xMidYMid meet"';
    }
    if (!/\bheight\s*=/i.test(next)) {
      next += ' height="100%"';
    }

    return `<svg${next}>`;
  });
}
