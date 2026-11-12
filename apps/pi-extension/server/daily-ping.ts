import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleDailyPing, type DailyPingTool } from "../generated/daily-ping.ts";

export const PI_RELEASE_MARK = "release.json";

let versionForTests: { version: string | undefined } | null = null;

export function setPiPingVersionForTests(value: { version: string | undefined } | null): void {
	versionForTests = value;
}

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
		scheduleDailyPing({ version, release: version !== undefined, tool });
	} catch {
	}
}
