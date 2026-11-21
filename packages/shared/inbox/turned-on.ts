/**
 * Whether the person has turned the Plannotator Inbox on on this computer (the
 * mark and its rule: INBOX_TURNED_ON_FILE in connection.ts). The CLI, the
 * Pi extension, OpenCode, DSH, Cline, OpenClaw and Hermes (`plannotator inbox
 * connection`) read it here; the Claude Code mod reads the same files itself
 * (apps/hook/hooks/mod/inbox-turned-on.ts).
 *
 * An install from before the mark (an Inbox ran here: `inbox/inbox.json`, and
 * no mark) is on: the first reader writes the mark on (`update-existing`), so
 * only a computer where the Inbox never ran starts off. The same holds when an
 * older `plannotator`, which knows no mark, starts the person's Inbox. No other
 * file is read.
 */

import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { INBOX_TURNED_ON_FILE, inboxMarkSaysOn } from "./connection";

export function inboxTurnedOnPath(dataDir: string): string {
  return join(dataDir, "inbox", INBOX_TURNED_ON_FILE);
}

const realOr = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Whether `dir` is inside the OS temp folder or /tmp: a scratch folder, never a person's real data dir. */
function isScratchFolder(dir: string): boolean {
  const real = realOr(dir);
  return [tmpdir(), "/tmp", "/private/tmp"].some((root) => real.startsWith(`${realOr(root).replace(/[\\/]+$/, "")}${sep}`));
}

/**
 * A test run's data dir with no mark counts as on, so the suites that start
 * Inboxes need no mark: `PLANNOTATOR_TEST_INBOX_ON=1` (set only on purpose),
 * or the test sandbox marker for a scratch data dir (inside the OS temp
 * folder). `=0` gives the real rule.
 */
export function testRunCountsOn(dataDir: string, env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.PLANNOTATOR_TEST_INBOX_ON === "0") return false;
  if (env.PLANNOTATOR_TEST_INBOX_ON === "1") return true;
  return !!env.PLANNOTATOR_TEST_SANDBOX && isScratchFolder(dataDir);
}

/** A file's text; undefined when it is not there, null when it is there but cannot be read. */
function read(path: string): string | null | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? undefined : null;
  }
}

/**
 * Write the mark whole, never half: a temp file first, then moved into place
 * (`replace`) or linked there only if no mark is there yet (the first writer
 * wins). No reader ever sees an empty mark.
 */
function writeMark(dataDir: string, by: string, replace: boolean): void {
  mkdirSync(join(dataDir, "inbox"), { recursive: true, mode: 0o700 });
  const path = inboxTurnedOnPath(dataDir);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ on: true, by, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  if (replace) return renameSync(temp, path);
  try {
    linkSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}

/** A person's run of `plannotator inbox`: the Inbox is on here from now on. Never throws; false when it could not be written. */
export function markInboxTurnedOn(dataDir: string): boolean {
  try {
    writeMark(dataDir, "command", true);
    return true;
  } catch {
    return false;
  }
}

/** Whether the person has turned the Inbox on here: the one gate (see the file's comment). */
export function isInboxTurnedOn(dataDir: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const mark = read(inboxTurnedOnPath(dataDir));
  if (mark === null) return true;
  if (mark !== undefined) return inboxMarkSaysOn(mark);
  if (testRunCountsOn(dataDir, env)) return true;
  let ran: boolean;
  try {
    ran = statSync(join(dataDir, "inbox", "inbox.json")).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // It could not be checked: on for this read (never darken an Inbox), with nothing written.
    return true;
  }
  if (!ran) return true;
  // An Inbox ran here before the mark (or an older plannotator started it): on, written once. Another
  // reader may have written it first; either way the mark says on.
  try {
    writeMark(dataDir, "update-existing", false);
  } catch {}
  return true;
}
