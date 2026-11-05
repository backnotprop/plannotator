import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react';
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker';
// Vite-inlined worker (base64 blob) — required by the single-file HTML build:
// the review UI ships as one self-contained file, so there is no separate
// asset URL to load a worker script from.
// @ts-expect-error vite ?worker&inline virtual module (no ambient types here)
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker&inline';

/**
 * Worker-pool syntax highlighting (diffshub parity). Without a pool, Pierre
 * tokenizes on the main thread — profiled at >2s of `findNextMatchSync`
 * during a few seconds of scrolling, the dominant cause of scroll chop.
 *
 * Pool sizing mirrors diffshub: min(cores - 1, 3), never 0.
 * `shiki-js` (pure JS regex engine) instead of `shiki-wasm`: the win is
 * moving tokenization OFF the main thread, and the JS engine avoids having
 * to smuggle a .wasm asset into the single-file bundle.
 */
const poolOptions: WorkerPoolOptions = {
  poolSize: Math.min(Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1), 3),
  totalASTLRUCacheSize: 100,
  workerFactory: () => new DiffsWorker() as Worker,
};

const highlighterOptions: WorkerInitializationRenderOptions = {
  preferredHighlighter: 'shiki-js',
  // Wrap tokens with `data-char` so token-level interactions work (Cmd+click
  // code navigation, token hover). Highlighting runs in the worker, and the
  // worker's render options — NOT the per-component onToken*/useTokenTransformer
  // options — decide whether the token transformer runs. Without this, tokens
  // render highlighted but un-interactable and code-nav silently no-ops.
  useTokenTransformer: true,
  // Preload the common languages; anything else resolves on demand.
  langs: ['typescript', 'tsx', 'javascript', 'json', 'css', 'html', 'python', 'go', 'rust', 'sh', 'yaml', 'markdown'],
};

export function ReviewWorkerPoolProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}

// If the pool never reaches 'initialized' (e.g. worker spawn blocked), stop
// waiting and render anyway: Pierre paints code as plaintext immediately and
// applies highlights asynchronously, so a dead pool degrades to unhighlighted
// content — never a blank view.
const POOL_READY_TIMEOUT_MS = 5_000;

// The shared pool's watchdog (guides.show's PoolWatchdog, for a pool that lives as long as the page): a pool whose
// workers fail to start, or that is not initialized in time, is dropped once, and every diff after it draws on the
// main thread without waiting.
let sharedPoolDead = false;
let watchedPool: WorkerPoolManager | undefined;
const sharedPoolListeners = new Set<() => void>();

function watchSharedPool(pool: WorkerPoolManager): void {
  if (watchedPool === pool) return;
  watchedPool = pool;
  if (pool.isInitialized()) return;
  let done = false;
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    done = true;
    clearTimeout(timer);
    unsubscribe?.();
  };
  const dead = () => {
    if (done) return;
    stop();
    console.warn('Plannotator: highlight worker pool did not start — drawing on the main thread.');
    sharedPoolDead = true;
    for (const listener of sharedPoolListeners) listener();
  };
  const timer = setTimeout(dead, POOL_READY_TIMEOUT_MS);
  // The callback fires immediately with the current state.
  unsubscribe = pool.subscribeToStatChanges((stats) => {
    if (stats.workersFailed) dead();
    else if (stats.managerState === 'initialized' && !done) stop();
  });
  if (done) unsubscribe();
}

/**
 * The same pool, for a host that highlights only some diffs in it (the Inbox: only the very large ones, see GuideDiff).
 * It starts on first use and stays for the life of the page; none once its workers failed to start.
 */
export function getSharedWorkerPool(): WorkerPoolManager | undefined {
  if (sharedPoolDead) return undefined;
  const pool = getOrCreateWorkerPoolSingleton({ poolOptions, highlighterOptions });
  watchSharedPool(pool);
  return pool;
}

function subscribeSharedPool(listener: () => void): () => void {
  sharedPoolListeners.add(listener);
  return () => sharedPoolListeners.delete(listener);
}

/** The shared pool when `wanted`, until it is dropped: then undefined, and the caller re-renders on the main thread. */
export function useSharedWorkerPool(wanted: boolean): WorkerPoolManager | undefined {
  const dead = useSyncExternalStore(subscribeSharedPool, () => sharedPoolDead, () => sharedPoolDead);
  return wanted && !dead ? getSharedWorkerPool() : undefined;
}

/**
 * True once the pool finished initializing (or when no pool exists — callers
 * fall back to main-thread rendering). diffshub gates its viewer mount on
 * this so the first tokenization wave never races pool startup.
 */
export function useIsWorkerPoolReadyOrDisabled(): boolean {
  const workerPool = useWorkerPool();
  const [isReady, setIsReady] = useState(() => workerPool?.isInitialized() ?? true);
  const isReadyRef = useRef(isReady);
  useEffect(() => {
    if (workerPool == null) return;
    const timeout = setTimeout(() => {
      if (!isReadyRef.current) {
        console.warn('Plannotator: highlight worker pool not ready after 5s — rendering without waiting.');
        isReadyRef.current = true;
        setIsReady(true);
      }
    }, POOL_READY_TIMEOUT_MS);
    // The callback fires immediately with the current state.
    const unsubscribe = workerPool.subscribeToStatChanges((stats) => {
      const ready = stats.managerState === 'initialized';
      if (ready && !isReadyRef.current) {
        isReadyRef.current = ready;
        setIsReady(ready);
      }
    });
    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [workerPool]);
  return workerPool == null ? true : isReady;
}

// The pool is long-lived and shared; multiple surfaces (all-files view,
// single-file panels) sync the same theme pair. Dedup so each render pass
// issues at most one setRenderOptions round-trip.
let lastSyncedTheme = '';

/**
 * Keeps the worker pool's theme pair in step with the UI theme (diffshub's
 * useWorkerDiffTheme). Component options alone don't reach the workers.
 */
export function useWorkerPoolThemeSync(theme: { dark: string; light: string } | undefined): void {
  const workerPool = useWorkerPool();
  useEffect(() => {
    if (workerPool == null || theme == null) return;
    const key = `${theme.dark}\0${theme.light}`;
    if (key === lastSyncedTheme) return;
    lastSyncedTheme = key;
    workerPool.setRenderOptions({ theme }).catch((err) => {
      // Un-poison the dedup so a later render retries — otherwise one failed
      // round-trip would pin the pool to the wrong theme for the session.
      if (lastSyncedTheme === key) lastSyncedTheme = '';
      console.warn('Plannotator: failed to sync highlight theme to worker pool', err);
    });
  }, [workerPool, theme?.dark, theme?.light]); // eslint-disable-line react-hooks/exhaustive-deps
}
