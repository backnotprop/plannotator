/**
 * Network utilities — remote detection, port binding, browser opening.
 * isRemoteSession, getServerPort, listenOnPort, openBrowser
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REMOTE_PORT = 19432;
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_GLIMPSE_PATH = join(
	homedir(),
	".pi",
	"agent",
	"git",
	"github.com",
	"hazat",
	"glimpse",
	"src",
	"glimpse.mjs",
);

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
function escapeHtmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

type GlimpseWindowLike = {
	once: (event: "ready" | "error" | "closed", listener: (...args: unknown[]) => void) => unknown;
};

async function loadGlimpse(): Promise<{ open: (html: string, options?: Record<string, unknown>) => GlimpseWindowLike } | null> {
	try {
		const glimpsePackageName = "glimpseui";
		return await import(glimpsePackageName);
	} catch {
		// Fall through to explicit/local path resolution.
	}

	const glimpsePath = process.env.PLANNOTATOR_GLIMPSE_PATH || DEFAULT_GLIMPSE_PATH;
	try {
		if (!existsSync(glimpsePath)) {
			return null;
		}
		return await import(pathToFileURL(glimpsePath).href);
	} catch {
		return null;
	}
}

async function openGlimpse(url: string): Promise<boolean> {
	try {
		const glimpse = await loadGlimpse();
		if (!glimpse) {
			return false;
		}

		const window = glimpse.open(`<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<title>Plannotator</title>
		<style>
			html, body, iframe { width: 100%; height: 100%; margin: 0; }
			body { overflow: hidden; background: #0f1115; }
			iframe { border: 0; display: block; }
		</style>
	</head>
	<body>
		<iframe src="${escapeHtmlAttribute(url)}" allow="clipboard-read; clipboard-write"></iframe>
	</body>
</html>`, {
			width: Number(process.env.PLANNOTATOR_GLIMPSE_WIDTH || 1280),
			height: Number(process.env.PLANNOTATOR_GLIMPSE_HEIGHT || 900),
			title: "Plannotator",
			openLinks: true,
		});

		return await new Promise<boolean>((resolve) => {
			const timeout = setTimeout(() => resolve(false), 3000);
			const finish = (opened: boolean) => {
				clearTimeout(timeout);
				resolve(opened);
			};

			window.once("ready", () => finish(true));
			window.once("error", () => finish(false));
			window.once("closed", () => finish(false));
		});
	} catch {
		return false;
	}
}

export async function openBrowser(url: string): Promise<{
	opened: boolean;
	isRemote?: boolean;
	url?: string;
}> {
	const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
	if (isRemoteSession() && !browser) {
		return { opened: false, isRemote: true, url };
	}

	if (!browser) {
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
			if (process.env.PLANNOTATOR_BROWSER && platform === "darwin") {
				cmd = "open";
				args = ["-a", browser, url];
			} else if (platform === "win32" || wsl) {
				cmd = "cmd.exe";
				args = ["/c", "start", "", browser, url];
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
