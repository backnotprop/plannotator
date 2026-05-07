import {
  type DiffType,
  type GitDiffOptions,
  type VcsProvider,
  createGitProvider,
  createJjProvider,
  createVcsApi,
  resolveInitialDiffType,
} from "@plannotator/shared/vcs-core";
import {
  detectP4Workspace,
  getP4Context,
  getP4FileContentsForDiff,
  runP4Diff,
} from "./p4";
import { runtime as gitRuntime } from "./git";
import { runtime as jjRuntime } from "./jj";

const p4Provider: VcsProvider = {
  id: "p4",

  async detect(cwd?: string): Promise<boolean> {
    return (await detectP4Workspace(cwd)) !== null;
  },

  ownsDiffType(diffType: string): boolean {
    return diffType === "p4-default" || diffType.startsWith("p4-changelist:");
  },

  getContext: getP4Context,

  runDiff(diffType: DiffType, _defaultBranch: string, cwd?: string, _options?: GitDiffOptions) {
    return runP4Diff(diffType, cwd);
  },

  getFileContents(diffType, _defaultBranch, filePath, _oldPath?, cwd?) {
    return getP4FileContentsForDiff(diffType, filePath, cwd);
  },
};

const api = createVcsApi([
  createJjProvider(jjRuntime),
  createGitProvider(gitRuntime),
  p4Provider,
]);

export const {
  detectVcs,
  getVcsContext,
  detectRemoteDefaultCompareTarget,
  prepareLocalReviewDiff,
  runVcsDiff,
  getVcsFileContentsForDiff,
  canStageFiles,
  stageFile,
  unstageFile,
  resolveVcsCwd,
} = api;

export { resolveInitialDiffType, gitRuntime };

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
  parseRemoteBookmark,
  parseWorktreeDiffType,
  validateFilePath,
} from "@plannotator/shared/vcs-core";
