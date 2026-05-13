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

export function createWorktreePool(config: WorktreePoolConfig, initial?: PoolEntry): WorktreePool {
  const pool = new Map<string, PoolEntry>();
  const pending = new Map<string, Promise<PoolEntry>>();
  if (initial) pool.set(initial.prUrl, initial);

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

      const promise = (async (): Promise<PoolEntry> => {
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
      })();

      pending.set(metadata.url, promise);
      try {
        return await promise;
      } finally {
        pending.delete(metadata.url);
      }
    },

    entries() { return pool.values(); },

    async cleanup(runtime) {
      for (const entry of pool.values()) {
        await removeWorktree(runtime, entry.path, { force: true, cwd: config.repoDir });
      }
      pool.clear();
    },
  };
}
