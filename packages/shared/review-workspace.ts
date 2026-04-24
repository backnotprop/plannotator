import type { DiffType, DiffOption, GitContext } from "./review-core";
import type { PRMetadata } from "./pr-provider";

export type WorkspaceRepoSource = "local" | "pr";

export interface WorkspacePRCandidate {
  url: string;
  metadata: PRMetadata;
}

export interface WorkspaceRepoState {
  id: string;
  label: string;
  cwd: string;
  selected: boolean;
  source: WorkspaceRepoSource;
  diffType?: DiffType;
  gitContext?: GitContext;
  prMetadata?: PRMetadata;
  discoveredPRs?: WorkspacePRCandidate[];
  diffOptions?: DiffOption[];
  platformUser: string | null;
  viewedFiles?: string[];
  error?: string;
}

export interface WorkspaceReviewState {
  mode: "workspace";
  repos: WorkspaceRepoState[];
}
