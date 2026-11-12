import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleDailyPing, type DailyPingTool } from "@plannotator/shared/daily-ping";
import { setStarAskRelease } from "@plannotator/shared/star-ask";

export const OPENCODE_RELEASE_MARK = "release.json";

let version: string | undefined | null = null;
let versionForTests: { version: string | undefined } | null = null;

export function setOpenCodePingVersionForTests(value: { version: string | undefined } | null): void {
  versionForTests = value;
  version = null;
}

export function openCodePingVersion(from: string = fileURLToPath(import.meta.url)): string | undefined {
  const dir = path.dirname(from);
  if (path.basename(dir) !== "dist") return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "..", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "@plannotator/opencode" || typeof pkg.version !== "string") return undefined;
    const mark = JSON.parse(readFileSync(path.join(dir, OPENCODE_RELEASE_MARK), "utf8")) as { version?: unknown };
    return mark.version === pkg.version ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function scheduleOpenCodeDailyPing(tool: DailyPingTool): void {
  try {
    if (version === null) version = versionForTests ? versionForTests.version : openCodePingVersion();
    setStarAskRelease(version !== undefined);
    scheduleDailyPing({ version, release: version !== undefined, tool });
  } catch {
  }
}
