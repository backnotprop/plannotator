/**
 * PR/MR provider for Bun runtimes
 *
 * Thin wrapper around shared pr-provider.ts, same pattern as git.ts.
 * Pre-binds a Bun-based runtime so consumers get a clean API.
 */

import { childEnv } from "@plannotator/shared/child-env";
import type {
  PRRef,
  PRMetadata,
  PRContext,
  PRRuntime,
  PRReviewFileComment,
  PRReviewFileLevelComment,
  PRReviewAction,
  PRReviewSubmissionResult,
  PRStackTree,
  PRListItem,
  PRAuthResult,
} from "@plannotator/shared/pr-types";
import {
  parsePRUrl as parsePRUrlCore,
  parseFileLevelComments as parseFileLevelCommentsCore,
  parsePRReviewAction as parsePRReviewActionCore,
  prRefFromMetadata,
  getPlatformLabel,
  getMRLabel,
  getMRNumberLabel,
  getDisplayRepo,
  getCliName,
  getCliInstallUrl,
} from "@plannotator/shared/pr-types";
import {
  checkAuth as checkAuthCore,
  getUser as getUserCore,
  fetchPR as fetchPRCore,
  fetchPRContext as fetchPRContextCore,
  fetchPRFileContent as fetchPRFileContentCore,
  fetchPRFileBytes as fetchPRFileBytesCore,
  fetchPRTree as fetchPRTreeCore,
  submitPRReview as submitPRReviewCore,
  fetchPRViewedFiles as fetchPRViewedFilesCore,
  markPRFilesViewed as markPRFilesViewedCore,
  fetchPRStack as fetchPRStackCore,
  fetchPRList as fetchPRListCore,
} from "@plannotator/shared/pr-provider";

export type { PRAuthResult, PRRef, PRMetadata, PRContext, PRReviewFileComment, PRReviewFileLevelComment, PRReviewSubmissionResult, PRStackTree, PRListItem } from "@plannotator/shared/pr-types";
export { prRefFromMetadata, isSameProject, getPlatformLabel, getMRLabel, getMRNumberLabel, getDisplayRepo, getCliName, getCliInstallUrl, getPRNumber, getPRPlatformCapabilities, getPRHeadFetchSpec, getPRCloneCommand } from "@plannotator/shared/pr-types";
export type { GithubPRMetadata } from "@plannotator/shared/pr-types";

const bunCommandRuntime: PRRuntime = {
  async runCommand(cmd, args, options) {
    const proc = Bun.spawn([cmd, ...args], {
      // The live env, plus (never replacing it) another gh account's token (#2157).
      env: childEnv(options?.env),
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

  async runCommandWithInput(cmd, args, input, options) {
    const proc = Bun.spawn([cmd, ...args], {
      env: childEnv(options?.env),
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

// Tests replace the command runner (setPRCommandRuntimeForTests) so no test
// ever runs the real `gh` / `glab`: the review server calls these at startup
// in PR mode (the platform user, viewed files, PR context).
let testRuntime: PRRuntime | null = null;

const runtime: PRRuntime = {
  runCommand: (cmd, args, options) => (testRuntime ?? bunCommandRuntime).runCommand(cmd, args, options),
  runCommandWithInput: (cmd, args, input, options) => {
    const active = testRuntime ?? bunCommandRuntime;
    if (!active.runCommandWithInput) return Promise.reject(new Error(`${cmd}: this runtime takes no input`));
    return active.runCommandWithInput(cmd, args, input, options);
  },
};

/**
 * Tests only: run every PR platform command through `fake` instead of a real
 * process (null puts the real runner back). Set it inside a test and restore
 * it in afterEach: bun runs every test file in one process.
 */
export function setPRCommandRuntimeForTests(fake: PRRuntime | null): void {
  testRuntime = fake;
}

/** The Bun command runner, exported for non-PR CLI consumers (commit avatars). */
export const prCommandRuntime: PRRuntime = runtime;

export const parsePRUrl = parsePRUrlCore;
export const parseFileLevelComments = parseFileLevelCommentsCore;
export const parsePRReviewAction = parsePRReviewActionCore;

/**
 * Fails when the review cannot start. For a GitHub PR the active gh account
 * cannot see, answers the other signed-in account it will use (`notice`) and
 * that account's token for this run's children (`childEnv`, never print it).
 */
export function checkPRAuth(ref: PRRef): Promise<PRAuthResult> {
  return checkAuthCore(runtime, ref);
}

export function getPRUser(ref: PRRef): Promise<string | null> {
  return getUserCore(runtime, ref);
}

export function fetchPR(
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
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

export function fetchPRFileBytes(ref: PRRef, sha: string, filePath: string, maxBytes: number) {
  return fetchPRFileBytesCore(runtime, ref, sha, filePath, maxBytes);
}

/** Every file of one commit from the platform tree API (All files without a checkout). */
export function fetchPRTree(ref: PRRef, sha: string) {
  return fetchPRTreeCore(runtime, ref, sha);
}

/** Submit a review through the Bun command runtime. */
export function submitPRReview(
  ref: PRRef,
  headSha: string,
  action: PRReviewAction,
  body: string,
  fileComments: PRReviewFileComment[],
  fileLevelComments: PRReviewFileLevelComment[] = [],
): Promise<PRReviewSubmissionResult> {
  return submitPRReviewCore(runtime, ref, headSha, action, body, fileComments, fileLevelComments);
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
