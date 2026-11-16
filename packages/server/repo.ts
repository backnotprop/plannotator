/**
 * Repository Info Detection
 *
 * Detects org/repo from git remote with fallback chain.
 * Priority: org/repo from remote → repo name → directory name
 */

import type { RepoInfo } from "@plannotator/shared/repo";
import { parseRemoteUrl, parseRemoteHost, getDirName } from "@plannotator/shared/repo";
import { gitStdout } from "./project";

/**
 * Get current git branch
 */
async function getCurrentBranch(cwd: string): Promise<string | undefined> {
	try {
		const head = await gitStdout(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
		if (head !== null) {
			const branch = head.trim();
			return branch && branch !== "HEAD" ? branch : undefined;
		}
	} catch {
		// Not in a git repo
	}
	return undefined;
}

/**
 * Repository info from git alone: org/repo from origin, else the repo root's
 * name. Null when `cwd` is not inside a git repo.
 */
async function getGitRepoInfo(cwd: string): Promise<RepoInfo | null> {
	let branch: string | undefined;

	// Try git remote URL first
	try {
		const remote = await gitStdout(["remote", "get-url", "origin"], cwd);
		if (remote !== null) {
			const remoteUrl = remote.trim();
			const orgRepo = parseRemoteUrl(remoteUrl);
			if (orgRepo) {
				branch = await getCurrentBranch(cwd);
				const host = parseRemoteHost(remoteUrl) ?? undefined;
				return { display: orgRepo, branch, host };
			}
		}
	} catch {
		// Git not available
	}

	// Fallback: git repo root name
	try {
		const toplevel = await gitStdout(["rev-parse", "--show-toplevel"], cwd);
		if (toplevel !== null) {
			const repoName = getDirName(toplevel);
			if (repoName) {
				branch = await getCurrentBranch(cwd);
				return { display: repoName, branch };
			}
		}
	} catch {
		// Not in a git repo
	}

	return null;
}

/**
 * Detect repository info with fallback chain
 *
 * 1. Try org/repo from git remote origin
 * 2. Fall back to git repo root directory name
 * 3. Fall back to current working directory name
 */
export async function getRepoInfo(cwd = process.cwd()): Promise<RepoInfo | null> {
	const gitInfo = await getGitRepoInfo(cwd);
	if (gitInfo) return gitInfo;

	// Final fallback: current directory (no branch - not a git repo)
	try {
		const dirName = getDirName(cwd);
		if (dirName) {
			return { display: dirName };
		}
	} catch {
		// Shouldn't happen
	}

	return null;
}

/**
 * Repository info for a source on disk: the repo holding `sourceDir`, even one
 * without a remote. A folder outside any repo, or no source at all, keeps the
 * repo the session started from, so `#123` links still work there.
 */
export async function getSourceRepoInfo(sourceDir?: string): Promise<RepoInfo | null> {
	const sourceInfo = sourceDir ? await getGitRepoInfo(sourceDir) : null;
	return sourceInfo ?? getRepoInfo();
}
