/**
 * Plannotator Inbox: reply drafts, the words the person typed in a thread's
 * reply box and did not send (approval "inbox-reply-drafts").
 *
 *   inbox/reply-drafts/<thread id>.json   one per thread, 0600, written whole (temp, then rename)
 *
 * Files, not the store's JSONL, for the reasons compose drafts are
 * (drafts.ts): a draft changes on every pause in typing, and it must never
 * enter the event log, which the window's stream, read_thread's cursor,
 * the phone relay and search read. So agents and the MCP never see it.
 *
 * A save is a compare-and-set on `updated_at`: `base` is the `updated_at` the
 * writer last read (null to create), and a draft another tab changed since is
 * `409 draft_conflict` with the newer draft. A save may also name `base_body`,
 * the words that window saved last: a draft still holding them is the window's
 * own (a save sent as the page goes, before an earlier save answered). Saving
 * an empty body deletes it. The Send that carries the words clears the draft
 * only while it is still the one they were saved as (its `updated_at`).
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId, type InboxReplyDraft } from "@plannotator/core/inbox-types";
import { INBOX_DRAFT_BODY_MAX } from "./drafts";
import { InboxError } from "./schema";

export const INBOX_REPLY_DRAFTS_DIR = "reply-drafts";

function dirOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_REPLY_DRAFTS_DIR);
}

function fileOf(inboxDirPath: string, threadId: string): string {
  return join(dirOf(inboxDirPath), `${threadId}.json`);
}

function parse(text: string): InboxReplyDraft | null {
  try {
    const value = JSON.parse(text) as InboxReplyDraft;
    if (!value || value.v !== 1 || !isInboxId("msg", value.thread_id)) return null;
    if (typeof value.body !== "string" || typeof value.updated_at !== "string" || typeof value.created_at !== "string") return null;
    return { v: 1, thread_id: value.thread_id, body: value.body, created_at: value.created_at, updated_at: value.updated_at };
  } catch {
    return null;
  }
}

/** Every reply draft on disk, by thread id (a file that does not parse is skipped). */
export function readInboxReplyDrafts(inboxDirPath: string): Map<string, InboxReplyDraft> {
  const out = new Map<string, InboxReplyDraft>();
  let names: string[];
  try {
    names = readdirSync(dirOf(inboxDirPath));
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const draft = parse(readFileSync(join(dirOf(inboxDirPath), name), "utf8"));
      if (draft && `${draft.thread_id}.json` === name) out.set(draft.thread_id, draft);
    } catch {
      // Unreadable: skipped.
    }
  }
  return out;
}

/** The checks on a save's input, before anything is written. */
export function checkInboxReplyDraftInput(input: { body?: unknown; base?: unknown; base_body?: unknown }): {
  body: string;
  base: string | null;
  baseBody: string | null;
} {
  const body = input.body === undefined ? "" : input.body;
  if (typeof body !== "string" || body.length > INBOX_DRAFT_BODY_MAX) {
    throw new InboxError("validation_error", `body: a string of at most ${INBOX_DRAFT_BODY_MAX} characters.`, { field: "body" });
  }
  const base = input.base === undefined ? null : input.base;
  if (base !== null && typeof base !== "string") throw new InboxError("validation_error", "base: the updated_at you read, or null to create.", { field: "base" });
  const baseBody = input.base_body === undefined ? null : input.base_body;
  if (baseBody !== null && (typeof baseBody !== "string" || baseBody.length > INBOX_DRAFT_BODY_MAX)) {
    throw new InboxError("validation_error", "base_body: the words this window saved last, or null.", { field: "base_body" });
  }
  return { body, base, baseBody };
}

/** Write one draft whole (owner-only folder and file). */
export function writeInboxReplyDraft(inboxDirPath: string, draft: InboxReplyDraft): void {
  mkdirSync(dirOf(inboxDirPath), { recursive: true, mode: 0o700 });
  const file = fileOf(inboxDirPath, draft.thread_id);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); // `mode` applies only on create: a left-over temp file keeps its old mode.
  renameSync(temp, file);
}

/** Remove one draft's file; true when there was one. */
export function removeInboxReplyDraft(inboxDirPath: string, threadId: string): boolean {
  try {
    unlinkSync(fileOf(inboxDirPath, threadId));
    return true;
  } catch {
    return false;
  }
}
