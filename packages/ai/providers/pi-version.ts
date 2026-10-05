/**
 * The installed `pi`'s version, for the Bun and Node Pi providers.
 *
 * `pi --version` prints the bare version ("0.85.1") and exits right after
 * argument parsing, before any session or model setup. The version decides
 * whether Ask AI may set a thinking level at all (`piThinkingLevelsSupported`
 * in core/model-catalog): older pi persisted RPC `set_thinking_level` as the
 * user's global default.
 *
 * `node:child_process` works under both Bun and Node (jiti), so one module
 * serves both providers.
 */

import { execFile } from "node:child_process";
import { cliVersionFrom } from "@plannotator/core/model-catalog";
import { buildWindowsCommandScriptSpawnCommand, resolveWindowsCommandShim } from "./command-path.ts";

const PI_VERSION_TIMEOUT_MS = 10_000;

/** Run `pi --version`; undefined on any failure or unparseable output. Never throws. */
export function probePiVersion(piPath: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			const commandPath = resolveWindowsCommandShim(piPath);
			const [file, ...args] =
				buildWindowsCommandScriptSpawnCommand(commandPath, ["--version"]) ?? [commandPath, "--version"];
			execFile(file, args, { timeout: PI_VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
				resolve(err ? undefined : cliVersionFrom(String(stdout)));
			});
		} catch {
			resolve(undefined);
		}
	});
}

/**
 * One version probe per provider: discovery and a session that wants to set a
 * thinking level share it, and a failure is retried on the next call (a
 * success is kept for the process, like the model list).
 */
export function createPiVersionProbe(piPath: () => string) {
	let pending: Promise<string | undefined> | null = null;
	let known: string | undefined;
	return {
		get version(): string | undefined {
			return known;
		},
		ensure(): Promise<string | undefined> {
			if (known) return Promise.resolve(known);
			pending ??= probePiVersion(piPath()).then((version) => {
				pending = null;
				if (version) known = version;
				return version;
			});
			return pending;
		},
	};
}
