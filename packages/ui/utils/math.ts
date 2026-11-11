import type { KatexOptions } from 'katex';
import { loadDefaultMathRenderer } from './math-default-loader';

/** The subset of KaTeX's API the renderer needs. */
export interface MathRenderer {
  renderToString(tex: string, options?: KatexOptions): string;
}

export type MathRendererLoader = () => Promise<MathRenderer>;

/**
 * Who filled the slot: the eager entry (`./math-eager`), the lazy loader, or a host calling
 * `setMathRenderer` directly.
 */
export type MathRendererSource = 'plannotator-math-eager' | 'loader' | 'host';

let renderer: MathRenderer | null = null;
let rendererSource: MathRendererSource | null = null;
/**
 * `null` is the only state in which `loadMathRenderer()` reaches `loadDefaultMathRenderer` and
 * its `import('katex')`; a registered loader is never backfilled by the default, not even after
 * it rejects.
 */
let loader: MathRendererLoader | null = null;
let pending: Promise<MathRenderer> | null = null;
/**
 * A load in flight across a reset must not fill the slot when it lands: the reset promised an
 * empty slot, and the next `loadMathRenderer()` re-invokes the registered loader instead.
 */
let resetEpoch = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Current renderer, or `null` while none is registered. */
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

export function subscribeMathRenderer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Swap the loader `loadMathRenderer()` uses. */
export function setMathRendererLoader(next: MathRendererLoader | null): void {
  loader = next;
  pending = null;
}

/** The registered host loader, or `null` while the package default applies. */
export function getMathRendererLoader(): MathRendererLoader | null {
  return loader;
}

/** Load and register the renderer. */
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

/** Test hook: empty the slot (renderer and source) and forget any load in flight. */
export function resetMathRenderer(): void {
  renderer = null;
  rendererSource = null;
  pending = null;
  resetEpoch += 1;
  notify();
}

export const normalizeMathTex = (tex: string): string => tex.trim();

/** Render TeX with the pinned option set. */
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
