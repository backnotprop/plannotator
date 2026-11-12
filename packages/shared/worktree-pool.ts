import { join } from "node:path";
import type { ReviewGitRuntime } from "./review-core";
import { getPRHeadFetchSpec, getPRNumber, type PRMetadata } from "./pr-types";
import { createWorktree, removeWorktree, fetchRef, ensureObjectAvailable } from "./worktree";

export interface PoolEntry {
  path: string;
  prUrl: string;
  number: number;
  ready: boolean;
}

export interface WorktreePoolConfig {
  sessionDir: string;
  repoDir: string;
  isSameRepo: boolean;
}

export interface WorktreePool {
  get(prUrl: string): PoolEntry | undefined;
  has(prUrl: string): boolean;
  resolve(prUrl: string): string | undefined;
  ensure(runtime: ReviewGitRuntime, metadata: PRMetadata): Promise<PoolEntry>;
  entries(): IterableIterator<PoolEntry>;
  cleanup(runtime: ReviewGitRuntime): Promise<void>;
}

export type PoolCwdResolution =
  | { kind: "ready"; path: string }
  | { kind: "pending" }
  | { kind: "absent" };

export function resolvePoolCwd(pool: WorktreePool, prUrl: string): PoolCwdResolution {
  const entry = pool.get(prUrl);
  if (entry?.ready) return { kind: "ready", path: entry.path };
  if (entry) return { kind: "pending" };
  return { kind: "absent" };
}

export function createWorktreePool(
  config: WorktreePoolConfig,
  initial?: PoolEntry,
  initialPending?: Promise<PoolEntry>,
): WorktreePool {
  const pool = new Map<string, PoolEntry>();
  const pending = new Map<string, Promise<PoolEntry>>();
  let creationChain: Promise<unknown> = Promise.resolve();
  if (initial) pool.set(initial.prUrl, initial);

  if (initial && initialPending) {
    const tracked = initialPending.then(
      (entry) => {
        pool.set(initial.prUrl, entry);
        return entry;
      },
      (err) => {
        pending.delete(initial.prUrl);
        throw err;
      },
    );
    pending.set(initial.prUrl, tracked);
    creationChain = tracked.catch(() => {});
    tracked
      .then(() => pending.delete(initial.prUrl))
      .catch(() => {});
  }

  return {
    get(prUrl) { return pool.get(prUrl); },
    has(prUrl) { return pool.has(prUrl); },
    resolve(prUrl) {
      const entry = pool.get(prUrl);
      return entry?.ready ? entry.path : undefined;
    },

    async ensure(runtime, metadata) {
      const existing = pool.get(metadata.url);
      if (existing?.ready) return existing;

      const inflight = pending.get(metadata.url);
      if (inflight) return inflight;

      if (!config.isSameRepo) {
        throw new Error("Cross-repo pool cannot create worktrees for other PRs");
      }

      const create = async (): Promise<PoolEntry> => {
        const number = getPRNumber(metadata);
        const worktreePath = join(config.sessionDir, "pool", `pr-${number}`);
        const head = getPRHeadFetchSpec(metadata);

        await fetchRef(runtime, metadata.baseBranch, { cwd: config.repoDir });
        await ensureObjectAvailable(runtime, metadata.baseSha, { cwd: config.repoDir });
        await fetchRef(runtime, head.ref, { cwd: config.repoDir, ...(head.remote ? { remote: head.remote } : {}) });

        await createWorktree(runtime, {
          ref: "FETCH_HEAD",
          path: worktreePath,
          detach: true,
          cwd: config.repoDir,
        });

        const entry: PoolEntry = { path: worktreePath, prUrl: metadata.url, number, ready: true };
        pool.set(metadata.url, entry);
        return entry;
      };

      const promise = creationChain.then(create, create);
      creationChain = promise.catch(() => {});

      pending.set(metadata.url, promise);
      try {
        return await promise;
      } finally {
        pending.delete(metadata.url);
      }
    },

    entries() { return pool.values(); },

    async cleanup(runtime) {
      while (pending.size > 0) {
        await Promise.all([...pending.values()].map((p) => p.catch(() => {})));
      }
      for (const entry of pool.values()) {
        await removeWorktree(runtime, entry.path, { force: true, cwd: config.repoDir });
      }
      pool.clear();
    },
  };
}
