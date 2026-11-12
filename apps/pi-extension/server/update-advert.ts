import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveUpdateCheck } from "../generated/config.ts";
import {
	buildUpdateAdvert,
	buildUpdateCheckFailing,
	PI_UPDATE_COMMAND,
	readUpdateState,
	scheduleReleaseCheck,
	type UpdateAdvert,
	type UpdateCheckFailingAdvert,
} from "../generated/update-check.ts";

let packageVersion: string | null | undefined;

export function piExtensionVersion(): string | null {
	if (packageVersion !== undefined) return packageVersion;
	try {
		const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")) as { version?: unknown };
		packageVersion = typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		packageVersion = null;
	}
	return packageVersion;
}

export function piUpdateAdvert(origin?: string | null): { updateAvailable?: UpdateAdvert; updateCheckFailing?: UpdateCheckFailingAdvert } {
	try {
		if ((origin ?? "pi") !== "pi") return {};
		if (!resolveUpdateCheck(loadConfig())) return {};
		const current = piExtensionVersion();
		if (!current) return {};
		scheduleReleaseCheck({ enabled: () => resolveUpdateCheck(loadConfig()) });
		const state = readUpdateState();
		const advert = buildUpdateAdvert({ state, current, action: "pi", platform: process.platform });
		if (advert) return { updateAvailable: advert };
		const failing = buildUpdateCheckFailing(state, Date.now(), PI_UPDATE_COMMAND);
		return failing ? { updateCheckFailing: failing } : {};
	} catch {
		return {};
	}
}
