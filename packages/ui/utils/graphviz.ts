import type { Viz } from '@viz-js/viz';

export type GraphvizRuntime = Viz;

export type GraphvizRuntimeSource = 'loader' | 'host';

export type GraphvizRuntimeLoader = () => Promise<Viz>;

const defaultGraphvizLoader: GraphvizRuntimeLoader = () => import('@viz-js/viz').then((m) => m.instance());

let runtime: Viz | null = null;
let runtimeSource: GraphvizRuntimeSource | null = null;
let loader: GraphvizRuntimeLoader = defaultGraphvizLoader;
let pending: Promise<Viz> | null = null;

let retryDelayMs = 750;

export function getGraphvizRuntime(): Viz | null {
  return runtime;
}

export function getGraphvizRuntimeSource(): GraphvizRuntimeSource | null {
  return runtimeSource;
}

export function setGraphvizRuntime(next: Viz, source: GraphvizRuntimeSource = 'host'): void {
  runtime = next;
  runtimeSource = source;
  pending = null;
}

export function getGraphvizRetryDelayMs(): number {
  return retryDelayMs;
}

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
