import {
  type DiffType,
  type GitDiffOptions,
  type VcsProvider,
  type VcsSelection,
  createGitButlerProvider,
  createGitProvider,
  createJjProvider,
  createVcsApi,
  resolveAvailableDiffType,
  resolveInitialDiffType,
} from "@plannotator/shared/vcs-core";
import {
  detectP4Workspace,
  getP4Context,
  getP4FileContentsForDiff,
  runP4Diff,
} from "./p4";
import { runtime as gitRuntime } from "./git";
import { runtime as gitButlerRuntime } from "./gitbutler";
import { runtime as jjRuntime } from "./jj";
import { gitReviewPolicy } from "@plannotator/shared/git-review-policy";
import { gitButlerReviewPolicy } from "@plannotator/shared/gitbutler-review-policy";
import { jjReviewPolicy } from "@plannotator/shared/jj-review-policy";
import { p4ReviewPolicy } from "@plannotator/shared/p4-review-policy";
import type { PlannotatorConfig } from "@plannotator/shared/config";

const p4Provider: VcsProvider = {
  id: "p4",
  label: "P4",
  reviewPolicy: p4ReviewPolicy,

  async detect(cwd?: string): Promise<boolean> {
    return (await detectP4Workspace(cwd)) !== null;
  },

  ownsDiffType: p4ReviewPolicy.ownsDiffType,

  getContext: getP4Context,

  runDiff(diffType: DiffType, _defaultBranch: string, cwd?: string, _options?: GitDiffOptions) {
    return runP4Diff(diffType, cwd);
  },

  getFileContents(diffType, _defaultBranch, filePath, _oldPath?, cwd?) {
    return getP4FileContentsForDiff(diffType, filePath, cwd);
  },
};

const api = createVcsApi([
  createJjProvider(jjRuntime, gitRuntime, jjReviewPolicy),
  createGitButlerProvider(gitButlerRuntime, gitButlerReviewPolicy),
  createGitProvider(gitRuntime, gitReviewPolicy),
  p4Provider,
], "git");

export const {
  getReviewPolicy: getVcsReviewPolicy,
  resolveReviewDefault: resolveVcsReviewDefault,
  detectVcs,
  detectManagedVcs,
  vcsOwnsDiffType,
  getVcsContext,
  detectRemoteDefaultCompareTarget,
  prepareLocalReviewDiff,
  runVcsDiff,
  getVcsFileContentsForDiff,
  getVcsDiffFingerprint,
  canStageFiles,
  stageFile,
  unstageFile,
  resolveVcsCwd,
  vcsSupportsSnapshot,
  materializeVcsSnapshot,
} = api;

export function resolveConfiguredVcsReviewDefault(
  config: PlannotatorConfig | undefined,
  vcsType?: VcsSelection,
): DiffType {
  return resolveVcsReviewDefault(
    vcsType,
    config?.reviewDefaults,
    config?.diffOptions?.defaultDiffType,
  );
}

export { resolveAvailableDiffType, resolveInitialDiffType, gitRuntime };

export type {
  DiffOption,
  DiffType,
  GitContext,
  GitDiffOptions,
  VcsProvider,
  VcsSelection,
  WorktreeInfo,
} from "@plannotator/shared/vcs-core";

export {
  JJ_TRUNK_REVSET,
  jjCompareTargetRevset,
  jjLineBaseRevset,
  parseCommitDiffType,
  parseRemoteBookmark,
  parseWorktreeDiffType,
  validateFilePath,
} from "@plannotator/shared/vcs-core";
