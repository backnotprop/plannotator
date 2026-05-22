import { resolve } from "node:path";

import type { DiffType } from "./vcs";
import { getVcsContext, runVcsDiff } from "./vcs";
import type { WorkspaceRepoState, WorkspaceReviewState } from "@plannotator/shared/review-workspace";
import {
  buildWorkspaceRepoLabels,
  discoverWorkspaceRepoPaths,
  prefixWorkspacePatchPaths,
} from "@plannotator/shared/review-workspace-node";

export {
  aggregateWorkspacePatch,
  discoverWorkspaceRepoPaths,
  prefixWorkspacePatchPaths as prefixPatchPaths,
  resolveWorkspaceFilePath,
  type WorkspacePatchAggregate,
} from "@plannotator/shared/review-workspace-node";

export interface WorkspaceRepoRuntimeState extends WorkspaceRepoState {
  rawPatch: string;
  gitRef: string;
}

export interface LocalWorkspaceReview extends WorkspaceReviewState {
  root: string;
  repos: WorkspaceRepoRuntimeState[];
}

interface WorkspaceReviewBuildOptions {
  hideWhitespace?: boolean;
}

export async function buildWorkspaceLocalRepos(
  root: string,
  options: WorkspaceReviewBuildOptions = {},
): Promise<WorkspaceRepoRuntimeState[]> {
  const resolvedRoot = resolve(root);
  const repoPaths = discoverWorkspaceRepoPaths(resolvedRoot);
  const labels = buildWorkspaceRepoLabels(resolvedRoot, repoPaths);

  const repos = await Promise.all(repoPaths.map(async (cwd, index) => {
    const label = labels[index];
    try {
      const gitContext = await getVcsContext(cwd, "git");
      const diffType: DiffType = "uncommitted";
      const diffResult = await runVcsDiff(diffType, gitContext.defaultBranch, cwd, {
        hideWhitespace: options.hideWhitespace,
      });
      return {
        id: `repo-${index + 1}`,
        label,
        cwd,
        selected: !!diffResult.patch.trim(),
        source: "local",
        diffType,
        gitContext,
        diffOptions: gitContext.diffOptions,
        platformUser: null,
        rawPatch: prefixWorkspacePatchPaths(diffResult.patch, label),
        gitRef: diffResult.label,
        error: diffResult.error,
      } satisfies WorkspaceRepoRuntimeState;
    } catch (error) {
      return {
        id: `repo-${index + 1}`,
        label,
        cwd,
        selected: false,
        source: "local",
        platformUser: null,
        rawPatch: "",
        gitRef: "",
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkspaceRepoRuntimeState;
    }
  }));

  return repos;
}

export async function buildLocalWorkspaceReview(
  root: string,
  options: WorkspaceReviewBuildOptions = {},
): Promise<LocalWorkspaceReview> {
  return {
    mode: "workspace",
    root: resolve(root),
    repos: await buildWorkspaceLocalRepos(root, options),
  };
}
