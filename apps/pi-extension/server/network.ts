/**
 * Network utilities — remote detection, port binding, browser opening.
 * isRemoteSession, getServerPort, listenOnPort, openBrowser
 */

import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { release } from "node:os";

const DEFAULT_REMOTE_PORT = 19432;
const LOOPBACK_HOST = "127.0.0.1";

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
export function openBrowser(url: string): {
	opened: boolean;
	isRemote?: boolean;
	url?: string;
} {
	const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
	if (isRemoteSession() && !browser) {
		return { opened: false, isRemote: true, url };
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
