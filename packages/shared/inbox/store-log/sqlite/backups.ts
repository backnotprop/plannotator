/**
 * The dated backups a move leaves in the inbox folder (`import.ts`: the JSONL files; `return-to-files.ts`: the
 * database), for Settings → Storage: each listed with its size, and removed only by the person's Remove. Nothing
 * else ever removes one. Only a folder whose name is a backup's can be listed or removed.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InboxStoreBackup } from "../log";
import { bytesUnder } from "./move-files";

const BACKUP_NAME = /^backup-(\d{4}-\d{2}-\d{2})-(jsonl|sqlite)(?:-\d+)?$/;

export function listInboxBackups(inboxDir: string): InboxStoreBackup[] {
  let names: string[];
  try {
    names = readdirSync(inboxDir);
  } catch {
    return [];
  }
  const out: InboxStoreBackup[] = [];
  for (const name of names.sort()) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;
    try {
      const path = join(inboxDir, name);
      if (!statSync(path).isDirectory()) continue;
      out.push({ name, kind: match[2] as InboxStoreBackup["kind"], date: match[1]!, bytes: bytesUnder(path) });
    } catch {
      // Removed meanwhile.
    }
  }
  return out;
}

/** Remove the backup `name` (its files are read-only; the folders are the owner's). False: no such backup. */
export function removeInboxBackup(inboxDir: string, name: string): boolean {
  if (!BACKUP_NAME.test(name)) return false;
  const path = join(inboxDir, name);
  if (!existsSync(path) || !statSync(path).isDirectory()) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}
