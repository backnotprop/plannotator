/** Holds the moving process's pid. Kept free of SQLite and the store: the registry's start lock reads it on every start. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "../../schema";

export const INBOX_UPGRADE_MARKER = "inbox-upgrading.pid";

export function markUpgradeRunning(dir: string): void {
  writeFileSync(join(dir, INBOX_UPGRADE_MARKER), `${process.pid}\n`, { mode: 0o600 });
}

export function clearUpgradeMarker(dir: string): void {
  rmSync(join(dir, INBOX_UPGRADE_MARKER), { force: true });
}

export function inboxUpgradeRunning(dataDir: string): boolean {
  return markerAlive(inboxDir(dataDir));
}

export function clearStaleUpgradeMarker(dir: string): void {
  if (!markerAlive(dir)) clearUpgradeMarker(dir);
}

function markerAlive(dir: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(join(dir, INBOX_UPGRADE_MARKER), "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
