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
  renameSync,
  unlinkSync,
  existsSync,
} from "fs";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

export interface SessionInfo {
  pid: number;
  port: number;
  url: string;
  mode: "plan" | "review" | "annotate" | "archive" | "goal-setup";
  project: string;
  startedAt: string;
  label: string;
  /** The agent session that started this one, when the host tagged it (`claude-code:<session id>`). */
  hostSession?: string;
  /** The `pn-` id the host gave this review (`PLANNOTATOR_HOST_REVIEW_ID`), when a host started it. */
  reviewId?: string;
  /** What the session is of, in full: an absolute path, URL, PR URL or reviewed directory (a bundle's files joined with ", "). */
  target?: string;
}

function getSessionsDir(): string {
  const dir = join(getPlannotatorDataDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(pid: number): string {
  return join(getSessionsDir(), `${pid}.json`);
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
  // Atomic (temp + rename): a reader never sees a half-written file, which
  // listSessions would take for a corrupt one and delete. The temp name does
  // not end in `.json`, so no lister reads it.
  let tmp: string | null = null;
  try {
    const path = sessionPath(info.pid);
    const body = JSON.stringify(info, null, 2);
    tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, body, "utf-8");
    try {
      renameSync(tmp, path);
    } catch {
      // Windows refuses the rename while a reader holds the old file open:
      // write it directly instead (the old, non-atomic behaviour).
      writeFileSync(path, body, "utf-8");
    }
  } catch {
    // Session discovery is unavailable; the session itself is unaffected.
  } finally {
    if (tmp) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {}
    }
  }
}

/**
 * Unregister the current process's session. No-op if not found.
 */
export function unregisterSession(pid: number = process.pid): void {
  try {
    const filePath = sessionPath(pid);
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

/**
 * The live sessions, read only: never creates the folder and never deletes a
 * file (a dead or unreadable entry is skipped, not removed). For hot paths
 * that run on every page payload (isAutoUpdateActive), where cleaning up is
 * not their business.
 */
export function listLiveSessions(): SessionInfo[] {
  const dir = join(getPlannotatorDataDir(), "sessions");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const live: SessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, entry), "utf-8")) as SessionInfo;
      if (typeof data?.pid === "number" && isAlive(data.pid)) live.push(data);
    } catch {
      // Unreadable or half-written: skipped, never removed here.
    }
  }
  return live;
}
