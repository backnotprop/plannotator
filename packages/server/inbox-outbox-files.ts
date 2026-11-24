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
 * ids under the same key: the other computer's door and store answer it once. Each file goes under its own key at
 * that door (`outboxFileKey`), so one that landed before its id was saved is answered with that id, not taken again.
 * A file ends only when no byte moves (OUTBOX_FILE_IDLE_MS), and one that stalls or fails is a server error for its
 * entry: the person's writes behind it go, and after the outbox's tries it is a notice.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { inboxAttachmentNameRefusal, INBOX_UPLOAD_MAX_BYTES, type InboxAttachment } from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { JsonLines } from "@plannotator/shared/inbox/devices";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { inboxUploadFromAttachment, inboxUploadNameRefusal, readInboxUpload } from "@plannotator/shared/inbox/uploads";
import { classifyAnswer, INBOX_OUTBOX_DIR, type OutboxAnswer, type OutboxEntry } from "./inbox-outbox";

/**
 * How long one file's upload may go with no byte moving (and, once its bytes are all sent, with no answer). A slow
 * file that keeps moving takes as long as it takes; one that stops is a failed try (`sendWithFiles`).
 */
export const OUTBOX_FILE_IDLE_MS = 30_000;
/** A file goes in pieces of at most this, so each piece taken by the line counts as progress. */
const FILE_PIECE_BYTES = 64 * 1024;

/** One held file: this Inbox's pending upload and the name it goes under. */
export interface OutboxFile {
  upload: string;
  name: string;
}

const tooLarge = () => new InboxError("upload_too_large", `Not attached: a file is at most ${INBOX_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`, { max_bytes: INBOX_UPLOAD_MAX_BYTES });

/**
 * Before any file is read or copied: each one past the size the other computer's `uploads` route takes, or under a
 * name it refuses, refuses the send, so a refused file leaves nothing in this Inbox's blobs or pending uploads. A path
 * that cannot be read is left to the attachment rules, which refuse it in their own words. `name` null: the file's own.
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
    if (size !== null && size > INBOX_UPLOAD_MAX_BYTES) throw tooLarge();
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
    if (attachment.size > INBOX_UPLOAD_MAX_BYTES) throw tooLarge();
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
 * so a file that landed before this Inbox could save its id is answered with that id, never taken twice; a new one only
 * once that computer forgot the ids (`files_try`).
 */
export const outboxFileKey = (entry: OutboxEntry, attempt: number, index: number) => `${entry.key}:files${attempt}:${index}`;

export interface SendFilesDeps {
  storeDir: string;
  /** The other computer's name, for a refusal that has no words of its own. */
  machineName: string;
  /** One file to that computer's `uploads` route under its key, `size` bytes streamed from `body`. Throws when it cannot be reached or `signal` aborts. */
  upload: (file: { name: string; key: string; body: ReadableStream<Uint8Array>; size: number; signal: AbortSignal }) => Promise<Response>;
  /** How long a file may go with no byte moving (OUTBOX_FILE_IDLE_MS). */
  idleMs: number;
  /** The ids there so far and which try of the files they are, saved on the entry before the next request leaves. */
  note: (sent: string[], attempt: number) => void;
  post: (body: Record<string, unknown>) => Promise<OutboxAnswer>;
}

type UploadAnswer = { upload?: { upload_id?: unknown }; code?: unknown; error?: unknown };

/** One file's upload, ended when no byte moves for `idleMs`: its status and answer, or null when it stalled or failed. */
async function uploadFile(deps: SendFilesDeps, name: string, key: string, path: string): Promise<{ response: Response; answer: UploadAnswer } | null> {
  const file = Bun.file(path);
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const moved = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop.abort(), deps.idleMs);
  };
  const reader = file.stream().getReader();
  let rest = new Uint8Array(0);
  // Pulled only as the line takes the bytes (nothing read ahead), in pieces, so each pull is progress.
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (rest.length === 0) {
          const next = await reader.read();
          if (next.done) return controller.close();
          rest = next.value;
        }
        const piece = rest.subarray(0, FILE_PIECE_BYTES);
        rest = rest.subarray(piece.length);
        moved();
        controller.enqueue(piece);
      },
      cancel: (reason) => reader.cancel(reason).catch(() => {}),
    },
    { highWaterMark: 0 },
  );
  moved();
  try {
    const response = await deps.upload({ name, key, body, size: file.size, signal: stop.signal });
    const text = await response.text();
    if (stop.signal.aborted) return null;
    let answer: UploadAnswer = {};
    try {
      answer = (JSON.parse(text) ?? {}) as UploadAnswer;
    } catch {
      // Not JSON: no id, so its status says what it was.
    }
    return { response, answer };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // The file's handle closed, however the request ended.
    void reader.cancel().catch(() => {});
  }
}

/**
 * One try of an entry: its files first, those not sent yet, then the write. A file's upload that is not a 2xx is the
 * entry's answer: a 4xx its refusal; a 5xx, or one that stalled (no byte moving for `idleMs`) or failed, a server
 * error marked `unsent` (nothing of the write reached that computer), so this Inbox's own write yields to the person's
 * and, after OUTBOX_MAX_SERVER_ERRORS tries, ends refused (a notice), never parked as maybe delivered. Ids the write is
 * refused for (`refusedForFiles`: that computer forgot them) are sent again once, under new keys.
 */
export async function sendWithFiles(entry: OutboxEntry, deps: SendFilesDeps): Promise<OutboxAnswer> {
  const files = entry.files ?? [];
  if (files.length === 0) return deps.post(entry.body);
  let attempt = entry.files_try ?? 0;
  let sent = (entry.sent_files ?? []).slice(0, files.length);
  let again = true;
  for (;;) {
    for (const [index, file] of files.entries()) {
      if (index < sent.length) continue;
      const held = readInboxUpload(deps.storeDir, file.upload);
      const path = held ? inboxBlobPath(deps.storeDir, held.sha256) : null;
      if (!held || !path || !existsSync(path)) return { status: 422, body: { code: "upload_not_found", error: `${file.name} is no longer here.` } };
      const failed = { code: "upload_failed", error: `${file.name} could not be sent to ${deps.machineName}.` };
      const done = await uploadFile(deps, held.name, outboxFileKey(entry, attempt, index), path);
      if (!done) return { status: 500, body: failed, unsent: true };
      const { response, answer } = done;
      const id = answer.upload?.upload_id;
      if (!response.ok || typeof id !== "string") {
        if (response.status === 401) return { status: 401, body: answer };
        const words = { code: typeof answer.code === "string" ? answer.code : failed.code, error: typeof answer.error === "string" ? answer.error : failed.error };
        // A 2xx without an id is that computer's refusal of the file, never a retry that could go on for ever.
        return { status: response.ok ? 422 : response.status, body: words, ...(response.status >= 500 ? { unsent: true as const } : {}) };
      }
      sent = [...sent, id];
      deps.note(sent, attempt);
    }
    const answer = await deps.post(withAttachments(entry.body, sent));
    if (!again || !refusedForFiles(answer)) return answer;
    again = false;
    attempt += 1;
    sent = [];
    deps.note(sent, attempt);
  }
}
