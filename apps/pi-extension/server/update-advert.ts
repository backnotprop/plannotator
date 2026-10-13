/**
 * Update notices for the Pi extension's review windows (design:
 * .product/approved/plannotator-updates/ §4.5, §4.9): the same once-a-day
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
import { buildUpdateAdvert, readUpdateState, scheduleReleaseCheck, type UpdateAdvert } from "../generated/update-check.ts";

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

let scheduled = false;

/**
 * The advert for a Pi review window's payload: read from the cache only, so
 * a page load never waits on the network. The first call in this process also
 * schedules the daily check (fire-and-forget; it answers from the cache within
 * its window). Nothing for another origin (oh-my-pi updates differently) or
 * while update checks are off.
 */
export function piUpdateAdvert(origin?: string | null): { updateAvailable?: UpdateAdvert } {
	try {
		if ((origin ?? "pi") !== "pi") return {};
		if (!resolveUpdateCheck(loadConfig())) return {};
		const current = piExtensionVersion();
		if (!current) return {};
		if (!scheduled) {
			scheduled = true;
			scheduleReleaseCheck({ enabled: () => resolveUpdateCheck(loadConfig()) });
		}
		const advert = buildUpdateAdvert({ state: readUpdateState(), current, action: "pi", platform: process.platform });
		return advert ? { updateAvailable: advert } : {};
	} catch {
		return {};
	}
}
