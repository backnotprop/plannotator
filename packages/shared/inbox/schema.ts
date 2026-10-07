/**
 * Plannotator Inbox store: the on-disk layout and the line reader.
 *
 *   inbox/
 *     inbox.json                       the registry (registry.ts)
 *     projects/<key>/project.json      one line: the project snapshot
 *     projects/<key>/messages.jsonl    messages and replies
 *     projects/<key>/questions.jsonl   one record per question block
 *
 * Every line is `{ v, seq, at, kind, id, record }`: a full snapshot of one
 * record. The last line per id is current; nothing is rewritten in place.
 * `seq` is one counter across the whole Inbox, recovered at start as the
 * highest seen, so the union of all lines ordered by seq is the event log.
 * Fields are only ever added; readers ignore what they do not know and skip a
 * line that does not parse (a torn last line after a crash).
 */

import { join } from "node:path";
import type { InboxLine, InboxRecordKind } from "@plannotator/core/inbox-types";

export const INBOX_DIR_NAME = "inbox";
export const INBOX_PROJECTS_DIR = "projects";
export const PROJECT_FILE = "project.json";
export const MESSAGES_FILE = "messages.jsonl";
export const QUESTIONS_FILE = "questions.jsonl";

export function inboxDir(dataDir: string): string {
  return join(dataDir, INBOX_DIR_NAME);
}

const KINDS: ReadonlySet<InboxRecordKind> = new Set(["project", "message", "question"]);

/**
 * One line of a store file, or null when it is not a line this reader can
 * use: not JSON, no numeric `v`, no positive integer `seq`, an unknown kind, or
 * a record whose id is not the line's id.
 */
export function parseInboxLine(text: string): InboxLine | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  if (typeof line.v !== "number") return null;
  if (typeof line.seq !== "number" || !Number.isSafeInteger(line.seq) || line.seq < 1) return null;
  if (typeof line.at !== "string") return null;
  if (typeof line.kind !== "string" || !KINDS.has(line.kind as InboxRecordKind)) return null;
  if (typeof line.id !== "string" || !line.id) return null;
  const record = line.record;
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if ((record as Record<string, unknown>).id !== line.id) return null;
  return value as InboxLine;
}

/** An expected refusal from a store operation, with a stable snake_case code. */
export class InboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "InboxError";
  }
}
