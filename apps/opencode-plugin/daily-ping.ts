/**
 * The daily ping for OpenCode's in-process plan review, code review and
 * annotate servers: the same check the CLI, the Inbox and Pi run
 * (packages/shared/daily-ping.ts, sharing ping.json in the data dir), with this
 * plugin's version. Never awaited, never throws.
 *
 * Only the published package sends. Release CI marks it: after building, it
 * writes `dist/release.json` (`{"version":"X.Y.Z"}`, release.yml). A local
 * `bun run build:opencode`, or a run from source, has no such file (or one for
 * another version) and is a development build that sends nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleDailyPing, type DailyPingTool } from "@plannotator/shared/daily-ping";

/** The file release CI writes into `dist/` to mark a published build. */
export const OPENCODE_RELEASE_MARK = "release.json";

let version: string | undefined | null = null;
let versionForTests: { version: string | undefined } | null = null;

/** Tests only: the version the plugin pings with (null: back to the real one). */
export function setOpenCodePingVersionForTests(value: { version: string | undefined } | null): void {
  versionForTests = value;
  version = null;
}

/**
 * The plugin's version when it runs from a `dist/` folder release CI marked
 * (`dist/release.json` naming the package's own version), else undefined.
 */
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
    scheduleDailyPing({ version, release: version !== undefined, tool });
  } catch {
    // Never the session's problem.
  }
}
