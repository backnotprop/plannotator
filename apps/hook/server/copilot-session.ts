/**
 * Copilot CLI Session Parser
 *
 * Extracts recent assistant messages and plan content from a Copilot CLI session.
 * Copilot CLI stores sessions at ~/.copilot/session-state/<uuid>/
 *
 * Detection: Copilot CLI sets no identifying environment variable. Instead,
 * each live session holds a session-state/<uuid>/inuse.<pid>.lock file, where
 * <pid> is the copilot process. Matching lock pids against our ancestor pids
 * identifies the session this process was spawned from.
 *
 * Session directory contents:
 *   events.jsonl    — All session events (JSONL format)
 *   workspace.yaml  — Session metadata (id, cwd, summary, timestamps)
 *   session.db      — SQLite database with turns, checkpoints, etc.
 *   plan.md         — Plan content (if plan mode was used)
 *
 * Event types in events.jsonl:
 *   assistant.message — { messageId, content, toolRequests, interactionId }
 *   user.message      — { content, transformedContent, source }
 *   tool.*            — Tool execution events
 *   hook.*            — Hook invocation events
 *   session.*         — Session lifecycle events
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getAncestorPids, createDefaultGetParentPid } from "./session-log";

// --- Types ---

interface CopilotEvent {
  type: string;
  data: {
    messageId?: string;
    content?: string;
    toolRequests?: unknown[];
    interactionId?: string;
    [key: string]: unknown;
  };
  id: string;
  timestamp: string;
}

// --- Session Directory Discovery ---

/**
 * Find the Copilot CLI session directory for a given CWD.
 *
 * Strategy (in priority order):
 * 1. Active session (has inuse.*.lock file) matching CWD
 * 2. Any active session
 * 3. Most recently modified session matching CWD
 * 4. Most recently modified session overall
 */
