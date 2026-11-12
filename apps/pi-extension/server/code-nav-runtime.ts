/**
 * Code navigation's node runtime for Pi (the Bun one is packages/server/code-nav.ts):
 * the review server's /api/code-nav/* and Shape's code routes (serverShape.ts).
 */
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { type CodeNavRuntime, CODE_NAV_MAX_FILE_BYTES } from "../generated/code-nav.ts";
import { readFileCapped } from "../generated/repo-file.ts";

export const piCodeNavRuntime: CodeNavRuntime = {
	runCommand(command, args, options) {
		return new Promise((resolve) => {
			const proc = spawn(command, args, {
				cwd: options?.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			if (options?.timeoutMs) {
				timer = setTimeout(() => proc.kill(), options.timeoutMs);
			}
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			proc.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
			proc.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
			proc.on("close", (code: number | null) => {
				if (timer) clearTimeout(timer);
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? 1,
				});
			});
			proc.on("error", () => {
				if (timer) clearTimeout(timer);
				resolve({ stdout: "", stderr: "command not found", exitCode: 1 });
			});
		});
	},

	async readFile(path, options) {
		// Capped at what rg searches, non-blocking (repo-file.ts).
		const read = await readFileCapped(options?.cwd ? resolvePath(options.cwd, path) : path, {
			maxBytes: CODE_NAV_MAX_FILE_BYTES,
		});
		return read.ok ? read.content : null;
	},
};
