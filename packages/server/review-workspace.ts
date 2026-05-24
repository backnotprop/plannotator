import {
  canStageFiles,
  getVcsContext,
  getVcsFileContentsForDiff,
  runVcsDiff,
  stageFile,
  unstageFile,
} from "./vcs";
import {
  WorkspaceReviewSession,
  type WorkspaceReviewBuildOptions,
  type WorkspaceRepoRuntimeState,
} from "@plannotator/shared/review-workspace";

export {
  WorkspaceReviewSession,
  mapRepoDiffTypeToWorkspaceMode,
  mapWorkspaceModeToRepoDiffType,
  resolveWorkspaceInitialDiffType,
  type WorkspaceDiffType,
  type WorkspaceRepoRuntimeState,
  type WorkspaceReviewPromptContext,
} from "@plannotator/shared/review-workspace";

export {
  aggregateWorkspacePatch,
  discoverWorkspaceRepoPaths,
  prefixWorkspacePatchPaths as prefixPatchPaths,
  resolveWorkspaceFilePath,
  type WorkspacePatchAggregate,
} from "@plannotator/shared/review-workspace-node";

export type LocalWorkspaceReview = WorkspaceReviewSession;

const workspaceRuntime = {
  getVcsContext,
  runVcsDiff,
  getVcsFileContentsForDiff,
  canStageFiles,
  stageFile,
  unstageFile,
};

export async function buildLocalWorkspaceReview(
  root: string,
  options: WorkspaceReviewBuildOptions = {},
): Promise<WorkspaceReviewSession> {
  return WorkspaceReviewSession.create(workspaceRuntime, root, options);
}

export async function buildWorkspaceLocalRepos(
  root: string,
  options: WorkspaceReviewBuildOptions = {},
): Promise<WorkspaceRepoRuntimeState[]> {
  const session = await buildLocalWorkspaceReview(root, options);
  return session.repos;
}
