/**
 * Project detection — repo info, project name, remote URL parsing.
 * detectProjectName, getRepoInfo, parseRemoteUrl
 */

import { execSync } from "node:child_process";
import { basename } from "node:path";
import { sanitizeTag } from "../generated/project.ts";
import { parseRemoteUrl, getDirName } from "../generated/repo.ts";

/** Run a git command and return stdout (empty string on error). */
function git(cmd: string): string {
	try {
		return execSync(`git ${cmd}`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "";
	}
}

export function detectProjectName(): string {
	try {
		const toplevel = execSync("git rev-parse --show-toplevel", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const name = basename(toplevel);
		return sanitizeTag(name) ?? "_unknown";
	} catch {
		// Not a git repo — fall back to cwd
	}
	try {
		const name = basename(process.cwd());
		return sanitizeTag(name) ?? "_unknown";
	} catch {
		return "_unknown";
	}
}

export function getRepoInfo(): { display: string; branch?: string } | null {
	const branch = git("rev-parse --abbrev-ref HEAD");
	const safeBranch = branch && branch !== "HEAD" ? branch : undefined;

	const originUrl = git("remote get-url origin");
	const orgRepo = parseRemoteUrl(originUrl);
	if (orgRepo) {
		return { display: orgRepo, branch: safeBranch };
	}

	const topLevel = git("rev-parse --show-toplevel");
	const repoName = getDirName(topLevel);
	if (repoName) {
		return { display: repoName, branch: safeBranch };
	}

	const cwdName = getDirName(process.cwd());
	if (cwdName) {
		return { display: cwdName };
	}

	return null;
}
