/**
 * Graphviz runtime slot — the same shape as `./mermaid`, one per engine so
 * a host fills either independently.
 *
 * ONE code path feeds the renderer slot (`./diagram-render`):
 * `loadGraphvizRuntime()`. It resolves at once from a filled slot and
 * otherwise imports the engine lazily: `@viz-js/viz` (about 1.2 MB of
 * Emscripten JS with the wasm inlined) is fetched on the first dot fence, a
 * failed import is dropped from the memo so the next call issues a fresh
 * `import()`, and the block re-attempts once and offers Retry. In
 * Plannotator's single-file builds the import is inlined and resolves from
 * the bundle; a host that bundles by route fetches it on demand.
 *
 * This module has NO static import of `@viz-js/viz`; the only place the
 * dependency is named at runtime is the default loader's `import()`.
 */
import type { Viz } from '@viz-js/viz';

export type GraphvizRuntime = Viz;

/** Who filled the slot. */
export type GraphvizRuntimeSource = 'loader' | 'host';

export type GraphvizRuntimeLoader = () => Promise<Viz>;

/** Default lazy loader: import the engine and instantiate its wasm once. */
const defaultGraphvizLoader: GraphvizRuntimeLoader = () => import('@viz-js/viz').then((m) => m.instance());

let runtime: Viz | null = null;
let runtimeSource: GraphvizRuntimeSource | null = null;
let loader: GraphvizRuntimeLoader = defaultGraphvizLoader;
let pending: Promise<Viz> | null = null;

/** Delay before the one automatic re-attempt after a failed lazy import. */
let retryDelayMs = 750;

/** Current runtime, or `null` while the slot is empty. */
export function getGraphvizRuntime(): Viz | null {
  return runtime;
}

/** How the current runtime was registered, or `null` while the slot is empty. */
export function getGraphvizRuntimeSource(): GraphvizRuntimeSource | null {
  return runtimeSource;
}

/** Register an already-instantiated engine (a host with its own import). */
export function setGraphvizRuntime(next: Viz, source: GraphvizRuntimeSource = 'host'): void {
  runtime = next;
  runtimeSource = source;
  pending = null;
}

/** The renderer's retry delay for the lazy path. */
export function getGraphvizRetryDelayMs(): number {
  return retryDelayMs;
}

/**
 * Resolve the engine: at once from a filled slot, otherwise through the
 * loader. A rejected load is dropped from the memo so the next call (the
 * automatic re-attempt, a later mount, or the Retry button) issues a fresh
 * `import()` instead of replaying the cached rejection.
 */
export function loadGraphvizRuntime(): Promise<Viz> {
  if (runtime) return Promise.resolve(runtime);
  if (!pending) {
    const attempt = loader().then(
      (loaded) => {
        setGraphvizRuntime(loaded, 'loader');
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

/** Test hook: empty the slot, stand in for the lazy import, shorten the retry delay. */
export function __setGraphvizRuntimeLoaderForTests(
  next: GraphvizRuntimeLoader | undefined,
  options?: { retryDelayMs?: number },
): void {
  runtime = null;
  runtimeSource = null;
  pending = null;
  loader = next ?? defaultGraphvizLoader;
  retryDelayMs = options?.retryDelayMs ?? 750;
}
