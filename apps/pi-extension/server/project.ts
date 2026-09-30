/**
 * Project detection — repo info, project name, remote URL parsing.
 * detectProjectName, getRepoInfo, parseRemoteUrl
 */

import { execSync } from "node:child_process";
import { basename } from "node:path";
import { sanitizeTag } from "../generated/project.ts";
import { parseRemoteUrl, parseRemoteHost, getDirName, type RepoInfo } from "../generated/repo.ts";

/** Run a git command and return stdout (empty string on error). */
function git(cmd: string, cwd: string): string {
	try {
		return execSync(`git ${cmd}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "";
	}
}

export function detectProjectName(cwd = process.cwd()): string {
	try {
		const toplevel = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const name = basename(toplevel);
		return sanitizeTag(name) ?? "_unknown";
	} catch {
		// Not a git repo — fall back to cwd
	}
	try {
		const name = basename(cwd);
		return sanitizeTag(name) ?? "_unknown";
	} catch {
		return "_unknown";
	}
}

export function getRepoInfo(cwd = process.cwd()): RepoInfo | null {
	const branch = git("rev-parse --abbrev-ref HEAD", cwd);
	const safeBranch = branch && branch !== "HEAD" ? branch : undefined;

	const originUrl = git("remote get-url origin", cwd);
	const orgRepo = parseRemoteUrl(originUrl);
	if (orgRepo) {
		return { display: orgRepo, branch: safeBranch, host: parseRemoteHost(originUrl) ?? undefined };
	}

	const topLevel = git("rev-parse --show-toplevel", cwd);
	const repoName = getDirName(topLevel);
	if (repoName) {
		return { display: repoName, branch: safeBranch };
	}

	const cwdName = getDirName(cwd);
	if (cwdName) {
		return { display: cwdName };
	}

	return null;
}
