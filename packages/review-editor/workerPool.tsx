import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react';
// @ts-expect-error vite ?worker&inline virtual module (no ambient types here)
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker&inline';

/**
 * Worker-pool syntax highlighting (diffshub parity). Without a pool, Pierre tokenizes on the main
 * thread — profiled at >2s of `findNextMatchSync` during a few seconds of scrolling, the dominant
 * cause of scroll chop.
 */
const poolOptions: WorkerPoolOptions = {
  poolSize: Math.min(Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1), 3),
  totalASTLRUCacheSize: 100,
  workerFactory: () => new DiffsWorker() as Worker,
};

const highlighterOptions: WorkerInitializationRenderOptions = {
  preferredHighlighter: 'shiki-js',
  // The worker's render options, not per-component ones, decide token wrapping; without this code-nav silently no-ops.
  useTokenTransformer: true,
  langs: ['typescript', 'tsx', 'javascript', 'json', 'css', 'html', 'python', 'go', 'rust', 'sh', 'yaml', 'markdown'],
};

export function ReviewWorkerPoolProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}

// Pierre paints code as plaintext immediately and applies highlights asynchronously, so a dead pool
// degrades to unhighlighted content — never a blank view.
const POOL_READY_TIMEOUT_MS = 5_000;

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
