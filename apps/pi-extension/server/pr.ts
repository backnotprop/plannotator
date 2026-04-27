/**
 * PR/MR provider for Node.js runtime.
 * Node.js PRRuntime + bound dispatch functions from shared pr-provider.
 */

import { spawn } from "node:child_process";

import {
	checkAuth as checkAuthCore,
	fetchPRContext as fetchPRContextCore,
	fetchPR as fetchPRCore,
	fetchPRFileContent as fetchPRFileContentCore,
	fetchPRViewedFiles as fetchPRViewedFilesCore,
	fetchPRStack as fetchPRStackCore,
	fetchPRList as fetchPRListCore,
	getUser as getUserCore,
	markPRFilesViewed as markPRFilesViewedCore,
	type PRMetadata,
	type PRRef,
	type PRReviewFileComment,
	type PRRuntime,
	type PRStackTree,
	type PRListItem,
	parsePRUrl as parsePRUrlCore,
	submitPRReview as submitPRReviewCore,
} from "../generated/pr-provider.js";

const prRuntime: PRRuntime = {
	async runCommand(cmd, args) {
		return new Promise((resolve, reject) => {
			const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			proc.on("error", reject);
			proc.on("close", (exitCode) => {
				resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
			});
		});
	},
	async runCommandWithInput(cmd, args, input) {
		return new Promise((resolve, reject) => {
			const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			proc.on("error", reject);
			proc.on("close", (exitCode) => {
				resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
			});
			proc.stdin?.write(input);
			proc.stdin?.end();
		});
	},
};

export const parsePRUrl = parsePRUrlCore;
export function checkPRAuth(ref: PRRef) {
	return checkAuthCore(prRuntime, ref);
}
export function getPRUser(ref: PRRef) {
	return getUserCore(prRuntime, ref);
}
export function fetchPR(ref: PRRef) {
	return fetchPRCore(prRuntime, ref);
}
export function fetchPRContext(ref: PRRef) {
	return fetchPRContextCore(prRuntime, ref);
}
export function fetchPRFileContent(ref: PRRef, sha: string, filePath: string) {
	return fetchPRFileContentCore(prRuntime, ref, sha, filePath);
}
export function submitPRReview(
	ref: PRRef,
	headSha: string,
	action: "approve" | "comment",
	body: string,
	fileComments: PRReviewFileComment[],
) {
	return submitPRReviewCore(
		prRuntime,
		ref,
		headSha,
		action,
		body,
		fileComments,
	);
}

export function fetchPRViewedFiles(ref: PRRef): Promise<Record<string, boolean>> {
	return fetchPRViewedFilesCore(prRuntime, ref);
}

export function markPRFilesViewed(
	ref: PRRef,
	prNodeId: string,
	filePaths: string[],
	viewed: boolean,
): Promise<void> {
	return markPRFilesViewedCore(prRuntime, ref, prNodeId, filePaths, viewed);
}

export function fetchPRStack(
	ref: PRRef,
	metadata: PRMetadata,
): Promise<PRStackTree | null> {
	return fetchPRStackCore(prRuntime, ref, metadata);
}

export function fetchPRList(
	ref: PRRef,
): Promise<PRListItem[]> {
	return fetchPRListCore(prRuntime, ref);
}
