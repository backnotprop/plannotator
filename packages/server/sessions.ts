/**
 * Session Registry
 *
 * Tracks active Plannotator server sessions in ~/.plannotator/sessions/
 * so users can discover and reopen closed browser tabs.
 *
 * Servers that run inside a host's own process (OpenCode) are kept apart in
 * `sessions/<host>/`: they do not run the plannotator binary, so they must
 * never hold back its update. Every release's readers list only the top
 * folder's `*.json` files, so an older binary never sees them either.
 */

import { connect } from "net";
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
  /** Set on a server running inside this host's process, not the binary's. */
  host?: InProcessHost;
}

/** Hosts that run Plannotator's servers in their own process. */
export type InProcessHost = "opencode";

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
  try {
    writeAtomic(sessionPath(info.pid), JSON.stringify(info, null, 2));
  } catch {
    // Session discovery is unavailable; the session itself is unaffected.
  }
}

// Atomic (temp + rename): a reader never sees a half-written file, which
// listSessions would take for a corrupt one and delete. The temp name does
// not end in `.json`, so no lister reads it.
function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, body, "utf-8");
    try {
      renameSync(tmp, path);
    } catch {
      // Windows refuses the rename while a reader holds the old file open:
      // write it directly instead (the old, non-atomic behaviour).
      writeFileSync(path, body, "utf-8");
    }
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
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

function inProcessDir(host: InProcessHost): string {
  return join(getPlannotatorDataDir(), "sessions", host);
}

const ownInProcessFiles = new Set<string>();
let exitCleanupArmed = false;

/**
 * Register a server that runs inside the host's process (keyed `<pid>-<port>`:
 * one process holds several). Returns the function that removes the entry; it
 * also runs at process exit. A signal death skips exit handlers (a listener
 * would change the host's own signal handling), so the readers drop an entry
 * whose process is gone or whose port no longer answers.
 */
export function registerInProcessSession(host: InProcessHost, info: Omit<SessionInfo, "pid" | "host">): () => void {
  let path: string;
  try {
    const dir = inProcessDir(host);
    path = join(dir, `${process.pid}-${info.port}.json`);
    mkdirSync(dir, { recursive: true });
    sweepDeadEntries(dir);
    writeAtomic(path, JSON.stringify({ ...info, pid: process.pid, host }, null, 2));
    ownInProcessFiles.add(path);
  } catch {
    return () => {};
  }
  if (!exitCleanupArmed) {
    exitCleanupArmed = true;
    process.on("exit", () => {
      for (const file of ownInProcessFiles) removeFile(file);
    });
  }
  return () => {
    if (ownInProcessFiles.delete(path)) removeFile(path);
  };
}

/** Delete entries whose process is gone (a host killed by a signal), so none waits for a `plannotator sessions` run. */
function sweepDeadEntries(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    try {
      const { pid } = JSON.parse(readFileSync(filePath, "utf-8")) as { pid?: unknown };
      if (typeof pid === "number" && isGone(pid)) removeFile(filePath);
    } catch {}
  }
}

/** Only a process that does not exist: EPERM is one owned by someone else, alive. */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/** True when something accepts connections on the loopback port. */
function portAnswers(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * The live in-process sessions of a host, for `plannotator sessions` only (the
 * update checks never read them). Removes an entry whose process is gone, whose
 * port no longer answers, or that cannot be read.
 */
export async function listInProcessSessions(host: InProcessHost): Promise<SessionInfo[]> {
  const dir = inProcessDir(host);
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  const found = await Promise.all(
    entries.map(async (entry): Promise<SessionInfo | null> => {
      const filePath = join(dir, entry);
      try {
        const data = JSON.parse(readFileSync(filePath, "utf-8")) as SessionInfo;
        if (typeof data?.pid === "number" && typeof data.port === "number" && isAlive(data.pid) && (await portAnswers(data.port))) {
          return { ...data, host };
        }
      } catch {}
      removeFile(filePath);
      return null;
    }),
  );
  return found.filter((s): s is SessionInfo => s !== null);
}
