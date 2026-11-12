import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId, type InboxPin } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_PINS_FILE = "pins.json";

export const INBOX_PIN_ORDER_MAX = 10_000;

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_PINS_FILE);
}

export function readInboxPins(inboxDirPath: string): InboxPin[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; pins?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.pins)) return [];
  const out: InboxPin[] = [];
  const seen = new Set<string>();
  for (const entry of file.pins as unknown[]) {
    const pin = entry as { thread_id?: unknown; pinned_at?: unknown } | null;
    if (!pin || typeof pin !== "object" || !isInboxId("msg", pin.thread_id) || typeof pin.pinned_at !== "string") continue;
    if (seen.has(pin.thread_id)) continue;
    seen.add(pin.thread_id);
    out.push({ thread_id: pin.thread_id, pinned_at: pin.pinned_at });
  }
  return out;
}

export function inboxPinsFileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
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

export function writeInboxPins(inboxDirPath: string, pins: readonly InboxPin[]): void {
  const file = fileOf(inboxDirPath);
  const state = inboxPinsFileState(inboxDirPath);
  if (state === "newer") {
    throw new InboxError("pins_newer", "pins.json was written by a newer Plannotator; update Plannotator to change pins.");
  }
  if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (pins.length === 0) {
    try {
      unlinkSync(file);
    } catch {
    }
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, pins: pins.map((pin) => ({ thread_id: pin.thread_id, pinned_at: pin.pinned_at })) })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function checkInboxPinOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > INBOX_PIN_ORDER_MAX || !value.every((id) => isInboxId("msg", id))) {
    throw new InboxError("validation_error", "order: a list of thread ids (msg_), in the order they show.", { field: "order" });
  }
  if (new Set(value).size !== value.length) throw new InboxError("validation_error", "order: a thread id appears twice.", { field: "order" });
  return value as string[];
}

export interface InboxPinRestore {
  thread_id: string;
  index: number;
  pinned_at: string;
}

export function checkInboxPinRestore(value: unknown): InboxPinRestore {
  const restore = value as { thread_id?: unknown; index?: unknown; pinned_at?: unknown } | null;
  if (
    !restore ||
    typeof restore !== "object" ||
    !isInboxId("msg", restore.thread_id) ||
    typeof restore.index !== "number" ||
    !Number.isInteger(restore.index) ||
    restore.index < 0 ||
    restore.index > INBOX_PIN_ORDER_MAX ||
    typeof restore.pinned_at !== "string" ||
    restore.pinned_at.length > 64 ||
    Number.isNaN(Date.parse(restore.pinned_at))
  ) {
    throw new InboxError("validation_error", "restore: { thread_id (msg_), index (a whole number), pinned_at (an ISO time) }.", { field: "restore" });
  }
  return { thread_id: restore.thread_id, index: restore.index, pinned_at: restore.pinned_at };
}
