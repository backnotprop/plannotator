import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { WorkspaceFileChange, WorkspaceStatusPayload, GitRepositoryInfo, WorkspaceFileStatus } from '@plannotator/core/workspace-status-types';
export type { WorkspaceFileChange, WorkspaceStatusPayload, GitRepositoryInfo, WorkspaceFileStatus };

const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024;
const GIT_MAX_BUFFER = 20 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
type GitResult = { ok: true; stdout: string } | { ok: false; error: string };
interface WorkspaceStatusFlight {
	promise?: Promise<WorkspaceStatusPayload>;
	rerunRequested: boolean;
}
const workspaceStatusFlights = new Map<string, WorkspaceStatusFlight>();

function getGitTimeoutMs(): number {
	const timeout = Number.parseInt(process.env.PLANNOTATOR_GIT_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_GIT_TIMEOUT_MS;
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER,
	});
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		return { ok: false, error: stderr || `git exited with status ${result.status ?? "unknown"}` };
	}
	return { ok: true, stdout: result.stdout ?? "" };
}

function runGitAsync(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolveResult) => {
		const child = spawn("git", ["--no-optional-locks", "-C", cwd, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | null = null;

		const finish = (result: GitResult) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolveResult(result);
		};

		const timeoutMs = getGitTimeoutMs();
		timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, error: `git timed out after ${timeoutMs}ms` });
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > GIT_MAX_BUFFER) {
				child.kill();
				finish({ ok: false, error: `git stdout exceeded ${GIT_MAX_BUFFER} bytes` });
				return;
			}
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderrBytes += Buffer.byteLength(chunk);
			if (stderrBytes <= GIT_MAX_BUFFER) stderr += chunk;
		});
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("close", (status) => {
			if (status === 0) {
				finish({ ok: true, stdout });
				return;
			}
			const message = stderr.trim() || `git exited with status ${status ?? "unknown"}`;
			finish({ ok: false, error: message });
		});
	});
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

async function getGitRepositoryInfoAsync(cwd: string): Promise<GitRepositoryInfo | null> {
	const topLevel = await runGitAsync(cwd, ["rev-parse", "--show-toplevel"]);
	if (!topLevel.ok) return null;
	const rawRepoRoot = topLevel.stdout.trim();
	if (!rawRepoRoot) return null;
	let gitCwd: string;
	try {
		gitCwd = await realpath(resolve(cwd));
	} catch {
		return null;
	}
	let repoRoot: string;
	try {
		repoRoot = await realpath(rawRepoRoot);
	} catch {
		return null;
	}

	const [gitDir, gitCommonDir] = await Promise.all([
		runGitAsync(cwd, ["rev-parse", "--git-dir"]),
		runGitAsync(cwd, ["rev-parse", "--git-common-dir"]),
	]);

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

async function countTextFileLines(path: string): Promise<number> {
	try {
		const fileStat = await stat(path);
		if (!fileStat.isFile() || fileStat.size > TEXT_FILE_MAX_BYTES) return 0;
		const text = (await readFile(path, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (text.length === 0) return 0;
		const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
		return trimmed.length === 0 ? 1 : trimmed.split("\n").length;
	} catch {
		return 0;
	}
}

function unavailableWorkspaceStatus(
	rootPath: string,
	error: string,
	repoRoot?: string,
): WorkspaceStatusPayload {
	return {
		available: false,
		rootPath,
		repoRoot,
		files: {},
		totals: { files: 0, additions: 0, deletions: 0 },
		error,
	};
}

async function computeWorkspaceStatusForDirectory(rootPath: string): Promise<WorkspaceStatusPayload> {
	const repo = await getGitRepositoryInfoAsync(rootPath);
	if (!repo) return unavailableWorkspaceStatus(rootPath, "not-a-git-repo");

	const rootPathspec = relative(repo.repoRoot, rootPath).replace(/\\/g, "/") || ".";
	const status = await runGitAsync(repo.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rootPathspec]);
	if ("error" in status) return unavailableWorkspaceStatus(rootPath, status.error, repo.repoRoot);

	const entries = parsePorcelain(status.stdout);
	const numstat = await runGitAsync(repo.repoRoot, ["diff", "--numstat", "-z", "HEAD", "--", rootPathspec]);
	const headLineCounts = numstat.ok ? parseNumstat(numstat.stdout) : new Map<string, { additions: number; deletions: number }>();
	let splitLineCounts: Map<string, { additions: number; deletions: number }> | null = null;
	if (entries.some((entry) => entry.staged && entry.unstaged)) {
		const [cached, unstaged] = await Promise.all([
			runGitAsync(repo.repoRoot, ["diff", "--cached", "--numstat", "-z", "--", rootPathspec]),
			runGitAsync(repo.repoRoot, ["diff", "--numstat", "-z", "--", rootPathspec]),
		]);
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
			? await countTextFileLines(absolutePath)
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

async function runWorkspaceStatusFlight(rootPath: string, flight: WorkspaceStatusFlight): Promise<WorkspaceStatusPayload> {
	try {
		let status: WorkspaceStatusPayload;
		do {
			flight.rerunRequested = false;
			status = await computeWorkspaceStatusForDirectory(rootPath);
		} while (flight.rerunRequested);
		return status;
	} finally {
		if (workspaceStatusFlights.get(rootPath) === flight) {
			workspaceStatusFlights.delete(rootPath);
		}
	}
}

export async function getWorkspaceStatusForDirectory(dirPath: string): Promise<WorkspaceStatusPayload> {
	let rootPath: string;
	try {
		rootPath = await realpath(resolve(dirPath));
	} catch {
		return unavailableWorkspaceStatus(resolve(dirPath), "invalid-directory");
	}

	const existing = workspaceStatusFlights.get(rootPath);
	if (existing?.promise) {
		existing.rerunRequested = true;
		return existing.promise;
	}

	const flight: WorkspaceStatusFlight = { rerunRequested: false };
	const status = runWorkspaceStatusFlight(rootPath, flight);
	flight.promise = status;
	workspaceStatusFlights.set(rootPath, flight);
	return status;
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
