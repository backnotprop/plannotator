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
  hostSession?: string;
  reviewId?: string;
  target?: string;
  host?: InProcessHost;
}

export type InProcessHost = "opencode";

function getSessionsDir(): string {
  const dir = join(getPlannotatorDataDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(pid: number): string {
  return join(getSessionsDir(), `${pid}.json`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerSession(info: SessionInfo): void {
  try {
    writeAtomic(sessionPath(info.pid), JSON.stringify(info, null, 2));
  } catch {
  }
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, body, "utf-8");
    try {
      renameSync(tmp, path);
    } catch {
      writeFileSync(path, body, "utf-8");
    }
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
  }
}

export function unregisterSession(pid: number = process.pid): void {
  try {
    const filePath = sessionPath(pid);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
  }
}

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
        try {
          unlinkSync(filePath);
        } catch {}
      }
    } catch {
      try {
        unlinkSync(filePath);
      } catch {}
    }
  }

  return active.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

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
    }
  }
  return live;
}

function inProcessDir(host: InProcessHost): string {
  return join(getPlannotatorDataDir(), "sessions", host);
}

const ownInProcessFiles = new Set<string>();
let exitCleanupArmed = false;

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
