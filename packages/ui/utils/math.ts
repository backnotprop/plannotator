/**
 * Math renderer slot.
 *
 * `MathBlock` and inline math read their renderer from this module instead of
 * importing `katex` statically, so a host that bundles by route does not carry
 * KaTeX in every document read. The slot is SYNCHRONOUS: when it is filled
 * before the first render (which is what `./math-eager` does, and what every
 * Plannotator entry imports) the typeset HTML is in the DOM on the first
 * commit, exactly as it was when the import was static. When it is empty the
 * components render the same wrapper element with the TeX source as text,
 * call `loadMathRenderer()`, and re-render typeset once it resolves.
 *
 * This module deliberately has NO runtime import of `katex`: the only place
 * the dependency is named is `./math-default-loader`'s `import('katex')`,
 * which a chunking bundler turns into a lazy chunk and Plannotator's
 * single-file builds inline (the eager entry keeps it in the entry either
 * way). That default is called only while no host loader is registered, and
 * it lives in its own module so a host that registers a loader can alias it
 * away and drop the chunk (see HANDOFF.md "Lazy renderers and eager entries").
 */

import type { KatexOptions } from 'katex';
import { loadDefaultMathRenderer } from './math-default-loader';

/** The subset of KaTeX's API the renderer needs. `katex` itself satisfies it. */
export interface MathRenderer {
  renderToString(tex: string, options?: KatexOptions): string;
}

export type MathRendererLoader = () => Promise<MathRenderer>;

/**
 * Who filled the slot: the eager entry (`./math-eager`), the lazy loader, or a
 * host calling `setMathRenderer` directly. Diagnostic for a host chasing a TeX
 * flash, and the eager value is a build marker: it only reaches a bundle when
 * `./math-eager` is evaluated, which is what `tests/entry-assets.test.ts`
 * asserts on the built single-file HTML.
 */
export type MathRendererSource = 'plannotator-math-eager' | 'loader' | 'host';

let renderer: MathRenderer | null = null;
let rendererSource: MathRendererSource | null = null;
/**
 * The host loader, or `null` while none is registered. `null` is the only
 * state in which `loadMathRenderer()` reaches `loadDefaultMathRenderer` and
 * its `import('katex')`; a registered loader is never backfilled by the
 * default, not even after it rejects.
 */
let loader: MathRendererLoader | null = null;
let pending: Promise<MathRenderer> | null = null;
/**
 * Bumped by `resetMathRenderer()`. A load in flight across a reset must not
 * fill the slot when it lands: the reset promised an empty slot, and the next
 * `loadMathRenderer()` re-invokes the registered loader instead.
 */
let resetEpoch = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Current renderer, or `null` while none is registered. Safe to call during render. */
export function getMathRenderer(): MathRenderer | null {
  return renderer;
}

/** How the current renderer was registered, or `null` while the slot is empty. */
export function getMathRendererSource(): MathRendererSource | null {
  return rendererSource;
}

/** Register a renderer synchronously (what `./math-eager` does with `katex`). */
export function setMathRenderer(next: MathRenderer, source: MathRendererSource = 'host'): void {
  if (renderer === next) return;
  renderer = next;
  rendererSource = source;
  notify();
}

/** Subscribe to slot changes. Shaped for `useSyncExternalStore`. */
export function subscribeMathRenderer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Swap the loader `loadMathRenderer()` uses. Host seam
 * (`configurePlannotatorUI({ mathRendererLoader })`): a host may return a
 * module that imports katex AND its stylesheet in one chunk. A load already in
 * flight keeps going and still fills the slot when it lands (the component
 * that started it is waiting on that result and would otherwise never
 * typeset); the new loader is used from the next `loadMathRenderer()` call
 * that finds the slot empty. Passing `null` unregisters the host loader and
 * restores the package default.
 */
export function setMathRendererLoader(next: MathRendererLoader | null): void {
  loader = next;
  pending = null;
}

/** The registered host loader, or `null` while the package default applies. */
export function getMathRendererLoader(): MathRendererLoader | null {
  return loader;
}

/**
 * Load and register the renderer. Idempotent: a filled slot resolves at once,
 * a load in flight is shared, and a rejected load is dropped so the next call
 * retries instead of failing forever on a transient chunk error.
 */
export function loadMathRenderer(): Promise<MathRenderer> {
  if (renderer) return Promise.resolve(renderer);
  if (!pending) {
    const epoch = resetEpoch;
    const attempt = (loader ? loader() : loadDefaultMathRenderer()).then(
      (loaded) => {
        // A reset since this load started wants the slot empty: hand the
        // result to the caller that awaited it, but do not register it.
        if (epoch === resetEpoch) setMathRenderer(loaded, 'loader');
        return loaded;
      },
      (err: unknown) => {
        if (pending === attempt) pending = null;
        throw err;
      },
    );
    pending = attempt;
  }
  return pending;
}

/**
 * Test hook: empty the slot (renderer and source) and forget any load in
 * flight, so the next `loadMathRenderer()` invokes the loader afresh and a
 * stale in-flight result cannot fill the slot after the reset. The registered
 * loader is KEPT: resetting the renderer is not unregistering the host seam
 * (a host's `configurePlannotatorUI` runs once, before any reset a test issues
 * later). To drop the loader too, call `setMathRendererLoader(null)`.
 */
export function resetMathRenderer(): void {
  renderer = null;
  rendererSource = null;
  pending = null;
  resetEpoch += 1;
  notify();
}

export const normalizeMathTex = (tex: string): string => tex.trim();

/**
 * Render TeX with the pinned option set. `throwOnError: false` and
 * `trust: false` are a deliberate security pin applied to EVERY renderer,
 * including one a host registered: a registered module never widens what
 * document-supplied TeX may do. Returns `null` while no renderer is
 * registered so callers can fall back to the text placeholder.
 */
export function renderMathToHtml(
  tex: string,
  displayMode: boolean,
  activeRenderer: MathRenderer | null = renderer,
): string | null {
  if (!activeRenderer) return null;
  return activeRenderer.renderToString(tex, {
    displayMode,
    throwOnError: false,
    strict: 'warn',
    trust: false,
    output: 'html',
  });
}
