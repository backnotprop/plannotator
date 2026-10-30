/**
 * PR/MR provider for Node.js runtime.
 * Node.js PRRuntime + bound dispatch functions from shared pr-provider.
 */

import { spawn } from "node:child_process";

import {
	type PRMetadata,
	type PRRef,
	type PRReviewFileComment,
	type PRReviewFileLevelComment,
	type PRReviewAction,
	type PRReviewSubmissionResult,
	type PRRuntime,
	type PRStackTree,
	type PRListItem,
	parsePRUrl as parsePRUrlCore,
	parseFileLevelComments as parseFileLevelCommentsCore,
	parsePRReviewAction as parsePRReviewActionCore,
} from "../generated/pr-types.ts";
import {
	checkAuth as checkAuthCore,
	fetchPRContext as fetchPRContextCore,
	fetchPR as fetchPRCore,
	fetchPRFileContent as fetchPRFileContentCore,
	fetchPRFileBytes as fetchPRFileBytesCore,
	fetchPRTree as fetchPRTreeCore,
	fetchPRViewedFiles as fetchPRViewedFilesCore,
	fetchPRStack as fetchPRStackCore,
	fetchPRList as fetchPRListCore,
	getUser as getUserCore,
	markPRFilesViewed as markPRFilesViewedCore,
	submitPRReview as submitPRReviewCore,
} from "../generated/pr-provider.ts";

const nodeCommandRuntime: PRRuntime = {
	async runCommand(cmd, args, options) {
		return new Promise((resolve, reject) => {
			// options.env is added to (never replacing) the environment: another gh account's token (#2157).
			const proc = spawn(cmd, args, {
				stdio: ["ignore", "pipe", "pipe"],
				...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
			});
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
	async runCommandWithInput(cmd, args, input, options) {
		return new Promise((resolve, reject) => {
			const proc = spawn(cmd, args, {
				stdio: ["pipe", "pipe", "pipe"],
				...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
			});
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

// Tests replace the command runner (setPRCommandRuntimeForTests) so no test
// ever runs the real `gh` / `glab`: the review server calls these at startup
// in PR mode (the platform user, viewed files, PR context).
let testRuntime: PRRuntime | null = null;

const prRuntime: PRRuntime = {
	runCommand: (cmd, args, options) => (testRuntime ?? nodeCommandRuntime).runCommand(cmd, args, options),
	runCommandWithInput: (cmd, args, input, options) => {
		const active = testRuntime ?? nodeCommandRuntime;
		if (!active.runCommandWithInput) return Promise.reject(new Error(`${cmd}: this runtime takes no input`));
		return active.runCommandWithInput(cmd, args, input, options);
	},
};

/**
 * Tests only: run every PR platform command through `fake` instead of a real
 * process (null puts the real runner back). Set it inside a test and restore
 * it in afterEach: bun runs every test file in one process.
 */
export function setPRCommandRuntimeForTests(fake: PRRuntime | null): void {
	testRuntime = fake;
}

/** The Node command runner, exported for non-PR CLI consumers (commit avatars). */
export const prCommandRuntime: PRRuntime = prRuntime;

export const parsePRUrl = parsePRUrlCore;
export const parseFileLevelComments = parseFileLevelCommentsCore;
export const parsePRReviewAction = parsePRReviewActionCore;
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
export function fetchPRFileBytes(ref: PRRef, sha: string, filePath: string, maxBytes: number) {
	return fetchPRFileBytesCore(prRuntime, ref, sha, filePath, maxBytes);
}
/** Every file of one commit from the platform tree API (All files without a checkout). */
export function fetchPRTree(ref: PRRef, sha: string) {
	return fetchPRTreeCore(prRuntime, ref, sha);
}
/** Submit a review through the Pi Node.js command runtime. */
export function submitPRReview(
	ref: PRRef,
	headSha: string,
	action: PRReviewAction,
	body: string,
	fileComments: PRReviewFileComment[],
	fileLevelComments: PRReviewFileLevelComment[] = [],
): Promise<PRReviewSubmissionResult> {
	return submitPRReviewCore(
		prRuntime,
		ref,
		headSha,
		action,
		body,
		fileComments,
		fileLevelComments,
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
