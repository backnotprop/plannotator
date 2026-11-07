/**
 * The daily ping for Pi's plan review, code review and annotate servers: the
 * same check the CLI and the Inbox run (generated/daily-ping.ts, sharing
 * ping.json in the data dir, so each tool sends once a day whichever runs
 * first), with this package's version. Never awaited, never throws.
 *
 * Only the published package sends. Release CI marks it: before packing, it
 * writes `release.json` (`{"version":"X.Y.Z"}`) beside package.json
 * (release.yml), and `files` ships it. A run from this repository, a local
 * `bun pm pack`, or a copied folder has no such file (or one for another
 * version) and is a development build that sends nothing.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleDailyPing, type DailyPingTool } from "../generated/daily-ping.ts";

/** The file release CI writes beside package.json to mark a published build. */
export const PI_RELEASE_MARK = "release.json";

let versionForTests: { version: string | undefined } | null = null;

/** Tests only: the version the Pi servers ping with (null: back to the real one). */
export function setPiPingVersionForTests(value: { version: string | undefined } | null): void {
	versionForTests = value;
}

/**
 * The package's version when the package folder (`packageDir`, the one holding
 * package.json) carries release CI's mark for that same version, else
 * undefined (a development build).
 */
export function piPingVersionAt(packageDir: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { name?: unknown; version?: unknown };
		if (pkg.name !== "@plannotator/pi-extension" || typeof pkg.version !== "string") return undefined;
		const mark = JSON.parse(readFileSync(join(packageDir, PI_RELEASE_MARK), "utf-8")) as { version?: unknown };
		return mark.version === pkg.version ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

/** This package's version when release CI marked it, else undefined (a dev build). */
export function piPingVersion(): string | undefined {
	if (versionForTests) return versionForTests.version;
	try {
		return piPingVersionAt(join(dirname(fileURLToPath(import.meta.url)), ".."));
	} catch {
		return undefined;
	}
}

export function schedulePiDailyPing(tool: DailyPingTool): void {
	try {
		const version = piPingVersion();
		// Marked by release CI: a release.
		scheduleDailyPing({ version, release: version !== undefined, tool });
	} catch {
		// Never the session's problem.
	}
}
