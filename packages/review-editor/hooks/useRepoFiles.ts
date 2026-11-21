import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RepoDirEntry, RepoFilesResponse, RepoOnDiskChange, RepoRevisionInfo } from '@plannotator/shared/repo-files';
import type { ReviewFileFilter } from '@plannotator/shared/review-file-filter';


/**
 * The tree's All files: the repository at the diff's new side, fetched from
 * `GET /api/repo-files` the first time All files is shown (a review that stays
 * on Changes never lists the repository), and again when the snapshot changes.
 *
 * Live listings (the working tree) follow the disk: `GET /api/repo-files/stream`
 * says when files changed and the list is fetched again. The diff on screen is
 * never redrawn from here; the review's "Diff out of date" banner offers that.
 *
 * Big repositories come one folder at a time (`lazy`): `loadDir` asks for a
 * folder when it is expanded.
 */
export type RepoFilesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unavailable'; reason: string; message: string }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      revision: RepoRevisionInfo;
      total: number;
      live: boolean;
      truncated: boolean;
      /** Whole list; absent for lazy listings. */
      paths: string[] | null;
      /** Lazy listings: folder → children, filled as folders load. */
      dirs: ReadonlyMap<string, RepoDirEntry[]>;
      onDisk: Readonly<Record<string, RepoOnDiskChange>>;
      /** When the list was last fetched (live: after the latest change). */
      updatedAt: number;
      /** Bumps on every fetch of a live listing after the first. */
      liveVersion: number;
    };

export interface RepoFiles {
  state: RepoFilesState;
  filtering?: boolean;
  /** Lazy listings: fetch one folder's children (no-op when loaded or not lazy). */
  loadDir: (dir: string) => void;
  /** Fetch the listing again. */
  reload: () => void;
}

type ReadyState = Extract<RepoFilesState, { status: 'ready' }>;

