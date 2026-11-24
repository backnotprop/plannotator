/**
 * The files of an agent's answer held for another computer (inbox-mcp-far-reply.ts), and how they go there.
 *
 * An answer in a linked computer's thread may carry files, and it waits for that computer the way words do. The
 * outbox file holds no bytes: the entry names this Inbox's own pending uploads (`OutboxEntry.files`), the same records
 * a window's reply keeps before Send (`uploads/pending/<upl_…>.json`), each naming its blob (`blobs/<sha256>`), a
 * copy taken when the agent sent it, so the agent's own files may change or go afterwards. They are made with the
 * checks the other computer's `uploads` route applies (its name rules and INBOX_UPLOAD_MAX_BYTES), so a file it would
 * refuse is refused to the agent at once, not when that computer is back.
 *
 * Kept: a pending upload's blob is never taken by the store's blob sweep after a deletion (`pendingInboxUploadBlobs`),
 * and the upload sweep keeps every one an entry still needs (`outboxHeldUploadsOnDisk`, passed to it as
 * `keepUploads`): while it waits, and while it is a notice nobody dismissed. After that the upload sweep (hourly)
 * forgets it once it is a day old, and removes its blob when nothing else uses it.
 *
 * Sent: the files go up in their own lane (inbox-outbox-file-lane.ts), outside the write queue, so nothing the person
 * does waits on a file. Each id is saved on the entry as it comes (`sent_files`); once all are there the write takes
 * its place in the queue and carries those ids in `args.attachments` (`sendWithFiles`), under its own key: the other
 * computer's door and store answer it once.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { inboxAttachmentNameRefusal, INBOX_UPLOAD_MAX_BYTES, type InboxAttachment } from "@plannotator/core/inbox-types";
import { JsonLines } from "@plannotator/shared/inbox/devices";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { inboxUploadFromAttachment, inboxUploadNameRefusal } from "@plannotator/shared/inbox/uploads";
import { classifyAnswer, INBOX_OUTBOX_DIR, type OutboxAnswer, type OutboxEntry } from "./inbox-outbox";

/** One held file: this Inbox's pending upload and the name it goes under. */
export interface OutboxFile {
  upload: string;
  name: string;
}

/** A file past the size the other computer's `uploads` route takes, in its words. */
export const outboxFileTooLarge = () =>
  new InboxError("upload_too_large", `Not attached: a file is at most ${INBOX_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`, { max_bytes: INBOX_UPLOAD_MAX_BYTES });

/**
 * Before any file is read or copied: each one past the size the other computer's `uploads` route takes, or under a
 * name it refuses, refuses the send, so a refused file leaves nothing in this Inbox's blobs or pending uploads. A path
 * that cannot be read is left to the attachment rules, which refuse it in their own words. `name` null: the file's own.
 * A file that grows after this is cut off by the copy itself (`maxBytes` of the attachment rules).
 */
export function checkOutboxFiles(files: readonly { path: string; name: string | null }[], base: string): void {
  for (const file of files) {
    const named = isAbsolute(file.path) ? resolve(file.path) : resolve(base, file.path);
    let size: number | null = null;
    try {
      const stat = statSync(named);
      if (stat.isFile()) size = stat.size;
    } catch {
      // The attachment rules say why.
    }
    if (size !== null && size > INBOX_UPLOAD_MAX_BYTES) throw outboxFileTooLarge();
    // A file's own dotenv name is the attachment rules' to refuse, in their words, before they copy anything.
    if (size === null || (file.name === null && inboxAttachmentNameRefusal(named))) continue;
    const refusal = inboxUploadNameRefusal(file.name ?? basename(named));
    if (refusal) throw new InboxError("upload_refused", refusal, { field: "name" });
  }
}

/**
 * The agent's files, read already by this Inbox's attachment rules, held here as pending uploads. Every file is
 * checked before any is held: one the other computer's `uploads` route would refuse refuses the send, in its words.
 */
