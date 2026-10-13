/**
 * What a CLI session is OF, in full, as this process resolved it: the target
 * a host names in every decision message (`HostResultRecord.target`, the
 * OpenCode bridge's JSON records), in the ready file, and in the `sessions/`
 * registry. Taken from the server's own state, never from the words the agent
 * typed: `QUESTIONS.md` can name two different files.
 */

import path from "path";

/** Review: the PR URL, the patch file (absolute), or the reviewed directory (absolute). Undefined for a patch on stdin. */
export function reviewDecisionTarget(input: {
  prUrl?: string;
  patchFile?: string;
  cwd: string;
  invocationCwd: string;
}): string | undefined {
  if (input.prUrl) return input.prUrl;
  if (input.patchFile !== undefined) {
    return input.patchFile === "-" ? undefined : path.resolve(input.invocationCwd, input.patchFile);
  }
  return path.resolve(input.cwd);
}

/** Annotate: the files of a bundle (in review order), else the folder, else the file path or URL. */
export function annotateDecisionTarget(input: {
  bundlePaths?: readonly string[];
  folderPath?: string;
  absolutePath?: string;
}): string | string[] | undefined {
  if (input.bundlePaths && input.bundlePaths.length > 0) return [...input.bundlePaths];
  return input.folderPath || input.absolutePath || undefined;
}

/** The registry's one-line form of a target: a bundle's paths joined with ", ". */
export function targetText(target: string | readonly string[] | undefined): string | undefined {
  if (target === undefined) return undefined;
  if (typeof target === "string") return target || undefined;
  return target.length > 0 ? target.join(", ") : undefined;
}

export const HOST_REVIEW_ID_ENV = "PLANNOTATOR_HOST_REVIEW_ID";

/**
 * The `pn-` id a host gave the review it started this process for
 * (`PLANNOTATOR_HOST_REVIEW_ID`, set by the Claude Code mod and the OpenCode
 * plugin), recorded in the `sessions/` registry. Read once and scrubbed from
 * the environment, so nothing this process starts inherits it. Anything that
 * is not `pn-` and six hex digits is ignored.
 */
export function takeHostReviewId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[HOST_REVIEW_ID_ENV];
  delete env[HOST_REVIEW_ID_ENV];
  const id = value?.trim().toLowerCase();
  return id && /^pn-[0-9a-f]{6}$/.test(id) ? id : undefined;
}
