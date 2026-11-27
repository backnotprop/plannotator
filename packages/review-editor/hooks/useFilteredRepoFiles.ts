import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewFileFilter } from '@plannotator/shared/review-file-filter';
import type { RepoFileFilterRequest, RepoFileFilterResponse } from './reviewFileFilter.worker';
import { startRepoFileFilterWorker } from './startRepoFileFilterWorker';
import { useRepoFiles, type RepoFiles } from './useRepoFiles';

interface FilteredRepoFilesOptions {
  repo: RepoFiles;
  enabled: boolean;
  snapshotId?: string;
  filter: ReviewFileFilter | null;
}

interface WorkerJob {
  paths: string[];
  filter: ReviewFileFilter;
  snapshotId?: string;
}

export function useFilteredRepoFiles({
  repo,
  enabled,
  snapshotId,
  filter,
}: FilteredRepoFilesOptions): RepoFiles {
  const ready = repo.state.status === 'ready' ? repo.state : null;
  const paths = ready?.paths;
  const lazy = paths === null;

  const folders = useRepoFiles({
    enabled: enabled && !!filter && lazy,
    snapshotId,
    filter: lazy ? filter : null,
    listingVersion: ready?.liveVersion,
  });

  const job = useMemo<WorkerJob | null>(
    () => filter && paths ? { paths, filter, snapshotId } : null,
    [filter, paths, snapshotId],
  );
  const [result, setResult] = useState<{ job: WorkerJob; paths: string[] }>();
  const [failedJob, setFailedJob] = useState<WorkerJob>();
  const [attempt, setAttempt] = useState(0);

  const worker = useRef<Worker | null>(null);
  const workerPaths = useRef<string[] | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled || !job) return;

    const id = ++requestId.current;
    let cancelled = false;

    async function requestIndex(job: WorkerJob) {
      try {
        const instance = worker.current ?? await startRepoFileFilterWorker();
        if (cancelled) {
          if (instance !== worker.current) instance.terminate();
          return;
        }
        worker.current = instance;

        instance.onerror = () => {
          if (!cancelled) setFailedJob(job);
        };
        instance.onmessage = ({ data }: MessageEvent<RepoFileFilterResponse>) => {
          if (!cancelled && data.id === id) {
            startTransition(() => setResult({ job, paths: data.paths }));
          }
        };

        const { filter, paths } = job;
        const request: RepoFileFilterRequest = { id, filter };
        if (workerPaths.current !== paths) request.paths = paths;

        instance.postMessage(request);
        workerPaths.current = paths;
      } catch {
        if (!cancelled) setFailedJob(job);
      }
    }

    void requestIndex(job);
    return () => {
      cancelled = true;
    };
  }, [enabled, job, attempt]);

  useEffect(() => () => {
    worker.current?.terminate();
    worker.current = null;
    workerPaths.current = null;
  }, []);

  if (!enabled || !filter || !ready) return repo;
  if (lazy) {
    // Until the first filtered folder arrives, keep the original tree visible.
    return folders.state.status === 'loading' || folders.state.status === 'idle'
      ? { ...folders, state: ready }
      : folders;
  }
  if (!job) return repo;

  const failed = failedJob === job;
  return {
    ...repo,
    state: failed
      ? { status: 'error', message: 'Could not filter repository files.' }
      : result?.job.snapshotId === snapshotId && result
        ? { ...ready, paths: result.paths }
        : ready,
    filtering: result?.job !== job && !failed,
    reload() {
      setFailedJob(undefined);
      setAttempt((value) => value + 1);
    },
  };
}
