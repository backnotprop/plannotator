/**
 * Whether the person has turned the Plannotator Inbox on on this computer (the
 * mark and its rule: INBOX_TURNED_ON_FILE in connection.ts). The CLI, the
 * Pi extension, OpenCode, DSH, Cline, OpenClaw and Hermes (`plannotator inbox
 * connection`) read it here; the Claude Code mod reads the same files itself
 * (apps/hook/hooks/mod/inbox-turned-on.ts).
 *
 * An install from before the mark (an Inbox ran here, no mark) is decided once,
 * by the first reader, from cheap files only (`inboxPersonUsedIt`): a person's
 * use keeps it on, else only agents ever started it and it stays off. The
 * answer is written as the mark (created only if still absent, so the first
 * writer wins), so it is never decided again and nothing an agent writes
 * later turns it on.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PERSON_FILES, INBOX_TURNED_ON_FILE, inboxMarkSaysOn, inboxPersonUsedIt } from "./connection";

/** Set on the start at login's run (packages/server/inbox-scheduled-login.ts): one of Plannotator's own starts, which never turns the Inbox on. */
export const INBOX_LOGIN_ITEM_ENV = "PLANNOTATOR_INBOX_LOGIN_ITEM";

export function inboxTurnedOnPath(dataDir: string): string {
  return join(dataDir, "inbox", INBOX_TURNED_ON_FILE);
}

/**
 * A test run's scratch data dir with no mark counts as on, so the suites that
 * start Inboxes need no mark: only a variable that only tests set says so
 * (`PLANNOTATOR_TEST_INBOX_ON=1`, or the test sandbox marker). `=0` gives the
 * real rule. Nothing about where the data dir is counts.
 */
export function testRunCountsOn(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.PLANNOTATOR_TEST_INBOX_ON === "0") return false;
  return env.PLANNOTATOR_TEST_INBOX_ON === "1" || !!env.PLANNOTATOR_TEST_SANDBOX;
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

function writeMark(dataDir: string, on: boolean, by: string, flag: "w" | "wx"): void {
  mkdirSync(join(dataDir, "inbox"), { recursive: true, mode: 0o700 });
  writeFileSync(inboxTurnedOnPath(dataDir), `${JSON.stringify({ on, by, at: new Date().toISOString() })}\n`, { mode: 0o600, flag });
}

/** A person's run of `plannotator inbox`: the Inbox is on here from now on. Never throws; false when it could not be written. */
export function markInboxTurnedOn(dataDir: string): boolean {
  try {
    writeMark(dataDir, true, "command", "w");
    return true;
  } catch {
    return false;
  }
}

/** The one-time decision's evidence, from the files themselves (no thread is read). */
function personUsedIt(dataDir: string): boolean {
  const inbox: Record<string, string | null | undefined> = {};
  for (const file of INBOX_PERSON_FILES) {
    const path = join(dataDir, "inbox", file.name);
    if (file.read) {
      inbox[file.name] = read(path);
      continue;
    }
    try {
      const stat = statSync(path);
      inbox[file.name] = file.dir || stat.size > 0 ? "" : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      inbox[file.name] = code === "ENOENT" || code === "ENOTDIR" ? undefined : null;
    }
  }
  // One that cannot be read is passed as broken JSON, which counts.
  const text = (path: string) => {
    const t = read(path);
    return t === undefined ? null : t === null ? "{" : t;
  };
  return inboxPersonUsedIt({ config: text(join(dataDir, "config.json")), state: text(join(dataDir, "state.json")), inbox });
}

/** Whether the person has turned the Inbox on here: the one gate (see the file's comment). */
export function isInboxTurnedOn(dataDir: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const mark = read(inboxTurnedOnPath(dataDir));
  if (mark === null) return true;
  if (mark !== undefined) return inboxMarkSaysOn(mark);
  if (testRunCountsOn(env)) return true;
  if (read(join(dataDir, "inbox", "inbox.json")) === undefined) return false;
  const on = personUsedIt(dataDir);
  try {
    writeMark(dataDir, on, on ? "update-used" : "update-agent-only", "wx");
  } catch {
    // Another reader decided first (its mark stands), or it cannot be written: the answer holds for this run.
    const written = read(inboxTurnedOnPath(dataDir));
    if (typeof written === "string") return inboxMarkSaysOn(written);
  }
  return on;
}
