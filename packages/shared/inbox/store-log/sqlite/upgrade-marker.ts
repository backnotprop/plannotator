/**
 * "A move into SQLite is running now, in this process": a small file beside the database the import writes
 * (`inbox-upgrading.pid`, the importing process's pid), removed when the move ends, whichever way it ends.
 *
 * Starters read it (`inbox-command.ts`): one that started an Inbox, or waits for one, keeps waiting while the move
 * runs instead of giving up after its usual 20 s, and the start lock is never taken as stale meanwhile, so no second
 * Inbox starts beside the moving one. A crash leaves the file with a pid that is gone, which reads as no move.
 *
 * Kept free of SQLite and the store: the registry's start lock reads it on every start.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "../../schema";

export const INBOX_UPGRADE_MARKER = "inbox-upgrading.pid";

/** Say a move runs in this process (`dir`: the inbox folder). */
export function markUpgradeRunning(dir: string): void {
  writeFileSync(join(dir, INBOX_UPGRADE_MARKER), `${process.pid}\n`, { mode: 0o600 });
}

/** The move in this process has ended. */
export function clearUpgradeMarker(dir: string): void {
  rmSync(join(dir, INBOX_UPGRADE_MARKER), { force: true });
}

/** A move into SQLite is running now: the marker names a live process. */
export function inboxUpgradeRunning(dataDir: string): boolean {
  return markerAlive(inboxDir(dataDir));
}

/** A crashed move's marker (its process is gone) is removed: it says nothing, and nothing should be left behind. */
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
    // EPERM: alive, someone else's (it cannot be ours to signal, but it runs).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
