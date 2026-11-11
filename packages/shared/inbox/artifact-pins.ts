/** Pinned artifacts saved in inbox/artifact-pins.json (0600, written whole via temp + rename). Outside the store's JSONL: a pin never enters the event log. */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxArtifactPin } from "@plannotator/core/inbox-artifact-pins";
import { isInboxId } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_ARTIFACT_PINS_FILE = "artifact-pins.json";

export function isInboxArtifactKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("guide:")) return isInboxId("msg", value.slice("guide:".length));
  return /^att_[A-Za-z0-9]{1,64}$/.test(value);
}

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_ARTIFACT_PINS_FILE);
}

export function readInboxArtifactPins(inboxDirPath: string): InboxArtifactPin[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; pins?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.pins)) return [];
  const out: InboxArtifactPin[] = [];
  const seen = new Set<string>();
  for (const entry of file.pins as unknown[]) {
    const pin = entry as { key?: unknown; thread_id?: unknown; pinned_at?: unknown } | null;
    if (!pin || typeof pin !== "object" || !isInboxArtifactKey(pin.key) || !isInboxId("msg", pin.thread_id) || typeof pin.pinned_at !== "string") continue;
    if (seen.has(pin.key)) continue;
    seen.add(pin.key);
    out.push({ key: pin.key, thread_id: pin.thread_id, pinned_at: pin.pinned_at });
  }
  return out;
}

function fileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
  let raw: string;
  try {
    raw = readFileSync(fileOf(inboxDirPath), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "bad";
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "bad";
  }
  const file = value as { v?: unknown; pins?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return "bad";
  if (typeof file.v === "number" && file.v > 1) return "newer";
  return file.v === 1 && Array.isArray(file.pins) ? "ok" : "bad";
}

/** A file a newer Plannotator wrote is never written over; an unreadable one is moved aside first. */
export function writeInboxArtifactPins(inboxDirPath: string, pins: readonly InboxArtifactPin[]): void {
  const file = fileOf(inboxDirPath);
  const state = fileState(inboxDirPath);
  if (state === "newer") {
    throw new InboxError("artifact_pins_newer", "artifact-pins.json was written by a newer Plannotator; update Plannotator to change pins.");
  }
  if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (pins.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, pins: pins.map((pin) => ({ key: pin.key, thread_id: pin.thread_id, pinned_at: pin.pinned_at })) })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
