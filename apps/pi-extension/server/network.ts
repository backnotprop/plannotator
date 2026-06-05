/**
 * Network utilities — remote detection, port binding, browser opening.
 * isRemoteSession, getServerPort, listenOnPort, openBrowser
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { release } from "node:os";
import { delimiter, join } from "node:path";
import { loadConfig, resolveUseGlimpse } from "../generated/config.js";

const DEFAULT_REMOTE_PORT = 19432;
const LOOPBACK_HOST = "127.0.0.1";
const NOOP_BROWSER_VALUES = new Set(["true", "false", "none", ":", "0", "1"]);

export function isNoOpBrowserSentinel(value: string | undefined): boolean {
	if (!value) return false;
	return NOOP_BROWSER_VALUES.has(value.trim().toLowerCase());
}

/**
 * Check if running in a remote session (SSH, devcontainer, etc.)
 * Honors PLANNOTATOR_REMOTE as a tri-state override, or detects SSH_TTY/SSH_CONNECTION.
 */
function getRemoteOverride(): boolean | null {
	const remote = process.env.PLANNOTATOR_REMOTE;
	if (remote === undefined) {
		return null;
	}

	if (remote === "1" || remote?.toLowerCase() === "true") {
		return true;
	}

	if (remote === "0" || remote?.toLowerCase() === "false") {
		return false;
	}

	return null;
}

export function isRemoteSession(): boolean {
	const remoteOverride = getRemoteOverride();
	if (remoteOverride !== null) {
		return remoteOverride;
	}
	// Legacy SSH detection
	if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
		return true;
	}
	return false;
}

/**
 * Get the server port to use.
 * - PLANNOTATOR_PORT env var takes precedence
 * - Remote sessions default to 19432 (for port forwarding)
 * - Local sessions use random port
 * Returns { port, portSource } so caller can notify user if needed.
 */
export function getServerPort(): {
	port: number;
	portSource: "env" | "remote-default" | "random";
} {
	const envPort = process.env.PLANNOTATOR_PORT;
	if (envPort) {
		const parsed = parseInt(envPort, 10);
		if (!Number.isNaN(parsed) && parsed >= 0 && parsed < 65536) {
			return { port: parsed, portSource: "env" };
		}
		// Invalid port - fall back silently, caller can check env var themselves
	}
	if (isRemoteSession()) {
		return { port: DEFAULT_REMOTE_PORT, portSource: "remote-default" };
	}
	return { port: 0, portSource: "random" };
}

export function getServerHostname(): string {
	return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

export async function listenOnPort(
	server: Server,
): Promise<{ port: number; portSource: "env" | "remote-default" | "random" }> {
	const result = getServerPort();

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(
					result.port,
					getServerHostname(),
					() => {
						server.removeListener("error", reject);
						resolve();
					},
				);
			});
			const addr = server.address() as { port: number };
			return { port: addr.port, portSource: result.portSource };
		} catch (err: unknown) {
			const isAddressInUse =
				err instanceof Error && err.message.includes("EADDRINUSE");
			if (isAddressInUse && attempt < MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
				continue;
			}
			if (isAddressInUse) {
				const hint = isRemoteSession()
					? " (set PLANNOTATOR_PORT to use a different port)"
					: "";
				throw new Error(
					`Port ${result.port} in use after ${MAX_RETRIES} retries${hint}`,
				);
			}
			throw err;
		}
	}

	// Unreachable, but satisfies TypeScript
	throw new Error("Failed to bind port");
}

/**
 * Open URL in system browser (Node-compatible, no Bun $ dependency).
 * Honors PLANNOTATOR_BROWSER and BROWSER env vars.
 * Returns { opened: true } if browser was opened, { opened: false, isRemote: true, url } if remote session.
 */
function findCommandOnPath(command: string): string | null {
	const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	for (const dir of (process.env.PATH || "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of extensions) {
			const candidate = join(dir, `${command}${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

function buildGlimpseHtml(url: string): string {
	const encodedUrl = JSON.stringify(url);
	return `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<title>Plannotator</title>
		<style>
			html, body { width: 100%; height: 100%; margin: 0; }
			body { overflow: hidden; background: #0f1115; }
		</style>
	</head>
	<body>
		<script>
			location.replace(${encodedUrl});
		</script>
	</body>
</html>`;
}

async function openGlimpse(url: string): Promise<boolean> {
	const glimpseCli = findCommandOnPath("glimpseui");
	if (!glimpseCli) return false;

	const args = [
		"--width",
		String(Number(process.env.PLANNOTATOR_GLIMPSE_WIDTH || 1280)),
		"--height",
		String(Number(process.env.PLANNOTATOR_GLIMPSE_HEIGHT || 900)),
		"--title",
		"Plannotator",
		"--open-links",
	];
	const html = buildGlimpseHtml(url);

	return await new Promise<boolean>((resolve) => {
		let settled = false;
		let successTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (opened: boolean) => {
			if (settled) return;
			settled = true;
			if (successTimer) clearTimeout(successTimer);
			resolve(opened);
		};

		const child = spawn(glimpseCli, args, {
			detached: true,
			stdio: ["pipe", "ignore", "ignore"],
		});
		successTimer = setTimeout(() => {
			child.unref();
			finish(true);
		}, 750);

		child.once("error", () => finish(false));
		child.once("exit", () => finish(false));
		child.stdin.once("error", () => finish(false));
		child.stdin.end(html);
	});
}

export async function openBrowser(url: string): Promise<{
	opened: boolean;
	isRemote?: boolean;
	url?: string;
}> {
	const rawPlannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
	const rawBrowser = process.env.BROWSER;
	const plannotatorBrowser = isNoOpBrowserSentinel(rawPlannotatorBrowser)
		? undefined
		: rawPlannotatorBrowser;
	const envBrowser = isNoOpBrowserSentinel(rawBrowser) ? undefined : rawBrowser;
	const browser = plannotatorBrowser || envBrowser;
	if (isRemoteSession() && !browser) {
		return { opened: false, isRemote: true, url };
	}

	if (!browser && resolveUseGlimpse(loadConfig())) {
		const openedViaGlimpse = await openGlimpse(url);
		if (openedViaGlimpse) {
			return { opened: true };
		}
	}

	try {
		const platform = process.platform;
		const wsl =
			platform === "linux" && release().toLowerCase().includes("microsoft");

		let cmd: string;
		let args: string[];

		if (browser) {
			if (plannotatorBrowser && platform === "darwin") {
				cmd = "open";
				args = ["-a", plannotatorBrowser, url];
			} else if ((platform === "win32" || wsl) && plannotatorBrowser) {
				cmd = "cmd.exe";
				args = ["/c", "start", "", plannotatorBrowser, url];
			} else {
				cmd = browser;
				args = [url];
			}
		} else if (platform === "win32" || wsl) {
			cmd = "cmd.exe";
			args = ["/c", "start", "", url];
		} else if (platform === "darwin") {
			cmd = "open";
			args = [url];
		} else {
			cmd = "xdg-open";
			args = [url];
		}

		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.once("error", () => {});
		child.unref();
		return { opened: true };
	} catch {
		return { opened: false };
	}
}
