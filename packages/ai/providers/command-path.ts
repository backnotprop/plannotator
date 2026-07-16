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
