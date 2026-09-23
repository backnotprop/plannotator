import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
	type DiffResult,
	type DiffType,
	type GitBytesCommandResult,
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
	resolveAvailableDiffType,
	resolveInitialDiffType,
} from "../generated/vcs-core.ts";

/**
 * Process-group leaders of commands started with `interaction: "forbid"`
 * (#1553). Mirrors packages/server/git.ts: those run detached so a timeout can
 * kill the whole transport tree, but a server exiting mid-flight left the
 * git/ssh pair orphaned — the parent-side timer dies with the parent, so
 * nothing was ever going to reap them.
 *
 * POSIX only: the negative-pid group signal has no Windows equivalent, and the
 * timeout path already special-cases win32 with taskkill.
 */
const isolatedProcessGroups = new Set<number>();
let isolatedExitHookInstalled = false;

function reapIsolatedProcessGroups(): void {
	for (const pid of isolatedProcessGroups) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone, or the leader exited between the last read and here.
		}
	}
	isolatedProcessGroups.clear();
}

function trackIsolatedProcessGroup(pid: number): () => void {
	if (process.platform === "win32") return () => {};
	if (!isolatedExitHookInstalled) {
		isolatedExitHookInstalled = true;
		// "exit" only: it runs on every process.exit(), and the callback must be
		// synchronous — process.kill is.
		process.on("exit", reapIsolatedProcessGroups);
	}
	isolatedProcessGroups.add(pid);
	return () => isolatedProcessGroups.delete(pid);
}

async function runCommand(
	command: string,
	args: string[],
	notFoundMessage: string,
	options?: GitCommandOptions,
	preparedGitCommand?: PreparedGitCommand,
	commandEnvironment?: NodeJS.ProcessEnv,
	isolateProcessGroup = preparedGitCommand?.isolateProcessGroup ?? false,
): Promise<GitCommandResult> {
	const result = await runCommandBytes(
		command,
		args,
		notFoundMessage,
		options,
		preparedGitCommand,
		commandEnvironment,
		isolateProcessGroup,
	);
	return {
		...result,
		stdout: Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength).toString("utf-8"),
	};
}

/**
 * The shared spawn: stdout comes back undecoded, so binary blobs (image
 * previews) survive intact; `runCommand` decodes it for every text caller.
 */
function runCommandBytes(
	command: string,
	args: string[],
	notFoundMessage: string,
	options?: GitCommandOptions,
	preparedGitCommand?: PreparedGitCommand,
	commandEnvironment?: NodeJS.ProcessEnv,
	isolateProcessGroup = preparedGitCommand?.isolateProcessGroup ?? false,
): Promise<GitBytesCommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			detached: isolateProcessGroup,
			env: preparedGitCommand?.env ?? commandEnvironment,
			stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		const untrack = isolateProcessGroup && proc.pid
			? trackIsolatedProcessGroup(proc.pid)
			: undefined;

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
			untrack?.();
			resolve({
				stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
				stderr: Buffer.concat(stderrChunks).toString("utf-8"),
				exitCode: code ?? 1,
				...(truncated ? { truncated: true } : {}),
			});
		});

		proc.on("error", () => {
			if (timer) clearTimeout(timer);
			untrack?.();
			resolve({ stdout: new Uint8Array(0), stderr: notFoundMessage, exitCode: 1 });
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

	runGitBytes(
		args: string[],
		options?: GitCommandOptions,
	): Promise<GitBytesCommandResult> {
		const command = prepareGitCommand(args, options, process.env);
		return runCommandBytes("git", command.args, "git not found", options, command);
	},

	async readTextFile(path: string): Promise<string | null> {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	},

	async readFileBytes(path: string, maxBytes: number): Promise<Uint8Array | null> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(path, "r");
			const { size } = await handle.stat();
			const buffer = new Uint8Array(Math.min(size, maxBytes) + 1);
			let offset = 0;
			while (offset < buffer.byteLength) {
				const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			return buffer.subarray(0, offset);
		} catch {
			return null;
		} finally {
			await handle?.close().catch(() => {});
		}
	},

	async realPath(path: string): Promise<string | null> {
		try {
			return await realpath(path);
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
	runJjBytes(
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
	): Promise<GitBytesCommandResult> {
		return runCommandBytes("jj", args, "jj not found", options);
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
	getVcsFileBytesForDiff,
	getVcsDiffFingerprint,
	canStageFiles,
	stageFile,
	unstageFile,
	resolveVcsCwd,
	vcsSupportsSnapshot,
	materializeVcsSnapshot,
} = api;

export { resolveAvailableDiffType, resolveInitialDiffType };
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
