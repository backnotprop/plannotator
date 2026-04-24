/**
 * Repository Info Detection
 *
 * Detects org/repo from git remote with fallback chain.
 * Priority: org/repo from remote → repo name → directory name
 */

import { $ } from "bun";

import type { RepoInfo } from "@plannotator/shared/repo";
import { parseRemoteUrl, parseRemoteHost, getDirName } from "@plannotator/shared/repo";

/**
 * Get current git branch
 */
async function getCurrentBranch(): Promise<string | undefined> {
	try {
		const result = await $`git rev-parse --abbrev-ref HEAD`.quiet().nothrow();
		if (result.exitCode === 0) {
			const branch = result.stdout.toString().trim();
			return branch && branch !== "HEAD" ? branch : undefined;
		}
	} catch {
		// Not in a git repo
	}
	return undefined;
}

/**
 * Detect repository info with fallback chain
 *
 * 1. Try org/repo from git remote origin
 * 2. Fall back to git repo root directory name
 * 3. Fall back to current working directory name
 */
export async function getRepoInfo(): Promise<RepoInfo | null> {
	let branch: string | undefined;

	// Try git remote URL first
	try {
		const result = await $`git remote get-url origin`.quiet().nothrow();
		if (result.exitCode === 0) {
			const remoteUrl = result.stdout.toString().trim();
			const orgRepo = parseRemoteUrl(remoteUrl);
			if (orgRepo) {
				branch = await getCurrentBranch();
				const host = parseRemoteHost(remoteUrl) ?? undefined;
				return { display: orgRepo, branch, host };
			}
		}
	} catch {
		// Git not available
	}

	// Fallback: git repo root name
	try {
		const result = await $`git rev-parse --show-toplevel`.quiet().nothrow();
		if (result.exitCode === 0) {
			const repoName = getDirName(result.stdout.toString());
			if (repoName) {
				branch = await getCurrentBranch();
				return { display: repoName, branch };
			}
		}
	} catch {
		// Not in a git repo
	}

	// Final fallback: current directory (no branch - not a git repo)
	try {
		const dirName = getDirName(process.cwd());
		if (dirName) {
			return { display: dirName };
		}
	} catch {
		// Shouldn't happen
	}

	return null;
}
