/**
 * Plannotator Inbox: artifacts the person pinned (approval
 * "inbox-artifact-stars"; the word is Pin). Not the sidebar's thread pins
 * (pins.ts, "Starred" threads): another file, other routes.
 *
 *   inbox/artifact-pins.json   { v: 1, pins: [{ key, thread_id, pinned_at }] }, in pin order, 0600, written whole (temp, then rename)
 *
 * A file outside the store's JSONL, as thread pins are: a pin is the person's
 * own mark and never enters the event log, which agents' cursors, the phone
 * relay and search read. It writes no line and takes no seq. Kept on the
 * server, so every window and phone of the person sees the same pins.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxArtifactPin } from "@plannotator/core/inbox-artifact-pins";
import { isInboxId } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_ARTIFACT_PINS_FILE = "artifact-pins.json";

/** An artifact's key: an attachment id, or `guide:<message id>`. */
export function isInboxArtifactKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("guide:")) return isInboxId("msg", value.slice("guide:".length));
  return /^att_[A-Za-z0-9]{1,64}$/.test(value);
}

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_ARTIFACT_PINS_FILE);
}

/** The pins on disk, in pin order. A file that does not parse reads as none; a bad or repeated entry is skipped. */
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

/** What the file holds before a write: nothing, a v1 file, one this Plannotator cannot read, or a newer version's. */
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

/**
 * Write the pins whole (owner-only). No pins removes the file. A file a newer
 * Plannotator wrote is never written over (refused); one that cannot be read
 * is moved aside first (`artifact-pins.json.unreadable-<time>`), as pins.json is.
 */
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
