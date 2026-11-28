/**
 * The loopback ports Plannotator servers on this machine hold, read from the
 * data dir's registries: the Inbox's (`inbox/inbox.json`: its window port and
 * the loopback listeners it publishes over Tailscale) and every live session
 * (`sessions/*.json`). Annotate's live app probe refuses these targets before
 * contacting them (packages/shared/live-probe.ts), which also covers a
 * Plannotator binary older than the Plannotator server header.
 *
 * Read-only: nothing is created, cleaned up or deleted. Entries whose process
 * is gone are skipped (their port may belong to a dev server now). Vendored to
 * the Pi extension.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getPlannotatorDataDir } from "./data-dir";

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function isAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ports of the running Inbox and the live Plannotator sessions. */
export function listPlannotatorServerPorts(dataDir: string = getPlannotatorDataDir()): number[] {
  const ports = new Set<number>();

  const inbox = readJson(join(dataDir, "inbox", "inbox.json"));
  if (inbox && isAlive(inbox.pid)) {
    if (isPort(inbox.port)) ports.add(inbox.port);
    const tailnet = inbox.tailnet as Record<string, unknown> | undefined;
    if (tailnet && isPort(tailnet.door_port)) ports.add(tailnet.door_port);
    const tailscale = inbox.tailscale as Record<string, unknown> | undefined;
    if (tailscale && isPort(tailscale.proxy_port)) ports.add(tailscale.proxy_port);
  }

  let names: string[] = [];
  try {
    names = readdirSync(join(dataDir, "sessions"));
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const session = readJson(join(dataDir, "sessions", name));
    if (session && isPort(session.port) && isAlive(session.pid)) ports.add(session.port);
  }

  return [...ports];
}
