/**
 * The default math renderer loader: KaTeX's JS only, fetched lazily.
 *
 * This module is the ONLY place in `@plannotator/ui` that names `katex` at
 * runtime (`./math-eager` names it too, but a host chooses to import that).
 * `./math` calls `loadDefaultMathRenderer` only when no host loader is
 * registered (`setMathRendererLoader` / `configurePlannotatorUI({
 * mathRendererLoader })`), so a host that registers one never runs the
 * `import('katex')` below and never requests the chunk it produces.
 *
 * Keeping the import in its own module is what lets a bundler drop the chunk
 * entirely: chunk emission is static, so a host that registers a loader and
 * wants no KaTeX chunk from the package at all points this module at a stub
 * (see HANDOFF.md "Lazy renderers and eager entries", the alias recipe). The
 * stylesheet is deliberately NOT imported here; CSS loading stays the host's
 * job (HANDOFF.md "Math rendering"), and a host that already serves
 * `katex.min.css` would otherwise load it twice.
 */

import type { MathRenderer } from './math';

export function loadDefaultMathRenderer(): Promise<MathRenderer> {
  return import('katex').then((m) => m.default);
}
