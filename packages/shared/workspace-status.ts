import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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

const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024;

function runGit(cwd: string, args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
	const result = spawnSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
	});
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		return { ok: false, error: stderr || `git exited with status ${result.status ?? "unknown"}` };
	}
	return { ok: true, stdout: result.stdout ?? "" };
}

function resolveGitPath(cwd: string, value: string): string {
	return isAbsolute(value) ? value : resolve(cwd, value);
}

function addLineCounts(
	target: Map<string, { additions: number; deletions: number }>,
	source: Map<string, { additions: number; deletions: number }>,
): void {
	for (const [path, counts] of source) {
		const existing = target.get(path) ?? { additions: 0, deletions: 0 };
		target.set(path, {
			additions: existing.additions + counts.additions,
			deletions: existing.deletions + counts.deletions,
		});
	}
}

function combinedLineCounts(
	...sources: Array<Map<string, { additions: number; deletions: number }>>
): Map<string, { additions: number; deletions: number }> {
	const combined = new Map<string, { additions: number; deletions: number }>();
	for (const source of sources) addLineCounts(combined, source);
	return combined;
}

export function getGitRepositoryInfo(cwd: string): GitRepositoryInfo | null {
	const topLevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!topLevel.ok) return null;
	const rawRepoRoot = topLevel.stdout.trim();
	if (!rawRepoRoot) return null;
	let gitCwd: string;
	try {
		gitCwd = realpathSync(resolve(cwd));
	} catch {
		return null;
	}
	const repoRoot = realpathSync(rawRepoRoot);

	const gitDir = runGit(cwd, ["rev-parse", "--git-dir"]);
	const gitCommonDir = runGit(cwd, ["rev-parse", "--git-common-dir"]);

	return {
		repoRoot,
		gitDir: gitDir.ok && gitDir.stdout.trim() ? resolveGitPath(gitCwd, gitDir.stdout.trim()) : resolve(repoRoot, ".git"),
		gitCommonDir: gitCommonDir.ok && gitCommonDir.stdout.trim()
			? resolveGitPath(gitCwd, gitCommonDir.stdout.trim())
			: gitDir.ok && gitDir.stdout.trim()
				? resolveGitPath(gitCwd, gitDir.stdout.trim())
				: resolve(repoRoot, ".git"),
	};
}

function isWithinPath(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function mapStatus(x: string, y: string): WorkspaceFileStatus {
	if (x === "?" || y === "?") return "untracked";
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
	if (x === "R" || y === "R") return "renamed";
	if (x === "C" || y === "C") return "copied";
	if (x === "A" || y === "A") return "added";
	if (x === "D" || y === "D") return "deleted";
	if (x === "T" || y === "T") return "typechange";
	return "modified";
}

function parsePorcelain(output: string): Array<{
	repoRelativePath: string;
	oldRepoRelativePath?: string;
	status: WorkspaceFileStatus;
	staged: boolean;
	unstaged: boolean;
}> {
	const fields = output.split("\0").filter(Boolean);
	const result: Array<{
		repoRelativePath: string;
		oldRepoRelativePath?: string;
		status: WorkspaceFileStatus;
		staged: boolean;
		unstaged: boolean;
	}> = [];

	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		if (record.length < 4) continue;
		const x = record[0] ?? " ";
		const y = record[1] ?? " ";
		const path = record.slice(3);
		let oldPath: string | undefined;
		if (x === "R" || y === "R" || x === "C" || y === "C") {
			oldPath = fields[i + 1];
			i += 1;
		}
		result.push({
			repoRelativePath: path,
			oldRepoRelativePath: oldPath,
			status: mapStatus(x, y),
			staged: x !== " " && x !== "?",
			unstaged: y !== " " && y !== "?",
		});
	}

	return result;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
	const counts = new Map<string, { additions: number; deletions: number }>();
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const parts = record.split("\t");
		if (parts.length < 3) continue;
		const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10);
		const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10);
		let path = parts.slice(2).join("\t");
		if (!path) {
			path = records[i + 2] ?? "";
			i += 2;
		}
		if (!path) continue;
		counts.set(path, {
			additions: Number.isFinite(additions) ? additions : 0,
			deletions: Number.isFinite(deletions) ? deletions : 0,
		});
	}
	return counts;
}

function countTextFileLines(path: string): number {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > TEXT_FILE_MAX_BYTES) return 0;
		const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (text.length === 0) return 0;
		const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
		return trimmed.length === 0 ? 1 : trimmed.split("\n").length;
	} catch {
		return 0;
	}
}

