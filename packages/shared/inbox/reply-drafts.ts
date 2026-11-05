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
 * an empty body with no files deletes it. The Send that carries the words clears the draft
 * only while it is still the one they were saved as (its `updated_at`).
 *
 * A draft keeps the box's files beside the words (`files`): every file the
 * person attached (paperclip, drop, paste), each a pending upload, and a long
 * paste (approval "inbox-paste-attachment") with where it goes back
 * (`pasted`). The window's save names its file changes (`files_add`,
 * `files_remove`, `files_place`), applied to the draft's files as they are
 * (`applyReplyDraftFileOps`, @plannotator/core/inbox-reply-draft); then the
 * compare-and-set is on the words alone. A save with a list instead: one that
 * says it carries every file (`all_files: true`) sets the list; an older page's
 * save (long pastes only) leaves the other files where they are, and its
 * `base_body` shortcut holds only while the draft also holds its `base_files`
 * (`replyDraftFilesAfterSave`).
 * The upload sweep keeps the uploads a reply draft names.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_REPLY_DRAFT_RECIPIENTS_MAX, INBOX_SESSION_ID_PATTERN, isInboxId, type InboxDraftFile, type InboxReplyDraft } from "@plannotator/core/inbox-types";
import { checkInboxDraftFiles, checkInboxDraftIds, checkInboxDraftPlaces, INBOX_DRAFT_BODY_MAX } from "./drafts";
import type { ReplyDraftFileOps } from "@plannotator/core/inbox-reply-draft";
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
    // Every file the box held; a long paste also names its place (an Inbox of 0.28.46 or earlier kept only those).
    const files = Array.isArray(value.files)
      ? value.files.filter((file) => file && typeof file.upload_id === "string" && (file.pasted === undefined || (!!file.pasted && typeof file.pasted.at === "number")))
      : [];
    // Who the reply goes to (the recipient pill): kept only when well formed.
    const recipients = recipientList(value.recipients);
    return {
      v: 1,
      thread_id: value.thread_id,
      body: value.body,
      created_at: value.created_at,
      updated_at: value.updated_at,
      ...(files.length > 0 ? { files } : {}),
      ...(recipients && recipients.length > 0 ? { recipients } : {}),
    };
  } catch {
    return null;
  }
}

/** A list of recipient session ids, or null when it is not one (too many, not session ids as a tag names them, repeats). */
function recipientList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > INBOX_REPLY_DRAFT_RECIPIENTS_MAX) return null;
  if (value.some((id) => typeof id !== "string" || !INBOX_SESSION_ID_PATTERN.test(id))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...(value as string[])];
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

/** The upload ids a reply draft names, in order (its long pastes). */
export function inboxReplyDraftFileIds(draft: Pick<InboxReplyDraft, "files"> | null | undefined): string[] {
  return (draft?.files ?? []).map((file) => file.upload_id);
}

/** Two lists of upload ids hold the same files in the same order. */
export function sameInboxUploadIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The checks on a save's input, before anything is written. `files`: the files
 * kept beside the words (each an upload id, or `{ upload_id, pasted }` for a
 * long paste; an upload still pending); `all_files: true`: they are every file
 * the box holds (absent: an older page's long pastes only); `base_files`: the
 * upload ids this window saved last, which `base_body`'s shortcut must also
 * match (absent: words only, as an older window sends).
 */
export function checkInboxReplyDraftInput(
  inboxDirPath: string,
  input: InboxReplyDraftInput,
): {
  body: string;
  base: string | null;
  baseBody: string | null;
  files: InboxDraftFile[];
  baseFiles: string[] | null;
  allFiles: boolean;
  /** The file changes this save makes (an Inbox page that sends them), applied to the draft's files as they are. */
  ops: ReplyDraftFileOps<InboxDraftFile> | null;
  /** Who the reply goes to (the recipient pill); null: not sent, the draft keeps its own. */
  recipients: string[] | null;
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
  const listedBase = input.base_files === undefined || input.base_files === null ? null : input.base_files;
  if (listedBase !== null && (!Array.isArray(listedBase) || listedBase.some((id) => typeof id !== "string"))) {
    throw new InboxError("validation_error", "base_files: the upload ids this window saved last, or null.", { field: "base_files" });
  }
  const files = checkInboxDraftFiles(inboxDirPath, input.files, body.length);
  const opsGiven = input.files_add !== undefined || input.files_remove !== undefined || input.files_place !== undefined;
  const ops = opsGiven
    ? {
        // A file sent or swept since is not added: the save never fails for it (no retry, no loop).
        add: checkInboxDraftFiles(inboxDirPath, input.files_add, body.length, { list: "files_add", skipGone: true }),
        remove: checkInboxDraftIds(input.files_remove, "files_remove"),
        place: checkInboxDraftPlaces(input.files_place, body.length, "files_place"),
      }
    : null;
  const recipients = input.recipients === undefined || input.recipients === null ? null : recipientList(input.recipients);
  if (input.recipients !== undefined && input.recipients !== null && recipients === null) {
    throw new InboxError("validation_error", `recipients: at most ${INBOX_REPLY_DRAFT_RECIPIENTS_MAX} session ids (letters, digits, . _ : -), each once.`, { field: "recipients" });
  }
  return { body, base, baseBody, files, baseFiles: listedBase as string[] | null, allFiles: input.all_files === true, ops, recipients };
}

/** What a reply draft save may carry (`POST /api/inbox/threads/:id/draft`). */
export interface InboxReplyDraftInput {
  body?: unknown;
  base?: unknown;
  base_body?: unknown;
  files?: unknown;
  base_files?: unknown;
  all_files?: unknown;
  files_add?: unknown;
  files_remove?: unknown;
  files_place?: unknown;
  /** Who the reply goes to: session ids (the recipient pill); absent, the draft keeps its own. */
  recipients?: unknown;
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
