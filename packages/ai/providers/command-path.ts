import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

type Platform = NodeJS.Platform;
type ExistsFn = (path: string) => boolean;
type TaskkillFn = (
	command: string,
	args: string[],
	options: { stdio: "ignore"; windowsHide: boolean },
) => { status: number | null; error?: Error };

const WINDOWS_EXECUTABLE_EXTENSIONS = [".cmd", ".exe", ".bat", ".com"] as const;
const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);

function trimCommandPath(commandPath: string): string {
	return commandPath.trim();
}

function getKnownWindowsExtension(commandPath: string): string | null {
	const match = trimCommandPath(commandPath).match(/\.(cmd|exe|bat|com)$/i);
	return match ? `.${match[1].toLowerCase()}` : null;
}

export function resolveWindowsCommandShim(
	commandPath: string,
	platform: Platform = process.platform,
	exists: ExistsFn = existsSync,
): string {
	const candidate = trimCommandPath(commandPath);
	if (!candidate || platform !== "win32" || getKnownWindowsExtension(candidate)) {
		return candidate;
	}

	for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
		const pathWithExtension = `${candidate}${ext}`;
		if (exists(pathWithExtension)) return pathWithExtension;
	}

	return candidate;
}

export function resolveCommandFromWhichOutput(
	output: string,
	platform: Platform = process.platform,
	exists: ExistsFn = existsSync,
): string | null {
	const candidates = output
		.split(/\r?\n/)
		.map(trimCommandPath)
		.filter(Boolean);

	if (candidates.length === 0) return null;
	if (platform !== "win32") return candidates[0] ?? null;

	for (const candidate of candidates) {
		const resolved = resolveWindowsCommandShim(candidate, platform, exists);
		if (getKnownWindowsExtension(resolved)) return resolved;
	}

	return resolveWindowsCommandShim(candidates[0] ?? "", platform, exists) || null;
}

export function shouldSpawnViaShell(
	commandPath: string,
	platform: Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	const ext = getKnownWindowsExtension(commandPath);
	return ext ? WINDOWS_SHELL_EXTENSIONS.has(ext) : false;
}

function quoteWindowsShellArg(arg: string): string {
	if (!arg || /[\s"&()^|<>]/.test(arg)) {
		return `"${arg.replace(/"/g, '\\"')}"`;
	}
	return arg;
}

export function buildWindowsCommandScriptSpawnCommand(
	commandPath: string,
	args: string[],
	platform: Platform = process.platform,
	comspec: string | undefined = process.env.ComSpec,
): string[] | null {
	if (!shouldSpawnViaShell(commandPath, platform)) return null;

	return [
		comspec || "cmd.exe",
		"/d",
		"/s",
		"/c",
		[commandPath, ...args].map(quoteWindowsShellArg).join(" "),
	];
}

/**
 * A character cmd.exe does not read literally inside a quoted argument: `"`
 * ends the quotes, `%` and `!` expand variables, a line break ends the
 * command. Control characters are refused too.
 */
const WINDOWS_COMMAND_SCRIPT_UNSAFE_ARG = /["%!^\u0000-\u001f\u007f]/;

/** How an agent job starts its CLI (see `planAgentJobSpawn`). */
export interface AgentJobSpawn {
	/** The argv to spawn. */
	command: string[];
	/** Text for the job's stdin, if any. */
	stdinPrompt?: string;
	/** Spawn with `windowsVerbatimArguments: true` (the cmd.exe command line is already quoted). */
	verbatim: boolean;
	/**
	 * Set when the CLI is a Windows command script (`.cmd`/`.bat`) whose
	 * arguments cmd.exe would misread. `command` is then the job's own argv,
	 * unchanged, and both runtimes refuse the job with this text.
	 */
	unsafeScript?: string;
}

/**
 * How to start an agent job's CLI (code review, Code Tour, Guided Review).
 * #2372: on Windows a CLI installed as a `.cmd` shim (Pi's `pi.cmd`, npm's
 * shims) is not found by `spawn("pi")`, so the job failed with
 * `spawn pi ENOENT`. Ask AI resolves the shim (`resolveWindowsCommandShim`)
 * and runs it through cmd.exe; jobs do the same here.
 *
 * - Not Windows, a program not on PATH, or an `.exe`: the argv as it is.
 * - A `.cmd`/`.bat`: `cmd.exe /d /s /c ""<script>" "<arg>" …"`, spawned
 *   verbatim. A job's prompt cannot go through cmd.exe (it holds line breaks
 *   and quotes), so `promptOnStdin` (Pi's) moves it to stdin first. When an
 *   argument that is left still has a character cmd.exe would read
 *   (`WINDOWS_COMMAND_SCRIPT_UNSAFE_ARG`), the argv is returned as it is with
 *   `unsafeScript` set: nothing the job did not ask for is ever run.
 */
export function planAgentJobSpawn(
	command: string[],
	options: {
		which: (name: string) => string | null;
		stdinPrompt?: string;
		promptOnStdin?: (command: string[]) => { command: string[]; stdin: string } | null;
		platform?: Platform;
		exists?: ExistsFn;
		comspec?: string;
	},
): AgentJobSpawn {
	const platform = options.platform ?? process.platform;
	const asIs: AgentJobSpawn = { command, stdinPrompt: options.stdinPrompt, verbatim: false };
	const program = command[0];
	if (platform !== "win32" || !program) return asIs;
	const found = options.which(program);
	if (!found) return asIs;
	const script = resolveWindowsCommandShim(found, platform, options.exists ?? existsSync);
	if (!shouldSpawnViaShell(script, platform)) return asIs;

	let args = command.slice(1);
	let stdinPrompt = options.stdinPrompt;
	if (stdinPrompt === undefined && options.promptOnStdin) {
		const moved = options.promptOnStdin(command);
		if (moved) {
			args = moved.command.slice(1);
			stdinPrompt = moved.stdin;
		}
	}
	if ([script, ...args].some((arg) => WINDOWS_COMMAND_SCRIPT_UNSAFE_ARG.test(arg))) {
		return {
			...asIs,
			unsafeScript: `${script} is a Windows command script, and this job's arguments cannot be passed through cmd.exe safely. Install the CLI as an .exe, or put its .exe first on PATH.`,
		};
	}
	// A trailing backslash would escape the closing quote for the CLI's own
	// argument parser, so it is doubled.
	const line = [script, ...args].map((arg) => `"${arg.replace(/(\\+)$/, "$1$1")}"`).join(" ");
	return {
		command: [options.comspec || process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `"${line}"`],
		stdinPrompt,
		verbatim: true,
	};
}

export function killWindowsProcessTree(
	pid: number | null | undefined,
	platform: Platform = process.platform,
	runTaskkill: TaskkillFn = spawnSync as TaskkillFn,
): boolean {
	if (
		platform !== "win32" ||
		typeof pid !== "number" ||
		!Number.isFinite(pid) ||
		pid <= 0
	) {
		return false;
	}

	const result = runTaskkill("taskkill", ["/pid", String(pid), "/t", "/f"], {
		stdio: "ignore",
		windowsHide: true,
	});
	return !result.error && result.status === 0;
}
