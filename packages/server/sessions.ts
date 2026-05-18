/**
 * Session Registry
 *
 * Tracks active Plannotator server sessions in ~/.plannotator/sessions/
 * so users can discover and reopen closed browser tabs.
 */

import { homedir } from "os";
import { join } from "path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "fs";

export interface SessionInfo {
  pid: number;
  port: number;
  url: string;
  mode: "plan" | "review" | "annotate" | "archive";
  project: string;
  startedAt: string;
  label: string;
}

function getSessionsDir(): string {
  const dir = join(homedir(), ".plannotator", "sessions");
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
 * Register the current server session.
 */
export function registerSession(info: SessionInfo): void {
  writeFileSync(sessionPath(info.pid), JSON.stringify(info, null, 2), "utf-8");
}

/**
 * Unregister the current process's session. No-op if not found.
 */
export function unregisterSession(pid: number = process.pid): void {
  const filePath = sessionPath(pid);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Ignore delete failures
  }
}

/**
 * List all active sessions. Automatically removes stale entries.
 */
export function listSessions(): SessionInfo[] {
  const dir = getSessionsDir();
  const active: SessionInfo[] = [];

  let entries: string[];
  try {
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