export function findCopilotSessionForCwd(cwd: string): string | null {
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  const sessionsDir = join(copilotHome, "session-state");
  if (!existsSync(sessionsDir)) return null;

  const entries = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dirPath = join(sessionsDir, e.name);
      try {
        const wsPath = join(dirPath, "workspace.yaml");
        let sessionCwd: string | undefined;
        if (existsSync(wsPath)) {
          const ws = readFileSync(wsPath, "utf-8");
          const cwdMatch = ws.match(/^cwd:\s*(.+)$/m);
          sessionCwd = cwdMatch?.[1]?.trim();
        }

        const dirFiles = readdirSync(dirPath);
        const hasLock = dirFiles.some(
          (f) => f.startsWith("inuse.") && f.endsWith(".lock"),
        );

        return {
          name: e.name,
          path: dirPath,
          cwd: sessionCwd,
          hasLock,
          mtime: statSync(dirPath).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{
    name: string;
    path: string;
    cwd?: string;
    hasLock: boolean;
    mtime: number;
  }>;

  // Sort by modification time (newest first)
  entries.sort((a, b) => b.mtime - a.mtime);

  // Normalize paths for comparison
  const normCwd = cwd.replace(/\\/g, "/").toLowerCase();
  const matchesCwd = (entry: (typeof entries)[0]) =>
    entry.cwd?.replace(/\\/g, "/").toLowerCase() === normCwd;

  return (
    entries.find((e) => e.hasLock && matchesCwd(e))?.path ??
    entries.find((e) => e.hasLock)?.path ??
    entries.find((e) => matchesCwd(e))?.path ??
    entries[0]?.path ??
    null
  );
}

// --- Session Lock Detection ---

/**
 * Match a pid chain against the lock files under `sessionStateDir`
 * (`<uuid>/inuse.<pid>.lock`). Returns the first pid in `pids` that owns a
 * lock, with its session directory. Malformed lock names and unreadable
 * session dirs are skipped; a missing `sessionStateDir` returns null.
 */
export function matchCopilotSessionLockToPids(
  sessionStateDir: string,
  pids: number[],
): { sessionDir: string; pid: number } | null {
  if (pids.length === 0) return null;

  let entries;
  try {
    entries = readdirSync(sessionStateDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const lockOwners = new Map<number, string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(sessionStateDir, entry.name);
    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      const lockPid = f.match(/^inuse\.(\d+)\.lock$/)?.[1];
      if (!lockPid) continue;
      const pid = parseInt(lockPid, 10);
      if (!lockOwners.has(pid)) lockOwners.set(pid, dirPath);
    }
  }

  for (const pid of pids) {
    const sessionDir = lockOwners.get(pid);
    if (sessionDir) return { sessionDir, pid };
  }
  return null;
}

/**
 * Resolve the Copilot session that spawned this process by walking up the
 * pid chain and matching each ancestor against session lock files.
 *
 * Locks can outlive their session and pids get reused, so a match only
 * counts if the matched pid still names a copilot process. Returns null when
 * no ancestor holds a live lock, or where the process table or `ps` is
 * unavailable.
 */
export function findCopilotSessionByAncestorPids(
  opts: {
    startPid?: number;
    sessionStateDir?: string;
    getParentPid?: (pid: number) => number | null;
    getProcessName?: (pid: number) => string | null;
    maxHops?: number;
  } = {},
): string | null {
  const startPid = opts.startPid ?? process.pid;
  if (!startPid) return null;
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  const sessionStateDir =
    opts.sessionStateDir ?? join(copilotHome, "session-state");
  const getParent = opts.getParentPid ?? createDefaultGetParentPid();
  const getProcessName = opts.getProcessName ?? getProcessCommand;
  const maxHops = opts.maxHops ?? 8;

  let pids = getAncestorPids(startPid, maxHops, getParent);
  while (pids.length > 0) {
    const match = matchCopilotSessionLockToPids(sessionStateDir, pids);
    if (!match) return null;
    if (isCopilotProcessName(getProcessName(match.pid))) {
      return match.sessionDir;
    }
    // Stale lock or reused pid: drop it and retry with the remaining chain
    pids = pids.filter((p) => p !== match.pid);
  }
  return null;
}

function isCopilotProcessName(command: string | null): boolean {
  if (!command) return false;
  return basename(command.trim()).startsWith("copilot");
}

/**
 * `ps -o comm=` for one pid. Null on any failure; without a process name the
 * pid-reuse guard rejects every match, so platforms lacking `ps` degrade to
 * no detection.
 */
function getProcessCommand(pid: number): string | null {
  try {
    const result = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

// --- Plan Content Discovery ---

/**
 * Find the plan.md content for a Copilot CLI session.
 *
 * Uses sessionId (from hook input) if available, otherwise falls back
 * to finding the most recently modified plan.md across all sessions.
 */
export function findCopilotPlanContent(sessionId?: string): string | null {
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  const sessionsDir = join(copilotHome, "session-state");

  // Primary: use sessionId directly (validate UUID to prevent path traversal)
  if (sessionId && /^[a-f0-9-]{36}$/i.test(sessionId)) {
    const planPath = join(sessionsDir, sessionId, "plan.md");
    if (existsSync(planPath)) {
      return readFileSync(planPath, "utf-8");
    }
  }

  // Fallback: find most recently modified plan.md
  if (!existsSync(sessionsDir)) return null;

  const candidates = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = join(sessionsDir, e.name, "plan.md");
      try {
        return { path: p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ path: string; mtime: number }>;

  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return null;

  return readFileSync(candidates[0].path, "utf-8");
}

// --- Message Extraction ---

/**
 * Walk backward through events.jsonl, returning up to `limit` recent
 * `assistant.message` events with non-empty content (newest first).
 */
export function getRecentCopilotMessages(
  sessionDir: string,
  limit: number,
): { messageId: string; text: string; timestamp?: string }[] {
  const eventsPath = join(sessionDir, "events.jsonl");
  if (!existsSync(eventsPath)) return [];

  const content = readFileSync(eventsPath, "utf-8");
  const lines = content.trim().split("\n");

  const out: { messageId: string; text: string; timestamp?: string }[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let event: CopilotEvent;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (event.type !== "assistant.message") continue;
    if (!event.data.content?.trim()) continue;

    out.push({
      messageId: event.data.messageId || event.id,
      text: event.data.content,
      timestamp: event.timestamp,
    });
  }
  return out;
}
