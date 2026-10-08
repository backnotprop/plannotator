/**
 * The Plannotator Snapshots hub registry: `${dataDir}/snapshots/hub.json`.
 *
 * `{ v, pid, port, url, version, token, serverSession, startedAt, cli }`,
 * mode 0600, written by the hub when it starts and left in place when it
 * exits (same rules as the Inbox registry): callers read it on every use,
 * never cache the port or token, and treat it as running only when the health
 * answer on that port carries this entry's `serverSession`.
 *
 * Every agent-session host (the Claude Code mod, `plannotator snapshot
 * --wait`) and the native app read the token here; it guards every route but
 * the health check and the HUD page itself. It rotates on each start.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOTS_DIR = "snapshots";
export const SNAPSHOTS_REGISTRY_FILE = "hub.json";
const START_LOCK = "start.lock";
const START_LOCK_STALE_MS = 30_000;

export interface SnapshotsHubEntry {
  v: 1;
  pid: number;
  port: number;
  url: string;
  version: string;
  token: string;
  serverSession: string;
  startedAt: string;
  /** The argv that runs this CLI. Informational: the native app never runs it (it uses the argv the CLI saved in its defaults, after checking it). */
  cli: string[];
}

export interface SnapshotsHubHealth {
  ok: true;
  app: "plannotator-snapshots-hub";
  pid: number;
  serverSession: string;
  version: string;
}

export function snapshotsDir(dataDir: string): string {
  return join(dataDir, SNAPSHOTS_DIR);
}

export function snapshotsRegistryPath(dataDir: string): string {
  return join(snapshotsDir(dataDir), SNAPSHOTS_REGISTRY_FILE);
}

export function createSnapshotsToken(): string {
  return randomBytes(32).toString("hex");
}

export function readSnapshotsRegistry(dataDir: string): SnapshotsHubEntry | null {
  try {
    const value = JSON.parse(readFileSync(snapshotsRegistryPath(dataDir), "utf8")) as SnapshotsHubEntry;
    return value && value.v === 1 && typeof value.port === "number" && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}

export function writeSnapshotsRegistry(dataDir: string, entry: SnapshotsHubEntry): void {
  mkdirSync(snapshotsDir(dataDir), { recursive: true, mode: 0o700 });
  const path = snapshotsRegistryPath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Filesystems without modes.
  }
  renameSync(temp, path);
}

export async function fetchSnapshotsHubHealth(port: number, timeoutMs = 1500): Promise<SnapshotsHubHealth | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/snapshots/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as SnapshotsHubHealth;
    return body && body.app === "plannotator-snapshots-hub" ? body : null;
  } catch {
    return null;
  }
}

/** The running hub's entry, or null. */
export async function runningSnapshotsHub(dataDir: string): Promise<SnapshotsHubEntry | null> {
  const entry = readSnapshotsRegistry(dataDir);
  if (!entry) return null;
  const health = await fetchSnapshotsHubHealth(entry.port);
  return health && health.serverSession === entry.serverSession ? entry : null;
}

/** One starter at a time; null when another holds a fresh lock. */
export function acquireSnapshotsStartLock(dataDir: string): (() => void) | null {
  mkdirSync(snapshotsDir(dataDir), { recursive: true, mode: 0o700 });
  const lock = join(snapshotsDir(dataDir), START_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs <= START_LOCK_STALE_MS) return null;
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // Gone in between: try again.
      }
    }
  }
  return null;
}

export async function waitFor<T>(check: () => Promise<T | null>, timeoutMs: number, intervalMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
