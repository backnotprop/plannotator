import { execFile } from "node:child_process";
import { cliVersionFrom } from "@plannotator/core/model-catalog";
import { buildWindowsCommandScriptSpawnCommand, resolveWindowsCommandShim } from "./command-path.ts";

const PI_VERSION_TIMEOUT_MS = 10_000;

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
