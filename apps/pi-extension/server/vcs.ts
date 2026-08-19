import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
} from "../generated/review-core.ts";
import {
	type ReviewJjRuntime,
} from "../generated/jj-core.ts";
import {
	type ReviewGitButlerRuntime,
} from "../generated/gitbutler-core.ts";
import {
	type VcsSelection,
	createGitButlerProvider,
	createGitProvider,
	createJjProvider,
	createVcsApi,
	resolveInitialDiffType,
} from "../generated/vcs-core.ts";

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
			stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
		// Stop buffering AND kill at `maxOutputBytes`, so a command that can emit
		// an entire repository tree bounds real memory growth instead of being
		// measured and rejected after it is already held in full.
		let stdoutBytes = 0;
		let truncated = false;
		proc.stdout!.on("data", (chunk: Buffer) => {
			if (truncated) return;
			stdoutBytes += chunk.byteLength;
			if (
				options?.maxOutputBytes !== undefined &&
				stdoutBytes > options.maxOutputBytes
			) {
				truncated = true;
				proc.kill("SIGKILL");
				return;
			}
			stdoutChunks.push(chunk);
		});
		proc.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		if (options?.stdin !== undefined) {
			// A timeout-killed process can reject the stdin write while close is
			// already being handled. Do not let that secondary EPIPE escape.
			proc.stdin!.on("error", () => {});
			proc.stdin!.end(options.stdin);
		}

		proc.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
				stderr: Buffer.concat(stderrChunks).toString("utf-8"),
				exitCode: code ?? 1,
				...(truncated ? { truncated: true } : {}),
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

	async getFileInfo(basePath, path) {
		const fullPath = resolvePath(basePath ?? "", path);
		try {
			const fileStat = lstatSync(fullPath);
			return {
				path: fullPath,
				size: fileStat.size,
				mtimeMs: fileStat.mtimeMs,
				isFile: fileStat.isFile(),
				isSymbolicLink: fileStat.isSymbolicLink(),
				isExecutable: (fileStat.mode & 0o111) !== 0,
			};
		} catch {
			return null;
		}
	},

	async readLink(path: string): Promise<string | null> {
		try {
			return readlinkSync(path);
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
	createJjProvider(jjRuntime, reviewRuntime),
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
	vcsSupportsSnapshot,
	materializeVcsSnapshot,
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
