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
 * Sent: the sender loop sends each file to that computer's `uploads` route just before the write and puts their ids
 * there in `args.attachments` (`sendWithFiles`). Each id is saved on the entry as it comes (`sent_files`), so a retry
 * (a crash, a line that went down between a file and the write) sends no file again, and the write carries the same
 * ids under the same key: the other computer's door and store answer it once.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES, type InboxAttachment } from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { JsonLines } from "@plannotator/shared/inbox/devices";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { inboxUploadFromAttachment, readInboxUpload } from "@plannotator/shared/inbox/uploads";
import { classifyAnswer, INBOX_OUTBOX_DIR, type OutboxAnswer, type OutboxEntry } from "./inbox-outbox";

/** How long one file may take to reach the other computer. */
export const OUTBOX_FILE_SEND_MS = 60_000;

/** One held file: this Inbox's pending upload and the name it goes under. */
export interface OutboxFile {
  upload: string;
  name: string;
}

/**
 * The agent's files, read already by this Inbox's attachment rules, held here as pending uploads. Every file is
 * checked before any is held: one the other computer's `uploads` route would refuse refuses the send, in its words.
 */
export async function holdOutboxFiles(storeDir: string, files: readonly { attachment: InboxAttachment; name: string }[], at: string): Promise<OutboxFile[]> {
  for (const { attachment } of files) {
    if (attachment.size > INBOX_UPLOAD_MAX_BYTES) {
      throw new InboxError("upload_too_large", `Not attached: a file is at most ${INBOX_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`, { max_bytes: INBOX_UPLOAD_MAX_BYTES });
    }
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

export interface SendFilesDeps {
  storeDir: string;
  /** The other computer's name, for a refusal that has no words of its own. */
  machineName: string;
  /** One file to that computer's `uploads` route. Throws when it cannot be reached. */
  upload: (name: string, path: string) => Promise<Response>;
  /** The ids there so far, saved on the entry before the next request leaves. */
  note: (sent: string[]) => void;
  post: (body: Record<string, unknown>) => Promise<OutboxAnswer>;
}

/**
 * One try of an entry: its files first, those not sent yet, then the write. An answer that is not a 2xx from a file's
 * upload is the entry's answer (a 4xx its refusal, a 5xx or no answer a retry). Ids kept from an earlier try that the
 * write is refused with (that computer forgot them while it was away a day) are sent again once.
 */
export async function sendWithFiles(entry: OutboxEntry, deps: SendFilesDeps): Promise<OutboxAnswer> {
  const files = entry.files ?? [];
  if (files.length === 0) return deps.post(entry.body);
  let sent = (entry.sent_files ?? []).slice(0, files.length);
  let reused = sent.length > 0;
  for (;;) {
    for (const file of files.slice(sent.length)) {
      const held = readInboxUpload(deps.storeDir, file.upload);
      const path = held ? inboxBlobPath(deps.storeDir, held.sha256) : null;
      if (!held || !path || !existsSync(path)) return { status: 422, body: { code: "upload_not_found", error: `${file.name} is no longer here.` } };
      let response: Response;
      try {
        response = await deps.upload(held.name, path);
      } catch {
        return null;
      }
      const answer = (await response.json().catch(() => ({}))) as { upload?: { upload_id?: unknown }; code?: unknown; error?: unknown };
      const id = answer?.upload?.upload_id;
      if (!response.ok || typeof id !== "string") {
        const words = { code: typeof answer?.code === "string" ? answer.code : "upload_failed", error: typeof answer?.error === "string" ? answer.error : `${file.name} could not be sent to ${deps.machineName}.` };
        // A 2xx without an id is that computer's refusal of the file, never a retry that could go on for ever.
        return { status: response.ok ? 422 : response.status, body: response.status === 401 ? answer : words };
      }
      sent = [...sent, id];
      deps.note(sent);
    }
    const answer = await deps.post(withAttachments(entry.body, sent));
    if (!reused || classifyAnswer(answer) !== "refused") return answer;
    reused = false;
    sent = [];
    deps.note(sent);
  }
}
