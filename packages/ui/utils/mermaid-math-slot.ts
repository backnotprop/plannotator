/**
 * Mermaid's KaTeX, served from the math renderer slot.
 *
 * Mermaid renders `$$...$$` labels through its own `import("katex")`
 * (`renderKatexUnsanitized` in the runtime; there is no config flag and no
 * hook for it, and chunk emission is static), so a host that registers a
 * `mathRendererLoader` and aliases `./math-default-loader` away still gets a
 * shared `katex-*.js` chunk out of the Mermaid runtime, and a math document
 * fetches two files: the host's loader chunk plus that shared chunk.
 *
 * This module is the alias target that removes it. A host redirects the
 * `katex` specifier, for importers inside the `mermaid` package ONLY, to
 * `@plannotator/ui/utils/mermaid-math-slot` (HANDOFF.md "Lazy renderers and
 * eager entries", item 2). Its default export has the one method Mermaid
 * calls, `renderToString`, and delegates to whatever renderer fills the slot
 * in `./math`: the host's loader result, or the eager KaTeX registration.
 * Mermaid's own options (`throwOnError: true`, `displayMode: true`, the
 * MathML `output` mode) are passed through untouched, so a KaTeX renderer
 * produces exactly the markup Mermaid produced from its direct import.
 *
 * The slot must be filled by the time Mermaid asks: `MermaidBlock` awaits
 * `loadMathRenderer()` before rendering a diagram whose source carries a
 * `$$` label (`hasMermaidMath`), which is a no-op resolve on a filled slot
 * and the host's loader otherwise. An empty slot here means that load
 * failed, and the error below surfaces in the block's error panel with the
 * source, instead of a silently unlabeled node.
 *
 * Nothing imports this module by default: Plannotator never aliases, so its
 * Mermaid keeps its direct KaTeX (inlined by the single-file builds), and
 * this file must never import `katex` itself, or the redirect would re-create
 * the chunk it exists to remove (`tests/entry-assets.test.ts` pins that).
 */

import { getMathRenderer, type MathRenderer } from './math';

/** Mermaid's own test for a math label (`katexRegex` in the runtime). */
const MERMAID_MATH_REGEX = /\$\$(.*)\$\$/;

/** True when a diagram source carries at least one `$$...$$` label. */
export function hasMermaidMath(source: string): boolean {
  return MERMAID_MATH_REGEX.test(source);
}

/** Thrown when Mermaid asks for KaTeX while the math slot is still empty. */
export const MERMAID_MATH_SLOT_EMPTY_MESSAGE =
  'Math label: no math renderer is registered (the mathRendererLoader did not resolve before the diagram rendered)';

const slotRenderer: MathRenderer = {
  renderToString(tex, options) {
    const renderer = getMathRenderer();
    if (!renderer) throw new Error(MERMAID_MATH_SLOT_EMPTY_MESSAGE);
    return renderer.renderToString(tex, options);
  },
};

export default slotRenderer;
