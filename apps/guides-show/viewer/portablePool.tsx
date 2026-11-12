import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react';
import workerUrl from '@pierre/diffs/worker/worker.js?worker&url';

type WorkerStrategy = { kind: 'blob' | 'data'; type: 'module' | 'classic' };

const STRATEGIES: readonly WorkerStrategy[] = [
  { kind: 'blob', type: 'classic' },
  { kind: 'blob', type: 'module' },
  { kind: 'data', type: 'classic' },
  { kind: 'data', type: 'module' },
];

const PROBE_TIMEOUT_MS = 1_500;

function toWorkerUrl(source: string, kind: WorkerStrategy['kind']): string {
  if (kind === 'blob') return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:text/javascript;base64,${btoa(binary)}`;
}

function workerOptions(strategy: WorkerStrategy): WorkerOptions | undefined {
  return strategy.type === 'module' ? { type: 'module' } : undefined;
}

function probeStrategy(strategy: WorkerStrategy): { done: Promise<boolean>; cancel(): void } {
  let cancel = () => {};
  const done = new Promise<boolean>((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    cancel = () => finish(false);
    try {
      worker = new Worker(toWorkerUrl('self.postMessage(1)', strategy.kind), workerOptions(strategy));
      worker.onmessage = () => finish(true);
      worker.onerror = () => finish(false);
    } catch {
      finish(false);
    }
  });
  return { done, cancel };
}

export async function preparePortableWorkerFactory(): Promise<(() => Worker) | null> {
  try {
    if (typeof Worker === 'undefined' || typeof fetch === 'undefined') return null;
    const resolved = new URL(workerUrl, import.meta.url).href;
    const response = await fetch(resolved, { mode: 'cors' });
    if (!response.ok) return null;
    const source = await response.text();
    const probes = STRATEGIES.map(probeStrategy);
    let strategy: WorkerStrategy | undefined;
    for (const [i, probe] of probes.entries()) {
      if (await probe.done) { strategy = STRATEGIES[i]; break; }
    }
    for (const probe of probes) probe.cancel();
    if (!strategy) return null;
    const url = toWorkerUrl(source, strategy.kind);
    const options = workerOptions(strategy);
    document.documentElement.dataset.pgrWorker = `${strategy.kind}-${strategy.type}`;
    return () => new Worker(url, options);
  } catch {
    return null;
  }
}

const highlighterOptions: WorkerInitializationRenderOptions = {
  preferredHighlighter: 'shiki-js',
  useTokenTransformer: true,
  langs: ['typescript', 'tsx', 'javascript', 'json', 'css', 'html', 'python', 'go', 'rust', 'sh', 'yaml', 'markdown'],
};

const POOL_READY_TIMEOUT_MS = 4_000;

function PoolWatchdog({ onDead }: { onDead: () => void }) {
  const pool = useWorkerPool();
  useEffect(() => {
    if (pool == null) return;
    if (pool.isInitialized()) return;
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) onDead();
    }, POOL_READY_TIMEOUT_MS);
    const unsubscribe = pool.subscribeToStatChanges((stats) => {
      if (stats.managerState === 'initialized') ready = true;
      if (stats.workersFailed) onDead();
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [pool, onDead]);
  return null;
}

export function PortableWorkerPool({ workerFactory, children }: { workerFactory: () => Worker; children: ReactNode }) {
  const [dead, setDead] = useState(false);
  const onDead = useCallback(() => {
    console.warn('Plannotator: highlight worker pool never initialized — rendering on the main thread.');
    document.documentElement.dataset.pgrHighlighter = 'main-thread';
    setDead(true);
  }, []);
  const poolOptions: WorkerPoolOptions = {
    poolSize: Math.min(Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1), 3),
    totalASTLRUCacheSize: 100,
    workerFactory,
  };
  if (dead) return <>{children}</>;
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <PoolWatchdog onDead={onDead} />
      {children}
    </WorkerPoolContextProvider>
  );
}