export function useRepoFiles({
  enabled,
  snapshotId,
  filter,
  listingVersion,
  fetchImpl = fetch,
  eventSourceImpl = typeof EventSource === 'undefined' ? undefined : EventSource,
}: {
  /** All files is on screen and the session offers it. */
  enabled: boolean;
  snapshotId: string | undefined;
  /** Only for a lazy listing. Its unfiltered listing owns the live stream. */
  filter?: ReviewFileFilter | null;
  /** A refresh of the unfiltered listing also refreshes these folders. */
  listingVersion?: number;
  fetchImpl?: typeof fetch;
  eventSourceImpl?: typeof EventSource;
}): RepoFiles {
  const [state, setState] = useState<RepoFilesState>({ status: 'idle' });
  const [settledFilter, setSettledFilter] = useState<{ snapshot: string; key: string }>();
  const filterQuery = useMemo(
    () => filter ? new URLSearchParams({ include: filter.include, exclude: filter.exclude }).toString() : '',
    [filter],
  );
  const filterKey = filterQuery ? JSON.stringify([snapshotId, listingVersion, filterQuery]) : undefined;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Which snapshot the state describes; a new one starts over.
  const loadedFor = useRef<string | undefined>(undefined);
  const requestSeq = useRef(0);
  const pendingDirs = useRef(new Set<string>());
  const filterRequest = useRef<AbortController | undefined>(undefined);

  const fetchListing = useCallback(
    async (snapshot: string, dir?: string, signal?: AbortSignal): Promise<RepoFilesResponse | { error: string } | null> => {
      const query = `snapshot=${encodeURIComponent(snapshot)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}${filterQuery ? `&${filterQuery}` : ''}`;
      try {
        const response = await fetchImpl(`/api/repo-files?${query}`, signal ? { signal } : undefined);
        if (response.status === 409) return null; // stale: the next snapshot fetches again
        const body = (await response.json()) as RepoFilesResponse | { error: string };
        if (!response.ok && !('available' in body)) return { error: (body as { error?: string }).error ?? `HTTP ${response.status}` };
        return body;
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'The repository could not be listed.' };
      }
    },
    [fetchImpl, filterQuery],
  );

  const load = useCallback(
    async (snapshot: string, { quiet }: { quiet: boolean }) => {
      const seq = ++requestSeq.current;
      pendingDirs.current = new Set();
      filterRequest.current?.abort();
      const request = filterKey ? new AbortController() : undefined;
      filterRequest.current = request;

      function publish(next: RepoFilesState) {
        if (!filterKey) {
          setState(next);
          return;
        }
        startTransition(() => {
          setState(next);
          setSettledFilter({ snapshot, key: filterKey });
        });
      }

      if (!quiet) setState({ status: 'loading' });
      const body = await fetchListing(snapshot, undefined, request?.signal);
      if (seq !== requestSeq.current || request?.signal.aborted || body === null) return;
      if ('error' in body) {
        if (!quiet || filterKey) publish({ status: 'error', message: body.error });
        return;
      }
      if (!body.available) {
        publish({ status: 'unavailable', reason: body.reason, message: body.message });
        return;
      }
      const previous = stateRef.current;
      const dirs = new Map<string, RepoDirEntry[]>();
      if (body.lazy && body.entries) dirs.set(body.dir ?? '', body.entries);
      // A live refresh of a lazy listing re-asks every folder already open.
      const reopen = quiet && !filterKey && previous.status === 'ready' && body.lazy
        ? [...previous.dirs.keys()].filter((d) => d !== '')
        : [];
      const next: ReadyState = {
        status: 'ready',
        revision: body.revision,
        total: body.total,
        live: body.live,
        truncated: body.truncated === true,
        paths: body.paths ?? null,
        dirs,
        onDisk: body.onDisk ?? {},
        updatedAt: Date.now(),
        liveVersion: previous.status === 'ready' && quiet ? previous.liveVersion + 1 : 0,
      };
      publish(next);
      for (const dir of reopen) {
        void fetchListing(snapshot, dir).then((sub) => {
          if (seq !== requestSeq.current || !sub || 'error' in sub || !sub.available || !sub.entries) return;
          setState((current) => {
            if (current.status !== 'ready') return current;
            const merged = new Map(current.dirs);
            merged.set(dir, sub.entries!);
            return { ...current, dirs: merged };
          });
        });
      }
    },
    [fetchListing, filterKey],
  );

  useEffect(() => {
    if (!enabled || !snapshotId) return;
    if (filterKey) {
      loadedFor.current = snapshotId;
      void load(snapshotId, { quiet: true });
      return () => filterRequest.current?.abort();
    }
    if (loadedFor.current === snapshotId && stateRef.current.status !== 'idle' && stateRef.current.status !== 'error') {
      // Shown again after being hidden: nothing watched the disk meanwhile,
      // so list again quietly (the tree stays as it was until the answer).
      if (stateRef.current.status === 'ready' && stateRef.current.live) void load(snapshotId, { quiet: true });
      return;
    }
    loadedFor.current = snapshotId;
    void load(snapshotId, { quiet: false });
  }, [enabled, snapshotId, load, filterKey]);

  // Live: list again after each settled burst of changes on disk.
  const live = state.status === 'ready' && state.live;
  useEffect(() => {
    if (!enabled || filterKey || !live || !snapshotId || !eventSourceImpl) return;
    const source = new eventSourceImpl(`/api/repo-files/stream?snapshot=${encodeURIComponent(snapshotId)}`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type === 'changed') void load(snapshotId, { quiet: true });
      } catch {
        // A malformed event never breaks the tree.
      }
    };
    return () => source.close();
  }, [enabled, filterKey, live, snapshotId, eventSourceImpl, load]);

  const loadDir = useCallback(
    (dir: string) => {
      const current = stateRef.current;
      const snapshot = loadedFor.current;
      if (filterKey && settledFilter?.key !== filterKey) return;
      if (current.status !== 'ready' || current.paths || !snapshot) return;
      const pending = pendingDirs.current;
      if (current.dirs.has(dir) || pending.has(dir)) return;
      pending.add(dir);
      const seq = requestSeq.current;
      const signal = filterRequest.current?.signal;
      void fetchListing(snapshot, dir, signal).then((body) => {
        pending.delete(dir);
        if (seq !== requestSeq.current || signal?.aborted || !body) return;
        if ('error' in body || !body.available || !body.entries) {
          if (filterKey) setState({ status: 'error', message: 'Could not filter repository files.' });
          return;
        }
        setState((latest) => {
          if (latest.status !== 'ready') return latest;
          const dirs = new Map(latest.dirs);
          dirs.set(dir, body.entries!);
          return { ...latest, dirs };
        });
      });
    },
    [fetchListing, filterKey, settledFilter],
  );

  const reload = useCallback(() => {
    if (filterKey) setSettledFilter(undefined);
    if (loadedFor.current) void load(loadedFor.current, { quiet: true });
  }, [load, filterKey]);

  if (filterKey && settledFilter?.key !== filterKey) {
    const pending = settledFilter?.snapshot === snapshotId && state.status === 'ready' ? state : { status: 'loading' } as const;
    return { state: pending, filtering: true, loadDir, reload };
  }

  return { state, loadDir, reload };
}
