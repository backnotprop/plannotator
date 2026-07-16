/**
 * Worktree Pool — manages a set of per-PR git worktrees for a review session.
 *
 * Runtime-agnostic. Uses ReviewGitRuntime for all git operations.
 * Both Bun and Pi servers import this module (Pi via vendor.sh).
 *
 * Each PR visited during a session gets its own worktree, created on first
 * access and cached for the session lifetime. Agents run in their PR's
 * worktree undisturbed by PR switches.
 */

import { join } from "node:path";
import type { ReviewGitRuntime } from "./review-core";
import type { PRMetadata } from "./pr-types";
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

/** A PR checkout is ready, still warming up, or absent from the pool. */
export type PoolCwdResolution =
  | { kind: "ready"; path: string }
  | { kind: "pending" }
  | { kind: "absent" };

/**
 * Resolve a PR's checkout state from the pool. The "pending" case (entry exists
 * but isn't ready) is kept distinct from "absent" so callers don't fall back to
 * the launch repo for a checkout that simply hasn't finished warming up. Shared
 * by both servers' resolvePRLocalCwd so the readiness rule can't drift.
 */
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
  // FETCH_HEAD is shared per-repo state: a creation's PR-head fetch must not
  // run while another creation (or the seeded background warmup) is between
  // its own fetch and `git worktree add`. Serialize all creations through
  // this chain.
  let creationChain: Promise<unknown> = Promise.resolve();
  if (initial) pool.set(initial.prUrl, initial);

  // Seeded background warmup: the initial entry starts ready:false while the
  // caller builds its checkout (fetch/clone) off the request path. ensure()
  // awaits the in-flight warmup instead of starting a duplicate creation.
  // On failure the entry is KEPT as ready:false — resolve() stays undefined so
  // consumers never receive a path that was never created; same-repo ensure()
  // can retry creation once the failed warmup is cleared from pending.
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
      .catch(() => {}); // warmup may complete with nobody awaiting it
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
        const number = metadata.platform === "github" ? metadata.number : metadata.iid;
        const worktreePath = join(config.sessionDir, "pool", `pr-${number}`);
        const refSpec = metadata.platform === "github"
          ? `refs/pull/${number}/head`
          : `refs/merge-requests/${number}/head`;

        await fetchRef(runtime, metadata.baseBranch, { cwd: config.repoDir });
        await ensureObjectAvailable(runtime, metadata.baseSha, { cwd: config.repoDir });
        await fetchRef(runtime, refSpec, { cwd: config.repoDir });

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
      // Wait out in-flight creations first: a warmup or queued ensure() that
      // finishes after the pool is cleared would resurrect its entry and
      // orphan the worktree it just built.
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
