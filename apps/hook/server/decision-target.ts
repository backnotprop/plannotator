import path from "path";

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

export function annotateDecisionTarget(input: {
  bundlePaths?: readonly string[];
  folderPath?: string;
  absolutePath?: string;
}): string | string[] | undefined {
  if (input.bundlePaths && input.bundlePaths.length > 0) return [...input.bundlePaths];
  return input.folderPath || input.absolutePath || undefined;
}

export function targetText(target: string | readonly string[] | undefined): string | undefined {
  if (target === undefined) return undefined;
  if (typeof target === "string") return target || undefined;
  return target.length > 0 ? target.join(", ") : undefined;
}

export const HOST_REVIEW_ID_ENV = "PLANNOTATOR_HOST_REVIEW_ID";

export function takeHostReviewId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[HOST_REVIEW_ID_ENV];
  delete env[HOST_REVIEW_ID_ENV];
  const id = value?.trim().toLowerCase();
  return id && /^pn-[0-9a-f]{6}$/.test(id) ? id : undefined;
}
