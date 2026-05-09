import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	type DiffResult,
	type DiffType,
	type GitCommandResult,
	type GitContext,
	type GitDiffOptions,
	type ReviewGitRuntime,
	getGitContext as getGitContextCore,
	runGitDiff as runGitDiffCore,
} from "../generated/review-core.js";
import {
	type ReviewJjRuntime,
} from "../generated/jj-core.js";
import {
	type VcsSelection,
	createGitProvider,
	createJjProvider,
	createVcsApi,
	resolveInitialDiffType,
} from "../generated/vcs-core.js";

function runCommand(
	command: string,
	args: string[],
	notFoundMessage: string,
	options?: { cwd?: string; timeoutMs?: number },
): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		if (options?.timeoutMs) {
			timer = setTimeout(() => proc.kill(), options.timeoutMs);
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		proc.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		proc.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		proc.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
				stderr: Buffer.concat(stderrChunks).toString("utf-8"),
				exitCode: code ?? 1,
			});
		});

		proc.on("error", () => {
			if (timer) clearTimeout(timer);
			resolve({ stdout: "", stderr: notFoundMessage, exitCode: 1 });
		});
	});
}

export const reviewRuntime: ReviewGitRuntime = {
	runGit(
		args: string[],
		options?: { cwd?: string; timeoutMs?: number },
	): Promise<GitCommandResult> {
		return runCommand("git", ["-c", "core.quotePath=false", ...args], "git not found", options);
	},

	async readTextFile(path: string): Promise<string | null> {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	},
};

export const jjRuntime: ReviewJjRuntime = {
	runJj(
		args: string[],
		options?: { cwd?: string; timeoutMs?: number },
	): Promise<GitCommandResult> {
		return runCommand("jj", args, "jj not found", options);
	},
};

const api = createVcsApi([
	createJjProvider(jjRuntime),
	createGitProvider(reviewRuntime),
]);

export const {
	detectVcs,
	getVcsContext,
	detectRemoteDefaultCompareTarget,
	prepareLocalReviewDiff,
	runVcsDiff,
	getVcsFileContentsForDiff,
	canStageFiles,
	stageFile,
	unstageFile,
	resolveVcsCwd,
} = api;

export { resolveInitialDiffType };
export type { VcsSelection };

export function getGitContext(cwd?: string): Promise<GitContext> {
	return getGitContextCore(reviewRuntime, cwd);
}

export function runGitDiff(
	diffType: DiffType,
	defaultBranch = "main",
	cwd?: string,
	options?: GitDiffOptions,
): Promise<DiffResult> {
	return runGitDiffCore(reviewRuntime, diffType, defaultBranch, cwd, options);
}
