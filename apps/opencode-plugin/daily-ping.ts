/**
 * The daily ping for OpenCode's in-process plan review, code review and
 * annotate servers: the same check the CLI, the Inbox and Pi run
 * (packages/shared/daily-ping.ts, sharing ping.json in the data dir), with this
 * plugin's version. Never awaited, never throws.
 *
 * Only the published package sends: its bundle runs from `dist/`, beside the
 * plugin's package.json one level up. Run from source (a checkout), it is a
 * development build and sends nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleDailyPing, type DailyPingTool } from "@plannotator/shared/daily-ping";

let version: string | undefined | null = null;

/** The plugin's version when it runs from its built `dist/` folder, else undefined. */
export function openCodePingVersion(from: string = fileURLToPath(import.meta.url)): string | undefined {
  const dir = path.dirname(from);
  if (path.basename(dir) !== "dist") return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "..", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return pkg.name === "@plannotator/opencode" && typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function scheduleOpenCodeDailyPing(tool: DailyPingTool): void {
  try {
    if (version === null) version = openCodePingVersion();
    scheduleDailyPing({ version, tool });
  } catch {
    // Never the session's problem.
  }
}
