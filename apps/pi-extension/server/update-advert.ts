/**
 * Update notices for the Pi extension's review windows (design:
 * .product/approved/plannotator-updates/ §4.5, §4.9): the same
 * check the compiled CLI and the Inbox run (generated/update-check.ts, cached
 * in the shared data dir, so whichever runs first asks GitHub), compared with
 * this package's own version. Pi updates through npm, so the advert's action
 * is `pi` and its command `pi update --extensions`: the window never offers
 * to run the install script here.
 */

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

/** This extension's version (its package.json), or null when unreadable. */
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

/**
 * The advert for a Pi review window's payload: read from the cache only, so
 * a page load never waits on the network. Each call also schedules the release
 * check (fire-and-forget; it answers from the cache within its 10-minute
 * window, so a long-lived Pi still learns of a release without a restart).
 * Nothing for another origin (oh-my-pi updates differently) or while update
 * checks are off.
 */
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
		// Checking has failed for hours: the Options menu says so, with the command (npm, not GitHub).
		const failing = buildUpdateCheckFailing(state, Date.now(), PI_UPDATE_COMMAND);
		return failing ? { updateCheckFailing: failing } : {};
	} catch {
		return {};
	}
}
