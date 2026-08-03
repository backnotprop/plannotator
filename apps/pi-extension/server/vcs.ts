import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	type DiffResult,
	type DiffType,
	type GitCommandResult,
	type GitCommandOptions,
	type GitContext,
	type GitDiffOptions,
	type PreparedGitCommand,
	type ReviewGitRuntime,
	getGitContext as getGitContextCore,
	prepareGitCommand,
	runGitDiff as runGitDiffCore,
} from "../generated/review-core.js";
import {
	type ReviewJjRuntime,
} from "../generated/jj-core.js";
import {
	type ReviewGitButlerRuntime,
} from "../generated/gitbutler-core.js";
import {
	type VcsSelection,
	createGitButlerProvider,
	createGitProvider,
	createJjProvider,
	createVcsApi,
	resolveInitialDiffType,
} from "../generated/vcs-core.js";

function runCommand(
	command: string,
	args: string[],
	notFoundMessage: string,
	options?: GitCommandOptions,
	preparedGitCommand?: PreparedGitCommand,
	commandEnvironment?: NodeJS.ProcessEnv,
	isolateProcessGroup = preparedGitCommand?.isolateProcessGroup ?? false,
): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			detached: isolateProcessGroup,
			env: preparedGitCommand?.env ?? commandEnvironment,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		if (options?.timeoutMs) {
			timer = setTimeout(() => {
				if (isolateProcessGroup && proc.pid && process.platform !== "win32") {
					try {
						process.kill(-proc.pid, "SIGKILL");
						return;
					} catch {
						// Fall through when the process exited between the timer and signal.
					}
				}
				if (isolateProcessGroup && proc.pid && process.platform === "win32") {
					const killed = spawnSync(
						"taskkill.exe",
						["/pid", String(proc.pid), "/t", "/f"],
						{ stdio: "ignore", windowsHide: true },
					);
					if (killed.status === 0) return;
				}
				proc.kill("SIGKILL");
			}, options.timeoutMs);
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
		options?: GitCommandOptions,
	): Promise<GitCommandResult> {
		const command = prepareGitCommand(args, options, process.env);
		return runCommand("git", command.args, "git not found", options, command);
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

/** Node Git + GitButler runtime used by the Pi review server. */
export const gitButlerRuntime: ReviewGitButlerRuntime = {
	...reviewRuntime,
	runBut(
		args: string[],
		options?: GitCommandOptions,
	): Promise<GitCommandResult> {
		return runCommand(
			"but",
			args,
			"but not found",
			options,
			undefined,
			{ ...process.env, NO_BG_TASKS: "1" },
			true,
		);
	},
};

const api = createVcsApi([
	createJjProvider(jjRuntime),
	createGitButlerProvider(gitButlerRuntime),
	createGitProvider(reviewRuntime),
]);

export const {
	detectVcs,
	detectManagedVcs,
	vcsOwnsDiffType,
	getVcsContext,
	detectRemoteDefaultCompareTarget,
	prepareLocalReviewDiff,
	runVcsDiff,
	getVcsFileContentsForDiff,
	getVcsDiffFingerprint,
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
