/**
 * On-disk layout under `inbox/`: `inbox.json` (registry), `projects/<key>/{project.json,messages.jsonl,questions.jsonl,decisions.jsonl,annotations.jsonl,cards.jsonl,steps.jsonl}`, `initiatives.jsonl`, `blobs/<sha256>`, `seq.json`.
 * `project.json` holds snapshots, the last wins. `decisions.jsonl` is an older store's: never applied, only its highest seq counts. `cards`, `steps` and `initiatives` are never read by routing, the list or notifications. `seq.json` keeps the highest seq across a deletion, so seq never repeats.
 * Every line is `{ v, seq, at, kind, id, record }`, a full snapshot; the last line per id is current. Readers ignore unknown fields and skip a line that does not parse (a torn last line).
 */

import { join } from "node:path";
import type { InboxLine, InboxRecordKind } from "@plannotator/core/inbox-types";

export const INBOX_DIR_NAME = "inbox";
export const INBOX_PROJECTS_DIR = "projects";
export const PROJECT_FILE = "project.json";
export const MESSAGES_FILE = "messages.jsonl";
export const QUESTIONS_FILE = "questions.jsonl";
export const LEGACY_DECISIONS_FILE = "decisions.jsonl";
export const ANNOTATIONS_FILE = "annotations.jsonl";
export const CARDS_FILE = "cards.jsonl";
export const STEPS_FILE = "steps.jsonl";
export const PULLS_FILE = "pulls.jsonl";
/** One file for every project (an initiative crosses projects), on the store's one seq counter. */
export const INITIATIVES_FILE = "initiatives.jsonl";
export const SEQ_FLOOR_FILE = "seq.json";

export function inboxDir(dataDir: string): string {
  return join(dataDir, INBOX_DIR_NAME);
}

const KINDS: ReadonlySet<InboxRecordKind> = new Set(["project", "message", "question", "annotation", "card", "steps", "initiative", "thread_pull"]);

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
