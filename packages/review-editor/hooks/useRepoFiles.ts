import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepoDirEntry, RepoFilesResponse, RepoOnDiskChange, RepoRevisionInfo } from '@plannotator/shared/repo-files';

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
  /** Lazy listings: fetch one folder's children (no-op when loaded or not lazy). */
  loadDir: (dir: string) => void;
  /** Fetch the listing again. */
  reload: () => void;
}

type ReadyState = Extract<RepoFilesState, { status: 'ready' }>;

export function useRepoFiles({
  enabled,
  snapshotId,
  fetchImpl = fetch,
  eventSourceImpl = typeof EventSource === 'undefined' ? undefined : EventSource,
}: {
  /** All files is on screen and the session offers it. */
  enabled: boolean;
  snapshotId: string | undefined;
  fetchImpl?: typeof fetch;
  eventSourceImpl?: typeof EventSource;
}): RepoFiles {
  const [state, setState] = useState<RepoFilesState>({ status: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  // Which snapshot the state describes; a new one starts over.
  const loadedFor = useRef<string | undefined>(undefined);
  const requestSeq = useRef(0);
  const pendingDirs = useRef(new Set<string>());

  const fetchListing = useCallback(
    async (snapshot: string, dir?: string): Promise<RepoFilesResponse | { error: string } | null> => {
      const query = `snapshot=${encodeURIComponent(snapshot)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`;
      try {
        const response = await fetchImpl(`/api/repo-files?${query}`);
        if (response.status === 409) return null; // stale: the next snapshot fetches again
        const body = (await response.json()) as RepoFilesResponse | { error: string };
        if (!response.ok && !('available' in body)) return { error: (body as { error?: string }).error ?? `HTTP ${response.status}` };
        return body;
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'The repository could not be listed.' };
      }
    },
    [fetchImpl],
  );

  const load = useCallback(
    async (snapshot: string, { quiet }: { quiet: boolean }) => {
      const seq = ++requestSeq.current;
      if (!quiet) setState({ status: 'loading' });
      const body = await fetchListing(snapshot);
      if (seq !== requestSeq.current || body === null) return;
      if ('error' in body) {
        if (!quiet) setState({ status: 'error', message: body.error });
        return;
      }
      if (!body.available) {
        setState({ status: 'unavailable', reason: body.reason, message: body.message });
        return;
      }
      const previous = stateRef.current;
      const dirs = new Map<string, RepoDirEntry[]>();
      if (body.lazy && body.entries) dirs.set(body.dir ?? '', body.entries);
      // A live refresh of a lazy listing re-asks every folder already open.
      const reopen = quiet && previous.status === 'ready' && body.lazy ? [...previous.dirs.keys()].filter((d) => d !== '') : [];
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
      setState(next);
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
    [fetchListing],
  );

  useEffect(() => {
    if (!enabled || !snapshotId) return;
    if (loadedFor.current === snapshotId && stateRef.current.status !== 'idle' && stateRef.current.status !== 'error') {
      // Shown again after being hidden: nothing watched the disk meanwhile,
      // so list again quietly (the tree stays as it was until the answer).
      if (stateRef.current.status === 'ready' && stateRef.current.live) void load(snapshotId, { quiet: true });
      return;
    }
    loadedFor.current = snapshotId;
    pendingDirs.current.clear();
    void load(snapshotId, { quiet: false });
  }, [enabled, snapshotId, load]);

  // Live: list again after each settled burst of changes on disk.
  const live = state.status === 'ready' && state.live;
  useEffect(() => {
    if (!enabled || !live || !snapshotId || !eventSourceImpl) return;
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
  }, [enabled, live, snapshotId, eventSourceImpl, load]);

  const loadDir = useCallback(
    (dir: string) => {
      const current = stateRef.current;
      const snapshot = loadedFor.current;
      if (current.status !== 'ready' || current.paths || !snapshot) return;
      if (current.dirs.has(dir) || pendingDirs.current.has(dir)) return;
      pendingDirs.current.add(dir);
      const seq = requestSeq.current;
      void fetchListing(snapshot, dir).then((body) => {
        pendingDirs.current.delete(dir);
        if (seq !== requestSeq.current || !body || 'error' in body || !body.available || !body.entries) return;
        setState((latest) => {
          if (latest.status !== 'ready') return latest;
          const dirs = new Map(latest.dirs);
          dirs.set(dir, body.entries!);
          return { ...latest, dirs };
        });
      });
    },
    [fetchListing],
  );

  const reload = useCallback(() => {
    if (loadedFor.current) void load(loadedFor.current, { quiet: true });
  }, [load]);

  return { state, loadDir, reload };
}
