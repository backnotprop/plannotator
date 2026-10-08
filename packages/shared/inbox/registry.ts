/**
 * Plannotator Inbox registry: `${dataDir}/inbox/inbox.json`.
 *
 * `{ v, pid, port, url, version, token, serverSession, startedAt, tailnet? }`, mode
 * 0600, written by the Inbox server when it starts and LEFT IN PLACE when it
 * exits, so a person who ran the Inbox once has it found by every agent
 * session, and a caller can start it again on the port it last had.
 *
 *  - Found: the file exists.
 *  - Read on every call: callers never cache the port or token.
 *  - The token rotates on every start; it guards the connection routes only.
 *  - Running: the health answer on that port carries this entry's
 *    `serverSession`. Stopped: a dead pid with no health answer, an answer
 *    from a different `serverSession` (the port was reused), or a live pid
 *    with nothing listening (a reused pid). A stopped Inbox is started with
 *    `plannotator inbox --background`. Busy: a live pid whose port takes the
 *    request but does not answer in time; callers wait, never start a second
 *    writer on the store.
 *
 * The Inbox never registers in `sessions/`, so it never holds auto-update back
 * (auto-update skips while another live pid is registered there).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxHealth, type InboxHealth } from "@plannotator/core/inbox-types";
import { inboxDir } from "./schema";

export const INBOX_REGISTRY_FILE = "inbox.json";
export const INBOX_START_LOCK = "start.lock";
/** A start lock older than this belongs to a starter that died. */
export const INBOX_START_LOCK_STALE_MS = 30_000;

export interface InboxRegistryEntry {
  v: 1;
  pid: number;
  port: number;
  url: string;
  version: string;
  token: string;
  serverSession: string;
  startedAt: string;
  /**
   * "Reach from my tailnet" is on (adr/implementation/inbox-mobile.md,
   * section 1): the tailnet HTTPS port, kept across starts and re-pointed at
   * each start's loopback port. Absent: off.
   */
  tailnet?: { https_port: number };
}

export function inboxRegistryPath(dataDir: string): string {
  return join(inboxDir(dataDir), INBOX_REGISTRY_FILE);
}

/** A fresh connection token: 32 random bytes as hex. */
export function createInboxToken(): string {
  return randomBytes(32).toString("hex");
}

function isEntry(value: unknown): value is InboxRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.port === "number" &&
    Number.isInteger(v.port) &&
    v.port > 0 &&
    v.port < 65536 &&
    typeof v.url === "string" &&
    typeof v.version === "string" &&
    typeof v.token === "string" &&
    v.token.length >= 32 &&
    typeof v.serverSession === "string" &&
    typeof v.startedAt === "string"
  );
}

/** The registry entry, or null when there is none or it does not parse. */
export function readInboxRegistry(dataDir: string): InboxRegistryEntry | null {
  try {
    const value = JSON.parse(readFileSync(inboxRegistryPath(dataDir), "utf8"));
    return isEntry(value) ? value : null;
  } catch {
    return null;
  }
}

/** Write the entry atomically (temp file, then rename), owner-only. */
export function writeInboxRegistry(dataDir: string, entry: InboxRegistryEntry): void {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = inboxRegistryPath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Best effort where the filesystem has no modes.
  }
  renameSync(temp, path);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type HealthProbe =
  | { kind: "health"; health: InboxHealth }
  /** Something accepted the request but did not answer in time. */
  | { kind: "timeout" }
  /** Refused, or an answer that is not an Inbox's. */
  | { kind: "none" };

async function probeInboxHealth(port: number, timeoutMs: number): Promise<HealthProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: "none" };
    const body: unknown = await response.json();
    return isInboxHealth(body) ? { kind: "health", health: body } : { kind: "none" };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return name === "TimeoutError" || name === "AbortError" ? { kind: "timeout" } : { kind: "none" };
  }
}

