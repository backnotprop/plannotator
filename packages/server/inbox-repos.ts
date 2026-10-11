/**
 * Each Inbox project's git remote, so bare `#123` refs in its messages link to
 * the right forge (#1840).
 *
 * The remote is `origin`, parsed by the same `parseRemoteUrl` /
 * `parseRemoteHost` plan and code review use for `repoInfo`. It is resolved off
 * the request path: once per project just after the Inbox starts listening and
 * when a project is first seen, then again in the background when a read finds
 * it older than `INBOX_REPO_TTL_MS`, with at most `INBOX_REPO_MAX_CONCURRENT`
 * gits at once. A read never waits for git; it answers what the cache holds
 * (null until the first resolve lands). A folder that is not a git
 * repository, a repository without `origin`, an unparseable URL, a git that
 * fails or runs past the timeout: all null, cached like any answer until the
 * TTL runs out.
 */

import type { InboxProjectRepo } from "@plannotator/core/inbox-types";
import { parseRemoteHost, parseRemoteUrl } from "@plannotator/shared/repo";
import { runtime } from "./git";

/** How long a resolved remote counts as fresh before a read refreshes it in the background. */
export const INBOX_REPO_TTL_MS = 5 * 60_000;
/** One `git remote get-url origin` never runs longer than this. */
export const INBOX_REPO_GIT_TIMEOUT_MS = 3_000;
/** At most this many `git remote get-url` run at once. */
export const INBOX_REPO_MAX_CONCURRENT = 4;

/** The repository a project root's `origin` names, or null. Never throws. */
export async function readInboxProjectRepo(root: string, timeoutMs = INBOX_REPO_GIT_TIMEOUT_MS): Promise<InboxProjectRepo | null> {
  try {
    // `prepareGitCommand` (inside runGit) keeps color and pagers out; "forbid"
    // also rules out a credential prompt, though get-url never asks for one.
    const result = await runtime.runGit(["remote", "get-url", "origin"], { cwd: root, timeoutMs, interaction: "forbid" });
    if (result.exitCode !== 0) return null;
    const url = result.stdout.trim();
    const display = parseRemoteUrl(url);
    if (!display) return null;
    return { display, host: parseRemoteHost(url) };
  } catch {
    return null;
  }
}

export interface InboxRepoCache {
  /** The cached repo for a root (null when unknown or none); refreshes it in the background when missing or stale. */
  get(root: string): InboxProjectRepo | null;
  /** Resolve a root now (deduplicated while one is running); resolves once the cache holds the answer. */
  refresh(root: string): Promise<InboxProjectRepo | null>;
}

export function createInboxRepoCache(options: {
  ttlMs?: number;
  now?: () => number;
  read?: (root: string) => Promise<InboxProjectRepo | null>;
  /** At most this many reads run at once; the rest wait their turn. */
  maxConcurrent?: number;
} = {}): InboxRepoCache {
  const ttlMs = options.ttlMs ?? INBOX_REPO_TTL_MS;
  const now = options.now ?? Date.now;
  const read = options.read ?? ((root: string) => readInboxProjectRepo(root));
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? INBOX_REPO_MAX_CONCURRENT);
  const entries = new Map<string, { repo: InboxProjectRepo | null; at: number }>();
  const pending = new Map<string, Promise<InboxProjectRepo | null>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  /** Run one read once a slot is free (an Inbox start with hundreds of projects never forks hundreds of gits). */
  const limited = async (root: string): Promise<InboxProjectRepo | null> => {
    // A finished read hands its slot straight to the next waiter, so the count never overshoots.
    if (running >= maxConcurrent) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await read(root);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };

  const refresh = (root: string): Promise<InboxProjectRepo | null> => {
    const inFlight = pending.get(root);
    if (inFlight) return inFlight;
    const job = limited(root)
      .catch(() => null)
      .then((repo) => {
        entries.set(root, { repo, at: now() });
        return repo;
      })
      .finally(() => pending.delete(root));
    pending.set(root, job);
    return job;
  };

  return {
    get(root) {
      const entry = entries.get(root);
      if (!entry || now() - entry.at >= ttlMs) void refresh(root);
      return entry?.repo ?? null;
    },
    refresh,
  };
}
