/**
 * PR/MR provider for Bun runtimes
 *
 * Thin wrapper around shared pr-provider.ts, same pattern as git.ts.
 * Pre-binds a Bun-based runtime so consumers get a clean API.
 */

import {
  type PRRef,
  type PRMetadata,
  type PRContext,
  type PRRuntime,
  type PRReviewFileComment,
  parsePRUrl as parsePRUrlCore,
  checkAuth as checkAuthCore,
  getUser as getUserCore,
  fetchPR as fetchPRCore,
  fetchPRContext as fetchPRContextCore,
  fetchPRFileContent as fetchPRFileContentCore,
  submitPRReview as submitPRReviewCore,
  prRefFromMetadata,
  getPlatformLabel,
  getMRLabel,
  getMRNumberLabel,
  getDisplayRepo,
  getCliName,
  getCliInstallUrl,
} from "@plannotator/shared/pr-provider";

export type { PRRef, PRMetadata, PRContext, PRReviewFileComment } from "@plannotator/shared/pr-provider";
export { prRefFromMetadata, getPlatformLabel, getMRLabel, getMRNumberLabel, getDisplayRepo, getCliName, getCliInstallUrl } from "@plannotator/shared/pr-provider";

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

export function checkAuth(ref: PRRef): Promise<void> {
  return checkAuthCore(runtime, ref);
}

export function getUser(ref: PRRef): Promise<string | null> {
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
