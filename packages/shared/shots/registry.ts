/**
 * The Plannotator Shots hub registry: `${dataDir}/shots/hub.json`.
 *
 * `{ v, pid, port, url, version, token, serverSession, startedAt, cli }`,
 * mode 0600, written by the hub when it starts and left in place when it
 * exits (same rules as the Inbox registry): callers read it on every use,
 * never cache the port or token, and treat it as running only when the health
 * answer on that port carries this entry's `serverSession`.
 *
 * Every agent-session host (the Claude Code mod, `plannotator screenshot
 * --wait`) and the native app read the token here; it guards every route but
 * the health check and the HUD page itself. It rotates on each start.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SHOTS_DIR = "shots";
export const SHOTS_REGISTRY_FILE = "hub.json";
const START_LOCK = "start.lock";
const START_LOCK_STALE_MS = 30_000;

export interface ShotsHubEntry {
  v: 1;
  pid: number;
  port: number;
  url: string;
  version: string;
  token: string;
  serverSession: string;
  startedAt: string;
  /** The argv that runs this CLI (the native app uses it to start the hub again). */
  cli: string[];
}

export interface ShotsHubHealth {
  ok: true;
  app: "plannotator-shots-hub";
  pid: number;
  serverSession: string;
  version: string;
}

export function shotsDir(dataDir: string): string {
  return join(dataDir, SHOTS_DIR);
}

export function shotsRegistryPath(dataDir: string): string {
  return join(shotsDir(dataDir), SHOTS_REGISTRY_FILE);
}

export function createShotsToken(): string {
  return randomBytes(32).toString("hex");
}

export function readShotsRegistry(dataDir: string): ShotsHubEntry | null {
  try {
    const value = JSON.parse(readFileSync(shotsRegistryPath(dataDir), "utf8")) as ShotsHubEntry;
    return value && value.v === 1 && typeof value.port === "number" && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}

export function writeShotsRegistry(dataDir: string, entry: ShotsHubEntry): void {
  mkdirSync(shotsDir(dataDir), { recursive: true, mode: 0o700 });
  const path = shotsRegistryPath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Filesystems without modes.
  }
  renameSync(temp, path);
}

export async function fetchShotsHubHealth(port: number, timeoutMs = 1500): Promise<ShotsHubHealth | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/shots/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as ShotsHubHealth;
    return body && body.app === "plannotator-shots-hub" ? body : null;
  } catch {
    return null;
  }
}

/** The running hub's entry, or null. */
export async function runningShotsHub(dataDir: string): Promise<ShotsHubEntry | null> {
  const entry = readShotsRegistry(dataDir);
  if (!entry) return null;
  const health = await fetchShotsHubHealth(entry.port);
  return health && health.serverSession === entry.serverSession ? entry : null;
}

/** One starter at a time; null when another holds a fresh lock. */
export function acquireShotsStartLock(dataDir: string): (() => void) | null {
  mkdirSync(shotsDir(dataDir), { recursive: true, mode: 0o700 });
  const lock = join(shotsDir(dataDir), START_LOCK);
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
