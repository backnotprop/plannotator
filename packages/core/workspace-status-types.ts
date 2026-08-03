export type WorkspaceFileStatus =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "typechange"
	| "conflicted"
	| "untracked";

export interface WorkspaceFileChange {
	path: string;
	repoRelativePath: string;
	oldPath?: string;
	status: WorkspaceFileStatus;
	additions: number;
	deletions: number;
	staged: boolean;
	unstaged: boolean;
}

export interface WorkspaceStatusPayload {
	available: boolean;
	rootPath: string;
	repoRoot?: string;
	files: Record<string, WorkspaceFileChange>;
	totals: {
		files: number;
		additions: number;
		deletions: number;
	};
	error?: string;
}

export interface GitRepositoryInfo {
	repoRoot: string;
	gitDir: string;
	gitCommonDir: string;
}
