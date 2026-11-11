/** Reads an `events` row back as a store line with the checks `parseInboxLine` makes; a row that fails is left out. */
import { z } from "zod";
import type { InboxLine, InboxRecordKind } from "@plannotator/core/inbox-types";

export const INBOX_LINE_KINDS = ["project", "message", "question", "annotation", "card", "steps", "initiative", "thread_pull"] as const satisfies readonly InboxRecordKind[];

const eventRow = z.object({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: z.string(),
  v: z.number(),
  kind: z.enum(INBOX_LINE_KINDS),
  subject_id: z.string().min(1),
  data: z.string(),
});

/** One `events` row as the store line it was written from, or null when it does not read. */
export function lineOfRow(row: unknown): InboxLine | null {
  const checked = eventRow.safeParse(row);
  if (!checked.success) return null;
  let value: unknown;
  try {
    value = JSON.parse(checked.data.data);
  } catch {
    return null;
  }
  // Checked by hand: a Zod object check would copy the whole record on every start.
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { id?: unknown }).id !== checked.data.subject_id) return null;
  const { seq, at, v, kind, subject_id } = checked.data;
  // Not Zod's copy: keys keep their written order.
  return { v, seq, at, kind, id: subject_id, record: value } as InboxLine;
}

/** The bytes the line takes as one JSONL line, whichever log keeps it. */
export function lineBytes(line: InboxLine): number {
  return Buffer.byteLength(JSON.stringify(line)) + 1;
}
