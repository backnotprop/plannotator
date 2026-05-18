import {
  PLANNOTATOR_DAEMON_PROTOCOL,
  PLANNOTATOR_DAEMON_PROTOCOL_VERSION,
} from "@plannotator/shared/daemon-protocol";
import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync, statSync, type Stats } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const DAEMON_AUTH_QUERY_PARAM = "plannotator_auth";
export const DAEMON_AUTH_COOKIE = "plannotator_daemon_auth";

export interface DaemonState {
  protocol: typeof PLANNOTATOR_DAEMON_PROTOCOL;
  protocolVersion: typeof PLANNOTATOR_DAEMON_PROTOCOL_VERSION;
  pid: number;
  port: number;
  hostname: string;
  baseUrl: string;
  startedAt: string;
  isRemote: boolean;
  remoteSource: "env" | "ssh" | "local";
  authToken: string;
  requestedPort?: number;
  binaryVersion?: string;
}

export interface DaemonPaths {
  dir: string;
  statePath: string;
  lockPath: string;
}

export interface DaemonStateOptions {
  baseDir?: string;
  isAlive?: (pid: number) => boolean;
}

export type DaemonStateReadResult =
  | { kind: "missing" }
  | { kind: "malformed"; path: string; error: string }
  | { kind: "stale"; path: string; state: DaemonState }
  | { kind: "incompatible"; path: string; state: unknown }
  | { kind: "active"; path: string; state: DaemonState };

export interface DaemonLock {
  path: string;
  release: () => void;
}

export type DaemonLockResult =
  | { ok: true; lock: DaemonLock }
  | { ok: false; code: "locked"; message: string; pid?: number }
  | { ok: false; code: "failed"; message: string };

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createDaemonAuthToken(): string {
  return randomBytes(32).toString("hex");
}

export function createDaemonBrowserAuthUrl(state: DaemonState, pathname = "/"): string {
  const url = new URL(pathname, state.baseUrl);
  url.searchParams.set(DAEMON_AUTH_QUERY_PARAM, state.authToken);
  return url.toString();
}

export function getDaemonPaths(options: DaemonStateOptions = {}): DaemonPaths {
  const dir = options.baseDir ?? join(homedir(), ".plannotator");
  return {
    dir,
    statePath: join(dir, "daemon.json"),
    lockPath: join(dir, "daemon.lock"),
  };
}

export function isDaemonState(value: unknown): value is DaemonState {
  const state = value as Partial<DaemonState> | null;
  return (
    !!state &&
    state.protocol === PLANNOTATOR_DAEMON_PROTOCOL &&
    state.protocolVersion === PLANNOTATOR_DAEMON_PROTOCOL_VERSION &&
    typeof state.pid === "number" &&
    Number.isInteger(state.pid) &&
    state.pid > 0 &&
    typeof state.port === "number" &&
    Number.isInteger(state.port) &&
    state.port > 0 &&
    state.port < 65536 &&
    typeof state.hostname === "string" &&
    typeof state.baseUrl === "string" &&
    typeof state.startedAt === "string" &&
    typeof state.isRemote === "boolean" &&
    typeof state.authToken === "string" &&
    state.authToken.length >= 32
  );
}

export function readDaemonState(options: DaemonStateOptions = {}): DaemonStateReadResult {
  const paths = getDaemonPaths(options);
  if (!existsSync(paths.statePath)) return { kind: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.statePath, "utf-8"));
  } catch (err) {
    return {
      kind: "malformed",
      path: paths.statePath,
      error: err instanceof Error ? err.message : "Could not parse daemon state",
    };
  }

  if (!isDaemonState(parsed)) {
    return { kind: "incompatible", path: paths.statePath, state: parsed };
  }

  const isAlive = options.isAlive ?? defaultIsAlive;
  if (!isAlive(parsed.pid)) {
    return { kind: "stale", path: paths.statePath, state: parsed };
  }

  return { kind: "active", path: paths.statePath, state: parsed };
}

export function writeDaemonState(state: DaemonState, options: DaemonStateOptions = {}): void {
  const paths = getDaemonPaths(options);
  mkdirSync(dirname(paths.statePath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.statePath, JSON.stringify(state, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(paths.statePath, 0o600);
  } catch {
    // Best-effort on platforms/filesystems that do not support POSIX modes.
  }
}

export function removeDaemonState(options: DaemonStateOptions = {}): void {
  const paths = getDaemonPaths(options);
  rmSync(paths.statePath, { force: true });
}

export function removeDaemonFiles(options: DaemonStateOptions = {}): void {
  const paths = getDaemonPaths(options);
  rmSync(paths.statePath, { force: true });
  rmSync(paths.lockPath, { force: true });
}

function readLockPid(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function sameLockFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

export function acquireDaemonLock(options: DaemonStateOptions = {}): DaemonLockResult {
  const paths = getDaemonPaths(options);
  mkdirSync(paths.dir, { recursive: true });
  const isAlive = options.isAlive ?? defaultIsAlive;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(paths.lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n`, "utf-8");
      closeSync(fd);
      fd = undefined;
      return {
        ok: true,
        lock: {
          path: paths.lockPath,
          release: () => {
            if (readLockPid(paths.lockPath) === process.pid) {
              rmSync(paths.lockPath, { force: true });
            }
          },
        },
      };
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return {
          ok: false,
          code: "failed",
          message: err instanceof Error ? err.message : "Could not acquire daemon lock",
        };
      }

      let before: Stats;
      try {
        before = statSync(paths.lockPath);
      } catch {
        continue;
      }
      const lockPid = readLockPid(paths.lockPath);
      if (lockPid && isAlive(lockPid)) {
        return {
          ok: false,
          code: "locked",
          pid: lockPid,
          message: `A Plannotator daemon lock is already held by PID ${lockPid}.`,
        };
      }

      try {
        const after = statSync(paths.lockPath);
        if (sameLockFile(before, after)) {
          rmSync(paths.lockPath, { force: true });
        }
      } catch {}
    }
  }

  return {
    ok: false,
    code: "failed",
    message: "Could not acquire daemon lock after retrying stale lock cleanup.",
  };
}

export function createDaemonState(input: {
  pid?: number;
  port: number;
  hostname: string;
  isRemote: boolean;
  remoteSource: DaemonState["remoteSource"];
  authToken?: string;
  startedAt?: string;
  binaryVersion?: string;
  requestedPort?: number;
}): DaemonState {
  const baseHost = input.isRemote
    ? input.hostname === "0.0.0.0" ? "localhost" : input.hostname
    : "localhost";
  return {
    protocol: PLANNOTATOR_DAEMON_PROTOCOL,
    protocolVersion: PLANNOTATOR_DAEMON_PROTOCOL_VERSION,
    pid: input.pid ?? process.pid,
    port: input.port,
    hostname: input.hostname,
    baseUrl: `http://${baseHost}:${input.port}`,
    startedAt: input.startedAt ?? new Date().toISOString(),
    isRemote: input.isRemote,
    remoteSource: input.remoteSource,
    authToken: input.authToken ?? createDaemonAuthToken(),
    ...(input.binaryVersion && { binaryVersion: input.binaryVersion }),
    ...(input.requestedPort !== undefined && { requestedPort: input.requestedPort }),
  };
}
