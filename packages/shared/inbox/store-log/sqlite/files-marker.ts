/**
 * The note an Inbox on SQLite leaves where the JSONL files were: a plain text FILE named `projects` in the inbox
 * folder, where an Inbox on files keeps a FOLDER of that name.
 *
 * Why: a Plannotator older than the SQLite log (every release up to 0.28.61) reads only the files. Over an Inbox on
 * SQLite it would find no `projects` folder, start an empty Inbox beside `inbox.db`, and the person would see their
 * Inbox empty. With this file in the way, an older Plannotator's start fails on its first read (it lists `projects`
 * and gets "not a directory") before it writes anything: the Inbox does not start, its log names this file, and the
 * file says in plain words what happened and how to get everything back. Nothing is lost either way.
 *
 * Present exactly while `inbox.db` is the record: written when the database serves (`open-store.ts`), removed
 * before the files come back (`return-to-files.ts`) or when there is no database. A real `projects` is always a
 * folder, so a `projects` that is a file is always this note: the move code skips it (`move-files.ts`).
 *
 * Kept free of SQLite and the store: the move code and the export read it.
 */
import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR } from "../../schema";

/** What the note says (a person may open it; an older Plannotator's log names its path). */
export const INBOX_SQLITE_MARKER_TEXT = [
  "This Plannotator Inbox keeps its messages in inbox.db, in this folder.",
  "",
  "An older Plannotator cannot read inbox.db, so it does not start the Inbox here",
  "rather than show it empty. Nothing is lost: update Plannotator and the Inbox",
  "is back as it was.",
  "",
  "To keep using an older Plannotator: run this version's Inbox once with",
  "PLANNOTATOR_INBOX_SQLITE=0 (it moves everything back into files an older",
  "version reads), or save a copy with: plannotator inbox export --jsonl <folder>",
  "",
].join("\n");

/** `projects` under `inboxDir` is the note, not a folder of records. */
export function isSqliteMarker(inboxDir: string): boolean {
  try {
    return statSync(join(inboxDir, INBOX_PROJECTS_DIR)).isFile();
  } catch {
    return false;
  }
}

/** Leave the note, unless something is already called `projects` (a folder of records stays as it is). */
export function writeSqliteMarker(inboxDir: string): void {
  const path = join(inboxDir, INBOX_PROJECTS_DIR);
  try {
    statSync(path);
    return;
  } catch {}
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, INBOX_SQLITE_MARKER_TEXT, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Best effort: the Inbox serves the same without it; only an older Plannotator would miss it.
    rmSync(temp, { force: true });
  }
}

/** Take the note away (the files are coming back, or there is no database); a folder of records is never touched. */
export function removeSqliteMarker(inboxDir: string): void {
  if (isSqliteMarker(inboxDir)) rmSync(join(inboxDir, INBOX_PROJECTS_DIR), { force: true });
}