/** `GET /api/inbox/health` on the entry's loopback port, or null when nothing answers as an Inbox. */
export async function fetchInboxHealth(port: number, timeoutMs = 2000): Promise<InboxHealth | null> {
  const probe = await probeInboxHealth(port, timeoutMs);
  return probe.kind === "health" ? probe.health : null;
}

export type InboxStatus =
  | { state: "missing" }
  | { state: "stopped"; entry: InboxRegistryEntry; reason: "dead_pid" | "no_answer" | "other_session" }
  /**
   * The registry's pid is alive and its port accepted the health request but
   * did not answer in time: an Inbox that is busy or paused, not a stopped
   * one. Starting another would put a second writer on the store, so callers
   * wait for it instead.
   */
  | { state: "busy"; entry: InboxRegistryEntry }
  | { state: "running"; entry: InboxRegistryEntry; health: InboxHealth };

/** Read the registry and check it against the process and the port. */
export async function inboxStatus(dataDir: string, timeoutMs = 2000): Promise<InboxStatus> {
  const entry = readInboxRegistry(dataDir);
  if (!entry) return { state: "missing" };
  const probe = await probeInboxHealth(entry.port, timeoutMs);
  if (probe.kind === "health") {
    if (probe.health.serverSession === entry.serverSession) return { state: "running", entry, health: probe.health };
    return { state: "stopped", entry, reason: "other_session" };
  }
  if (!isPidAlive(entry.pid)) return { state: "stopped", entry, reason: "dead_pid" };
  // A live pid whose port takes the connection but never answers is a busy or
  // paused Inbox; a live pid with nothing listening is a reused pid.
  return probe.kind === "timeout" ? { state: "busy", entry } : { state: "stopped", entry, reason: "no_answer" };
}

/**
 * The start lock: one starter at a time, so two agents that find the Inbox
 * stopped at once do not start two writers on one store. Returns a release
 * function, or null when another starter holds a fresh lock.
 */
export function acquireInboxStartLock(dataDir: string): (() => void) | null {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, INBOX_START_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs <= INBOX_START_LOCK_STALE_MS) return null;
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // Gone in between: try again.
      }
    }
  }
  return null;
}

/** Wait until `check` answers non-null, polling; null on timeout. */
export async function waitForInbox<T>(check: () => Promise<T | null>, timeoutMs: number, intervalMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Stop a running Inbox (uninstall --purge): ask it over its token-guarded
 * stop route, then wait for the pid to exit. A pid is signalled only while the
 * port still answers with this entry's `serverSession`, so a reused pid is
 * never touched. Answers what happened.
 */
export async function stopInbox(
  dataDir: string,
  options: { timeoutMs?: number } = {},
): Promise<{ state: "not_running" } | { state: "stopped"; pid: number } | { state: "still_running"; pid: number }> {
  const timeoutMs = options.timeoutMs ?? 5000;
  let status = await inboxStatus(dataDir);
  if (status.state === "busy") {
    // Give a busy Inbox the stop window to answer; never purge under a live writer.
    const busy = status;
    const answered = await waitForInbox(async () => {
      const next = await inboxStatus(dataDir, 1000);
      return next.state === "busy" ? null : next;
    }, timeoutMs);
    if (!answered) return { state: "still_running", pid: busy.entry.pid };
    status = answered;
  }
  if (status.state !== "running") return { state: "not_running" };
  const { entry } = status;
  try {
    await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Fall through to the signal below.
  }
  const exited = await waitForInbox(async () => (isPidAlive(entry.pid) ? null : true), timeoutMs);
  if (exited) return { state: "stopped", pid: entry.pid };
  const health = await fetchInboxHealth(entry.port);
  if (health && health.serverSession === entry.serverSession && health.pid === entry.pid) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    const killed = await waitForInbox(async () => (isPidAlive(entry.pid) ? null : true), timeoutMs);
    if (killed) return { state: "stopped", pid: entry.pid };
  }
  return { state: "still_running", pid: entry.pid };
}