export async function holdOutboxFiles(storeDir: string, files: readonly { attachment: InboxAttachment; name: string }[], at: string): Promise<OutboxFile[]> {
  for (const { attachment, name } of files) {
    if (attachment.size > INBOX_UPLOAD_MAX_BYTES) throw outboxFileTooLarge();
    const refusal = inboxUploadNameRefusal(name);
    if (refusal) throw new InboxError("upload_refused", refusal, { field: "name" });
  }
  const held: OutboxFile[] = [];
  // The name rules are inboxUploadFromAttachment's own, the ones the other computer's route applies.
  for (const { attachment, name } of files) held.push({ upload: (await inboxUploadFromAttachment(storeDir, { ...attachment, name }, "sent", { at })).upload_id, name });
  return held;
}

/** Whether an entry still needs its files: it waits, or it is a notice nobody dismissed. */
const needsFiles = (entry: OutboxEntry) => entry.state === "queued" || entry.state === "sending" || (entry.notice !== null && !entry.dismissed);

/** The pending uploads the upload sweep keeps: every held file an entry still needs. */
export function outboxHeldUploads(entries: Iterable<OutboxEntry>): string[] {
  const ids: string[] = [];
  for (const entry of entries) if (entry.files && needsFiles(entry)) for (const file of entry.files) ids.push(file.upload);
  return ids;
}

/**
 * The same, read from the outbox's files on disk (the last line per key wins), never written. The upload sweep asks
 * this, so a held file is kept from the Inbox's first sweep at start, before its linked machines are made.
 */
export function outboxHeldUploadsOnDisk(dataDir: string): string[] {
  const dir = join(inboxDir(dataDir), INBOX_OUTBOX_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries = new Map<string, OutboxEntry>();
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of new JsonLines<OutboxEntry>(join(dir, name)).read()) {
      if (line && typeof line === "object" && typeof line.key === "string" && typeof line.state === "string") entries.set(line.key, line);
    }
  }
  return outboxHeldUploads(entries.values());
}

/** The write as it is sent, its files named by their ids there. */
function withAttachments(body: Record<string, unknown>, ids: readonly string[]): Record<string, unknown> {
  const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
  return { ...body, args: { ...args, attachments: [...ids] } };
}

/**
 * Whether that computer refused the write for its files' ids, not for anything else (the thread deleted there, a
 * step it refuses): its send_message names an attachment it has no upload for (`attachments[i]`, as after its upload
 * sweep took them while it was away a day), or says an upload is gone.
 */
export function refusedForFiles(answer: OutboxAnswer): boolean {
  if (!answer || classifyAnswer(answer) !== "refused") return false;
  const body = answer.body && typeof answer.body === "object" ? (answer.body as { field?: unknown; code?: unknown }) : {};
  return (typeof body.field === "string" && /^attachments(\[\d+\])?$/.test(body.field)) || body.code === "upload_not_found";
}

/**
 * One file's key at that computer's door (its `uploads` route takes a file only under one): the same for every try,
 * so a file that landed before this Inbox could save its id is answered with that id, never taken twice; a new one
 * (`files_try`) after a stall, so a retry never waits behind a stuck upload there under the old key, and once that
 * computer forgot the ids.
 */
export const outboxFileKey = (entry: OutboxEntry, attempt: number, index: number) => `${entry.key}:files${attempt}:${index}`;

/**
 * The write queue's try of an entry: its body, and for a held answer its files' ids there (all up by now: the queue
 * passes it by until they are). Refused for those ids (that computer forgot them), its files go again once
 * (`forgot` true): the entry waits for them again and is not settled by this answer.
 */
export async function sendWithFiles(entry: OutboxEntry, deps: { post: (body: Record<string, unknown>) => Promise<OutboxAnswer>; forgot: () => boolean }): Promise<OutboxAnswer> {
  if (!entry.files || entry.files.length === 0) return deps.post(entry.body);
  const answer = await deps.post(withAttachments(entry.body, entry.sent_files ?? []));
  if (refusedForFiles(answer)) deps.forgot();
  return answer;
}