export function getWorkspaceStatusForDirectory(dirPath: string): WorkspaceStatusPayload {
	let rootPath: string;
	try {
		rootPath = realpathSync(resolve(dirPath));
	} catch {
		return {
			available: false,
			rootPath: resolve(dirPath),
			files: {},
			totals: { files: 0, additions: 0, deletions: 0 },
			error: "invalid-directory",
		};
	}
	const repo = getGitRepositoryInfo(rootPath);
	if (!repo) {
		return {
			available: false,
			rootPath,
			files: {},
			totals: { files: 0, additions: 0, deletions: 0 },
			error: "not-a-git-repo",
		};
	}

	const rootPathspec = relative(repo.repoRoot, rootPath).replace(/\\/g, "/") || ".";
	const status = runGit(repo.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rootPathspec]);
	if ("error" in status) {
		return {
			available: false,
			rootPath,
			repoRoot: repo.repoRoot,
			files: {},
			totals: { files: 0, additions: 0, deletions: 0 },
			error: status.error,
		};
	}

	const entries = parsePorcelain(status.stdout);
	const numstat = runGit(repo.repoRoot, ["diff", "--numstat", "-z", "HEAD", "--", rootPathspec]);
	const headLineCounts = numstat.ok ? parseNumstat(numstat.stdout) : new Map<string, { additions: number; deletions: number }>();
	let splitLineCounts: Map<string, { additions: number; deletions: number }> | null = null;
	if (entries.some((entry) => entry.staged && entry.unstaged)) {
		const cached = runGit(repo.repoRoot, ["diff", "--cached", "--numstat", "-z", "--", rootPathspec]);
		const unstaged = runGit(repo.repoRoot, ["diff", "--numstat", "-z", "--", rootPathspec]);
		splitLineCounts = combinedLineCounts(
			cached.ok ? parseNumstat(cached.stdout) : new Map<string, { additions: number; deletions: number }>(),
			unstaged.ok ? parseNumstat(unstaged.stdout) : new Map<string, { additions: number; deletions: number }>(),
		);
	}

	const files: Record<string, WorkspaceFileChange> = {};
	let totalAdditions = 0;
	let totalDeletions = 0;

	for (const entry of entries) {
		const absolutePath = resolve(repo.repoRoot, entry.repoRelativePath);
		if (!isWithinPath(absolutePath, rootPath)) continue;

		const lineCounts = entry.staged && entry.unstaged && splitLineCounts ? splitLineCounts : headLineCounts;
		const counts = lineCounts.get(entry.repoRelativePath) ?? { additions: 0, deletions: 0 };
		const oldCounts = entry.oldRepoRelativePath
			? lineCounts.get(entry.oldRepoRelativePath) ?? { additions: 0, deletions: 0 }
			: { additions: 0, deletions: 0 };
		const countedAdditions = counts.additions + oldCounts.additions;
		const additions = (entry.status === "untracked" || entry.status === "added") && countedAdditions === 0
			? countTextFileLines(absolutePath)
			: countedAdditions;
		const deletions = counts.deletions + oldCounts.deletions;
		const oldPath = entry.oldRepoRelativePath
			? resolve(repo.repoRoot, entry.oldRepoRelativePath)
			: undefined;

		files[absolutePath] = {
			path: absolutePath,
			repoRelativePath: entry.repoRelativePath,
			oldPath,
			status: entry.status,
			additions,
			deletions,
			staged: entry.staged,
			unstaged: entry.unstaged,
		};
		totalAdditions += additions;
		totalDeletions += deletions;
	}

	return {
		available: true,
		rootPath,
		repoRoot: repo.repoRoot,
		files,
		totals: {
			files: Object.keys(files).length,
			additions: totalAdditions,
			deletions: totalDeletions,
		},
	};
}

export function getWorkspaceStatusRelativePaths(
	status: WorkspaceStatusPayload,
	dirPath: string,
	filter?: (relativePath: string, change: WorkspaceFileChange) => boolean,
): string[] {
	let rootPath: string;
	try {
		rootPath = realpathSync(resolve(dirPath));
	} catch {
		return [];
	}
	const paths: string[] = [];
	for (const change of Object.values(status.files)) {
		const rel = relative(rootPath, change.path).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		if (filter && !filter(rel, change)) continue;
		paths.push(rel);
	}
	return paths;
}

export function filterWorkspaceStatusForDirectory(
	status: WorkspaceStatusPayload,
	dirPath: string,
	filter?: (relativePath: string, change: WorkspaceFileChange) => boolean,
): WorkspaceStatusPayload {
	if (!status.available) return status;
	let rootPath = status.rootPath || resolve(dirPath);
	try {
		rootPath = status.rootPath || realpathSync(resolve(dirPath));
	} catch {
		// Fall back to the resolved input when the directory disappeared between calls.
	}
	const files: Record<string, WorkspaceFileChange> = {};
	let additions = 0;
	let deletions = 0;
	for (const change of Object.values(status.files)) {
		const rel = relative(rootPath, change.path).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		if (filter && !filter(rel, change)) continue;
		files[change.path] = change;
		additions += change.additions;
		deletions += change.deletions;
	}
	return {
		...status,
		files,
		totals: {
			files: Object.keys(files).length,
			additions,
			deletions,
		},
	};
}

export function getGitMetadataWatchPaths(cwd: string): string[] {
	const repo = getGitRepositoryInfo(cwd);
	if (!repo) return [];
	const candidates = [
		resolve(repo.gitDir, "HEAD"),
		resolve(repo.gitDir, "index"),
		resolve(repo.gitDir, "MERGE_HEAD"),
		resolve(repo.gitDir, "rebase-merge"),
		resolve(repo.gitDir, "rebase-apply"),
		resolve(repo.gitCommonDir, "HEAD"),
		resolve(repo.gitCommonDir, "packed-refs"),
		resolve(repo.gitCommonDir, "refs"),
	];
	return [...new Set(candidates)].filter((path) => existsSync(path));
}
