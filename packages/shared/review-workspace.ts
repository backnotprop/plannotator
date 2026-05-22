import type { DiffType, DiffOption, GitContext } from "./review-core";

export interface WorkspaceRepoState {
  id: string;
  label: string;
  cwd: string;
  selected: boolean;
  source: "local";
  diffType?: DiffType;
  gitContext?: GitContext;
  diffOptions?: DiffOption[];
  platformUser: string | null;
  error?: string;
}

export interface WorkspaceReviewState {
  mode: "workspace";
  root: string;
  repos: WorkspaceRepoState[];
}
