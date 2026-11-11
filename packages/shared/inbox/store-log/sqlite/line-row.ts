/**
 * The door between the `events` table and the store: a stored row read back as a store line, checked with
 * Zod. The same checks today's JSONL reader makes (`parseInboxLine` in `../../schema.ts`): a numeric `v`, a
 * positive safe-integer `seq`, a string `at`, a known kind, a non-empty id, an object record whose id is the
 * line's. A row that fails is left out, as an unreadable JSONL line is.
 */
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

const record = z.looseObject({ id: z.string() });

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
  const parsed = record.safeParse(value);
  if (!parsed.success || parsed.data.id !== checked.data.subject_id) return null;
  const { seq, at, v, kind, subject_id } = checked.data;
  // The record as parsed, not Zod's copy: its keys keep the order they were written in.
  return { v, seq, at, kind, id: subject_id, record: value } as InboxLine;
}

/** The bytes the line takes as one JSONL line: what Settings → Storage counts per thread, whichever log keeps it. */
export function lineBytes(line: InboxLine): number {
  return Buffer.byteLength(JSON.stringify(line)) + 1;
}
