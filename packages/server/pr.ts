/**
 * PR/MR provider for Bun runtimes
 *
 * Thin wrapper around shared pr-provider.ts, same pattern as git.ts.
 * Pre-binds a Bun-based runtime so consumers get a clean API.
 */

import type {
  PRRef,
  PRMetadata,
  PRContext,
  PRRuntime,
  PRReviewFileComment,
  PRStackTree,
  PRListItem,
  Platform,
} from "@plannotator/shared/pr-types";
import {
  parsePRUrl as parsePRUrlCore,
  prRefFromMetadata,
  getPlatformLabel,
  getMRLabel,
  getMRNumberLabel,
  getDisplayRepo,
  getCliName,
  getCliInstallUrl,
} from "@plannotator/shared/pr-types";
import {
  detectPlatformCore,
  checkAuth as checkAuthCore,
  getUser as getUserCore,
  fetchPR as fetchPRCore,
  fetchPRContext as fetchPRContextCore,
  fetchPRFileContent as fetchPRFileContentCore,
  submitPRReview as submitPRReviewCore,
  fetchPRViewedFiles as fetchPRViewedFilesCore,
  markPRFilesViewed as markPRFilesViewedCore,
  fetchPRStack as fetchPRStackCore,
  fetchPRList as fetchPRListCore,
  fetchPRDetailedList as fetchPRDetailedListCore,
} from "@plannotator/shared/pr-provider";

export type { PRRef, PRMetadata, PRContext, PRReviewFileComment, PRStackTree, PRListItem, PRDetailedListItem } from "@plannotator/shared/pr-types";
export { prRefFromMetadata, isSameProject, getPlatformLabel, getMRLabel, getMRNumberLabel, getDisplayRepo, getCliName, getCliInstallUrl } from "@plannotator/shared/pr-types";
export type { GithubPRMetadata } from "@plannotator/shared/pr-types";

const runtime: PRRuntime = {
  async runCommand(cmd, args) {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  },

  async runCommandWithInput(cmd, args, input) {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    proc.stdin.write(input);
    proc.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  },
};

export const parsePRUrl = parsePRUrlCore;

/**
 * host → platform is stable for the lifetime of a daemon, but the two PR
 * endpoints keep separate 30s caches and `checkPRAuth` probes again, so an
 * ambiguous self-hosted host could shell out to `glab auth status` several
 * times on a cold dashboard load. Cache the resolved platform per host so the
 * probe runs at most once per host, and bound the probe with a timeout so a
 * slow/unreachable self-hosted host can't hang the dashboard.
 */
const platformCache = new Map<string, Platform>();
const PROBE_TIMEOUT_MS = 5_000;

export async function detectPlatform(host: string): Promise<Platform> {
  const cached = platformCache.get(host);
  if (cached) return cached;

  // PRRuntime.runCommand has no timeout option, so race the whole detection
  // (the only slow path is the `glab auth status` probe inside it) against a
  // timer that resolves to the historical github default. Host-name fast paths
  // resolve synchronously and win the race long before the timer fires.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Platform>((resolve) => {
    timer = setTimeout(() => resolve("github"), PROBE_TIMEOUT_MS);
  });
  try {
    const platform = await Promise.race([detectPlatformCore(runtime, host), timeout]);
    platformCache.set(host, platform);
    return platform;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function checkPRAuth(ref: PRRef): Promise<void> {
  return checkAuthCore(runtime, ref);
}

export function getPRUser(ref: PRRef): Promise<string | null> {
  return getUserCore(runtime, ref);
}

export function fetchPR(
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  return fetchPRCore(runtime, ref);
}

export function fetchPRContext(
  ref: PRRef,
): Promise<PRContext> {
  return fetchPRContextCore(runtime, ref);
}

export function fetchPRFileContent(
  ref: PRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  return fetchPRFileContentCore(runtime, ref, sha, filePath);
}

export function submitPRReview(
  ref: PRRef,
  headSha: string,
  action: "approve" | "comment",
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<void> {
  return submitPRReviewCore(runtime, ref, headSha, action, body, fileComments);
}

export function fetchPRViewedFiles(
  ref: PRRef,
): Promise<Record<string, boolean>> {
  return fetchPRViewedFilesCore(runtime, ref);
}

export function markPRFilesViewed(
  ref: PRRef,
  prNodeId: string,
  filePaths: string[],
  viewed: boolean,
): Promise<void> {
  return markPRFilesViewedCore(runtime, ref, prNodeId, filePaths, viewed);
}

export function fetchPRStack(
  ref: PRRef,
  metadata: PRMetadata,
): Promise<PRStackTree | null> {
  return fetchPRStackCore(runtime, ref, metadata);
}

export function fetchPRList(
  ref: PRRef,
): Promise<PRListItem[]> {
  return fetchPRListCore(runtime, ref);
}

export function fetchPRDetailedList(
  ref: PRRef,
): Promise<import("@plannotator/shared/pr-types").PRDetailedListItem[]> {
  return fetchPRDetailedListCore(runtime, ref);
}
