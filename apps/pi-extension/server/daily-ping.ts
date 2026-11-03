/**
 * The daily ping for Pi's plan review, code review and annotate servers: the
 * same check the CLI and the Inbox run (generated/daily-ping.ts, sharing
 * ping.json in the data dir, so each tool sends once a day whichever runs
 * first), with this package's version. Never awaited, never throws.
 *
 * A Pi extension that runs from this repository (apps/pi-extension inside the
 * monorepo) is a development build and never sends.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleDailyPing, type DailyPingTool } from "../generated/daily-ping.ts";
import { piExtensionVersion } from "./update-advert.ts";

let versionForTests: { version: string | undefined } | null = null;

/** Tests only: the version the Pi servers ping with (null: back to the real one). */
export function setPiPingVersionForTests(value: { version: string | undefined } | null): void {
	versionForTests = value;
}

/** This package's version, or undefined for a checkout of the repository (a dev build). */
export function piPingVersion(): string | undefined {
	if (versionForTests) return versionForTests.version;
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		if (existsSync(join(here, "..", "..", "..", "packages", "shared", "daily-ping.ts"))) return undefined;
	} catch {
		return undefined;
	}
	return piExtensionVersion() ?? undefined;
}

export function schedulePiDailyPing(tool: DailyPingTool): void {
	try {
		const version = piPingVersion();
		// Installed from npm (not run from this repository): a release.
		scheduleDailyPing({ version, release: version !== undefined, tool });
	} catch {
		// Never the session's problem.
	}
}
