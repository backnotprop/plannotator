/** `published` is written true BEFORE `tailscale serve` runs, so a crash between the two never leaves a mapping the Inbox does not own. Only a mapping on the record's port with exactly its target, while published, is the Inbox's: anything else is never adopted, re-pointed or removed. */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { serveStatusProxy } from "@plannotator/shared/tailscale";

/** The tailnet HTTPS ports the door may take, in order. */
export const INBOX_TAILNET_HTTPS_PORTS: readonly number[] = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450];
export const INBOX_TAILNET_PORT_RANGE = `${INBOX_TAILNET_HTTPS_PORTS[0]} to ${INBOX_TAILNET_HTTPS_PORTS.at(-1)}`;
export const INBOX_TAILNET_DOOR_FILE = "tailnet-door.json";

export interface TailnetDoorRecord {
  https_port: number;
  target: string;
  published: boolean;
}

const recordPath = (dataDir: string) => join(inboxDir(dataDir), INBOX_TAILNET_DOOR_FILE);
const LOOPBACK_TARGET = /^http:\/\/127\.0\.0\.1:\d+$/;

export function readTailnetDoorRecord(dataDir: string): TailnetDoorRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(dataDir), "utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.https_port) || typeof parsed.target !== "string" || !LOOPBACK_TARGET.test(parsed.target)) return null;
    return { https_port: parsed.https_port as number, target: parsed.target, published: parsed.published === true };
  } catch {
    return null;
  }
}

export function hasTailnetDoorRecord(dataDir: string): boolean {
  return existsSync(recordPath(dataDir));
}

export function writeTailnetDoorRecord(dataDir: string, record: TailnetDoorRecord): void {
  if (!existsSync(inboxDir(dataDir))) return;
  const path = recordPath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, ...record })}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function clearTailnetDoorRecord(dataDir: string): void {
  rmSync(recordPath(dataDir), { force: true });
}

/** Once, with no record: read a legacy inbox.json `tailnet` as the record. Nothing is written when there is nothing to read or `serveStatus` cannot be read. */
export function adoptLegacyTailnetDoor(
  dataDir: string,
  legacy: { https_port?: number; door_port?: number } | undefined,
  serveStatus: string,
): TailnetDoorRecord | null {
  if (hasTailnetDoorRecord(dataDir)) return readTailnetDoorRecord(dataDir);
  const record = legacyTailnetDoorRecord(legacy, serveStatus);
  if (record) writeTailnetDoorRecord(dataDir, record);
  return record;
}

export function legacyTailnetDoorRecord(legacy: { https_port?: number; door_port?: number } | undefined, serveStatus: string): TailnetDoorRecord | null {
  if (!legacy?.door_port || !legacy.https_port || !INBOX_TAILNET_HTTPS_PORTS.includes(legacy.https_port)) return null;
  const mapped = serveStatusProxy(serveStatus, legacy.https_port);
  if (mapped.state === "malformed") return null;
  const target = `http://127.0.0.1:${legacy.door_port}`;
  return { https_port: legacy.https_port, target, published: mapped.state === "mapped" && mapped.proxy === target };
}

export type TailnetDoorPort =
  | { state: "usable"; port: number; own: string | null }
  /** The kept port is held by another mapping: the door does not move. */
  | { state: "held"; port: number }
  /** First publish: every port is held. */
  | { state: "taken" }
  | { state: "malformed" };

export function chooseTailnetDoorPort(serveStatus: string, record: TailnetDoorRecord | null): TailnetDoorPort {
  if (record) {
    const mapped = serveStatusProxy(serveStatus, record.https_port);
    if (mapped.state === "malformed") return { state: "malformed" };
    if (mapped.state === "free") return { state: "usable", port: record.https_port, own: null };
    if (record.published && mapped.proxy === record.target) return { state: "usable", port: record.https_port, own: record.target };
    return { state: "held", port: record.https_port };
  }
  for (const port of INBOX_TAILNET_HTTPS_PORTS) {
    const mapped = serveStatusProxy(serveStatus, port);
    if (mapped.state === "malformed") return { state: "malformed" };
    if (mapped.state === "free") return { state: "usable", port, own: null };
  }
  return { state: "taken" };
}
