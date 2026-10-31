/**
 * The Inbox's tailnet door mapping (inbox-devices.ts): which tailnet HTTPS
 * port the door takes, and the record of the mapping this Inbox made.
 *
 * The record (`inbox/tailnet-door.json`, 0600, temp file then rename):
 * `{ v: 1, https_port, target, published }`.
 *  - `https_port`: the door's port. The first publish takes the first port of
 *    `INBOX_TAILNET_HTTPS_PORTS` (8443, then 8444 to 8450) with no
 *    `tailscale serve` mapping; that port travels in every link code, way
 *    back and phone pairing, so it sticks. Later starts publish on it again.
 *    When another mapping holds it, the door does not move: it refuses, and
 *    says so (`held`). The port is forgotten only when the switch goes off
 *    (the person's own switch, or the last machine unlinked with Phones off).
 *  - `target`: where the mapping points (`http://127.0.0.1:<door listener>`).
 *  - `published`: the mapping may exist. Written true BEFORE `tailscale
 *    serve` runs, so a crash between the two never leaves a mapping the Inbox
 *    does not own; false once a take-down removed it (or found it gone).
 * Only a mapping on that port with exactly that target, while `published`,
 * is the Inbox's. Anything else is never adopted, re-pointed or removed,
 * even a mapping whose target is the port the door listener happens to bind.
 *
 * Before this record (v0.28.40 and earlier), the Inbox kept only inbox.json's
 * `tailnet: { https_port, door_port }`, written after a successful publish.
 * Once, while no record exists, that is read as the record
 * (`adoptLegacyTailnetDoor`): the mapping on that port is the Inbox's only if
 * it points at exactly `http://127.0.0.1:<door_port>`. Once a record was
 * written, inbox.json never counts again.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { serveStatusProxy } from "@plannotator/shared/tailscale";

/** The tailnet HTTPS ports the door may take, in order (8443 is the contract's, ruling 8). */
export const INBOX_TAILNET_HTTPS_PORTS: readonly number[] = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450];
/** The ports, for the person: "8443 to 8450". */
export const INBOX_TAILNET_PORT_RANGE = `${INBOX_TAILNET_HTTPS_PORTS[0]} to ${INBOX_TAILNET_HTTPS_PORTS.at(-1)}`;
export const INBOX_TAILNET_DOOR_FILE = "tailnet-door.json";

export interface TailnetDoorRecord {
  /** The door's tailnet HTTPS port: kept until the switch goes off. */
  https_port: number;
  /** Where its mapping points: `http://127.0.0.1:<door listener port>`. */
  target: string;
  /** The mapping may exist (written before `tailscale serve`; false once taken down). */
  published: boolean;
}

const recordPath = (dataDir: string) => join(inboxDir(dataDir), INBOX_TAILNET_DOOR_FILE);
const LOOPBACK_TARGET = /^http:\/\/127\.0\.0\.1:\d+$/;

/** The record; null when there is none, or it cannot be read (then nothing is the Inbox's). */
export function readTailnetDoorRecord(dataDir: string): TailnetDoorRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(dataDir), "utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.https_port) || typeof parsed.target !== "string" || !LOOPBACK_TARGET.test(parsed.target)) return null;
    return { https_port: parsed.https_port as number, target: parsed.target, published: parsed.published === true };
  } catch {
    return null;
  }
}

/** Whether a record was ever written for this data dir (it then keeps inbox.json's legacy fields from counting). */
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

/** The switch went off: the port is forgotten with the mapping. */
export function clearTailnetDoorRecord(dataDir: string): void {
  rmSync(recordPath(dataDir), { force: true });
}

/**
 * Once, with no record yet: read a v0.28.40-era inbox.json `tailnet: {
 * https_port, door_port }` as the record. Its port is kept (it is the one
 * phones were given); the mapping counts as the Inbox's only when it points
 * at exactly that `door_port`. Nothing is written when there is nothing to
 * read, or when `serveStatus` cannot be read (tried again next time).
 */
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

/** What an older build's inbox.json `tailnet` says, as a record: its mapping is the Inbox's only when it points at exactly its `door_port`. Writes nothing. */
export function legacyTailnetDoorRecord(legacy: { https_port?: number; door_port?: number } | undefined, serveStatus: string): TailnetDoorRecord | null {
  if (!legacy?.door_port || !legacy.https_port || !INBOX_TAILNET_HTTPS_PORTS.includes(legacy.https_port)) return null;
  const mapped = serveStatusProxy(serveStatus, legacy.https_port);
  if (mapped.state === "malformed") return null;
  const target = `http://127.0.0.1:${legacy.door_port}`;
  return { https_port: legacy.https_port, target, published: mapped.state === "mapped" && mapped.proxy === target };
}

export type TailnetDoorPort =
  /** `own`: the record's target, when the port already maps to it (re-pointed, never re-made). */
  | { state: "usable"; port: number; own: string | null }
  /** The kept port is held by another mapping: the door does not move. */
  | { state: "held"; port: number }
  /** First publish: every port is held. */
  | { state: "taken" }
  | { state: "malformed" };

/** The port the door takes, read from `tailscale serve status --json`: the record's port, else (first publish) the first free one. */
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
