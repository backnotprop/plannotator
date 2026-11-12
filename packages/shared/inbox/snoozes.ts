import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId } from "@plannotator/core/inbox-types";
import { INBOX_SNOOZE_MAX_DAYS, inboxSnoozeRefusal, type InboxSnooze } from "@plannotator/core/inbox-snooze";
import { InboxError } from "./schema";

export const INBOX_SNOOZES_FILE = "snoozes.json";

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_SNOOZES_FILE);
}

export function refuseInboxSnoozeUntil(until: unknown, now: Date): void {
  const refusal = inboxSnoozeRefusal(until, now);
  if (refusal === "past") throw new InboxError("snooze_past", "That time has passed.", { field: "until" });
  if (refusal) throw new InboxError("validation_error", `until: a time within ${INBOX_SNOOZE_MAX_DAYS} days.`, { field: "until" });
}

export function readInboxSnoozes(inboxDirPath: string): InboxSnooze[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; snoozes?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.snoozes)) return [];
  const out: InboxSnooze[] = [];
  const seen = new Set<string>();
  for (const entry of file.snoozes as unknown[]) {
    const snooze = entry as { thread_id?: unknown; until?: unknown; at?: unknown } | null;
    if (!snooze || typeof snooze !== "object" || !isInboxId("msg", snooze.thread_id)) continue;
    if (typeof snooze.until !== "string" || Number.isNaN(Date.parse(snooze.until)) || typeof snooze.at !== "string") continue;
    if (seen.has(snooze.thread_id)) continue;
    seen.add(snooze.thread_id);
    out.push({ thread_id: snooze.thread_id, until: snooze.until, at: snooze.at });
  }
  return out;
}

function fileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
  let raw: string;
  try {
    raw = readFileSync(fileOf(inboxDirPath), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "bad";
  }
  try {
    const file = JSON.parse(raw) as { v?: unknown; snoozes?: unknown } | null;
    if (!file || typeof file !== "object") return "bad";
    if (typeof file.v === "number" && file.v > 1) return "newer";
    return file.v === 1 && Array.isArray(file.snoozes) ? "ok" : "bad";
  } catch {
    return "bad";
  }
}

export function writeInboxSnoozes(inboxDirPath: string, snoozes: readonly InboxSnooze[]): void {
  const path = fileOf(inboxDirPath);
  const state = fileState(inboxDirPath);
  if (state === "newer") throw new InboxError("snoozes_newer", "A newer Plannotator keeps your snoozes here: update this one to change them.");
  if (state === "bad") {
    try {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
    } catch {
    }
  }
  if (snoozes.length === 0) {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, snoozes: snoozes.map(({ thread_id, until, at }) => ({ thread_id, until, at })) })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
