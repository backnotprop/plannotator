/**
 * Session Registry
 *
 * Tracks active Plannotator server sessions in ~/.plannotator/sessions/
 * so users can discover and reopen closed browser tabs.
 */

import { join } from "path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "fs";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

export interface SessionInfo {
  /**
   * Registry key used for the on-disk session file. Defaults to the process id.
   * A runtime that hosts more than one concurrent session inside a single
   * process (for example the embedded OpenCode runtime) must pass a unique id
   * so concurrent sessions do not overwrite one another.
   */
  id?: string;
  pid: number;
  port: number;
  url: string;
  mode: "plan" | "review" | "annotate" | "archive" | "goal-setup";
  project: string;
  startedAt: string;
  label: string;
}

/** Registry key for a session: an explicit id when present, otherwise the pid. */
export function sessionKey(info: Pick<SessionInfo, "id" | "pid">): string {
  return info.id ?? String(info.pid);
}

function getSessionsDir(): string {
  const dir = join(getPlannotatorDataDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(key: string): string {
  return join(getSessionsDir(), `${key}.json`);
}

/**
 * Check if a process is still alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the current server session. Best-effort: the registry only powers
 * `plannotator sessions` discovery, so an unwritable data dir (read-only
 * mount, disk full) must never take the server down with it.
 */
export function registerSession(info: SessionInfo): void {
  try {
    writeFileSync(sessionPath(sessionKey(info)), JSON.stringify(info, null, 2), "utf-8");
  } catch {
    // Session discovery is unavailable; the session itself is unaffected.
  }
}

/**
 * Unregister a session by its registry key (an explicit session id or a pid).
 * Defaults to the current process's pid. No-op if not found.
 */
export function unregisterSession(key: string | number = process.pid): void {
  try {
    const filePath = sessionPath(String(key));
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Ignore delete failures (including an unwritable sessions dir).
  }
}

/**
 * List all active sessions. Automatically removes stale entries.
 */
export function listSessions(): SessionInfo[] {
  const active: SessionInfo[] = [];

  let entries: string[];
  let dir: string;
  try {
    dir = getSessionsDir();
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const filePath = join(dir, entry);
    try {
      const data: SessionInfo = JSON.parse(readFileSync(filePath, "utf-8"));

      if (isAlive(data.pid)) {
        active.push(data);
      } else {
        // Stale session — clean up
        try {
          unlinkSync(filePath);
        } catch {}
      }
    } catch {
      // Corrupt file — remove it
      try {
        unlinkSync(filePath);
      } catch {}
    }
  }

  // Sort by most recent first
  return active.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}
