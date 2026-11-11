/**
 * Files the person uploads from the window (compose, or pasted into the reply box): `inbox/uploads/pending/<upl_id>.json` (not sent yet; a draft may name it), `inbox/uploads/<att_id>/<name>` (sent: a read-only copy of its blob), `inbox/blobs/<sha256>`.
 * At send each upload becomes a real file with its real name (a copy of the blob, a clone where the filesystem has them, never a hard link), read-only so it reads as the version sent.
 * Names are plain (no path separator or control character, at most 255 bytes) outside the dotenv family; the body is streamed, never held whole, at most INBOX_UPLOAD_MAX_BYTES (under the 128 MiB request bound; no chunked protocol). An upload no draft names is swept after INBOX_UPLOAD_KEEP_MS.
 */

import { INBOX_ROWS_ASK_BLOCK } from "@plannotator/core/inbox-types";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { copyFile, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  inboxAttachmentId,
  inboxAttachmentNameRefusal,
  inboxBoardRequestBlock,
  INBOX_DECISION_ASK_BLOCK,
  inboxId,
  INBOX_UPLOAD_MAX_BYTES,
  isInboxId,
  THREAD_NAME_BIDI,
  THREAD_NAME_CONTROL,
  type InboxAttachment,
  type InboxReplyViewing,
  type InboxUpload,
} from "@plannotator/core/inbox-types";
import { cutText } from "@plannotator/core/inbox-questions";
import { decideInboxAttachmentKind, inboxAttachmentCurrentInfo, inboxBlobPath, inboxBlobsDir, openInboxAttachmentVersion, scanInboxFile } from "./attachments";
import { InboxError } from "./schema";

export const INBOX_UPLOADS_DIR = "uploads";

const PASTED_TEXT_NAME = /^pasted-text-[^/\\]+\.txt$/;

export function inboxAttachedLines(message: { attachments?: readonly InboxAttachment[] | null }): string {
  return (message.attachments ?? []).map((attachment) => `Attached: ${attachment.name} (${attachment.path})`).join("\n");
}

const VIEWING_NAME_MAX = 120;
const VIEWING_TIME_MAX = 24;
export const INBOX_VIEWING_TIME = /^(?:[A-Z][a-z]{2} \d{1,2}, (?:\d{4}, )?)?\d{1,2}:\d{2} [AP]M$/;

/** Text anyone can write going into an agent's prompt: one line, no controls or invisible format characters, no backtick to close the quote around it, a sane length. */
export function inboxViewingText(text: string, max = VIEWING_NAME_MAX): string {
  const line = text
    .replace(/\p{Cf}/gu, "")
    .replace(new RegExp(THREAD_NAME_CONTROL.source, "g"), " ")
    .replace(/\s+/g, " ")
    .replace(/`/g, "'")
    .trim();
  return cutText(line, max);
}

/** The one line an agent reads for a reply sent from full screen's floating box: what was on screen. Never a pick, an annotation or an answer. */
export function inboxViewingLine(message: { viewing?: InboxReplyViewing | null }): string {
  const viewing = message.viewing;
  // A record of another shape (a newer Inbox wrote it) must not take the session's poll or read_thread down with it.
  if (!viewing || typeof viewing.name !== "string" || typeof viewing.message_id !== "string") return "";
  const name = inboxViewingText(viewing.name) || "a file";
  const page = typeof viewing.page === "string" ? inboxViewingText(viewing.page) : "";
  const time = typeof viewing.time === "string" ? inboxViewingText(viewing.time, VIEWING_TIME_MAX) : "";
  const from = `the ${time ? `${time} ` : ""}message ${inboxViewingText(viewing.message_id)}`;
  const what = page ? `\`${page}\`, linked from \`${name}\` in ${from}` : `\`${name}\`${viewing.as_sent ? " as first sent" : ""}, from ${from}`;
  return `(They sent this while viewing ${what}.)`;
}

export function inboxBodyForAgent(message: {
  body: string;
  thread_id?: string;
  attachments?: readonly InboxAttachment[] | null;
  board_request?: true;
  decision_ask?: true;
  rows_ask?: true;
  viewing?: InboxReplyViewing | null;
}): string {
  const after = [inboxViewingLine(message), inboxAttachedLines(message)].filter((part) => part !== "").join("\n\n");
  let words = !after ? message.body : message.body.trim() ? `${message.body}\n\n${after}` : after;
  if (message.board_request === true && message.thread_id) words = `${words}\n\n${inboxBoardRequestBlock(message.thread_id)}`;
  if (message.decision_ask === true) words = `${words}\n\n${INBOX_DECISION_ASK_BLOCK}`;
  if (message.rows_ask === true) words = `${words}\n\n${INBOX_ROWS_ASK_BLOCK}`;
  return words;
}
const PENDING_DIR = "pending";
export { INBOX_UPLOAD_MAX_BYTES };
export const INBOX_UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;
export const INBOX_UPLOAD_NAME_MAX_BYTES = 255;
const ATTACHMENT_DIR_RE = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
const UPLOAD_TEMP_RE = /^\.upload\..*\.tmp$/;
/** How a thread's listing names a big changed file it did not read: `stat:<size>:<mtimeMs>` (`hash: "small"`). */
const INBOX_STAT_HASH_RE = /^stat:\d+:\d+(\.\d+)?$/;

function uploadsDir(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_UPLOADS_DIR);
}

function pendingDir(inboxDirPath: string): string {
  return join(uploadsDir(inboxDirPath), PENDING_DIR);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function inboxUploadNameRefusal(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return "A file needs a name.";
  if (name === "." || name === "..") return "Not a file name.";
  if (/[/\\]/.test(name)) return "A file name cannot hold a path separator.";
  if (THREAD_NAME_CONTROL.test(name)) return "A file name cannot hold control characters or line breaks.";
  if (THREAD_NAME_BIDI.test(name)) return "A file name cannot hold bidirectional control characters.";
  if (Buffer.byteLength(name, "utf8") > INBOX_UPLOAD_NAME_MAX_BYTES) return `A file name is at most ${INBOX_UPLOAD_NAME_MAX_BYTES} bytes.`;
  const dotenv = inboxAttachmentNameRefusal(name);
  if (dotenv) return "Not attached: .env files often hold secrets.";
  return null;
}

function parseUpload(text: string): InboxUpload | null {
  try {
    const value = JSON.parse(text) as InboxUpload;
    if (!value || !isInboxId("upl", value.upload_id) || typeof value.name !== "string" || typeof value.sha256 !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export function readInboxUpload(inboxDirPath: string, id: unknown): InboxUpload | null {
  if (!isInboxId("upl", id)) return null;
  try {
    return parseUpload(readFileSync(join(pendingDir(inboxDirPath), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** The words of one pending pasted-text upload, so Put back works after a reload or in another window. Null when the id is not a pending pasted text or its bytes are gone. */
export function readInboxUploadText(inboxDirPath: string, id: unknown): string | null {
  const upload = readInboxUpload(inboxDirPath, id);
  if (!upload || upload.kind !== "text" || !PASTED_TEXT_NAME.test(upload.name)) return null;
  try {
    return readFileSync(inboxBlobPath(inboxDirPath, upload.sha256), "utf8");
  } catch {
    return null;
  }
}

export function listInboxUploads(inboxDirPath: string): InboxUpload[] {
  let names: string[];
  try {
    names = readdirSync(pendingDir(inboxDirPath));
  } catch {
    return [];
  }
  const out: InboxUpload[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const upload = readInboxUpload(inboxDirPath, name.slice(0, -5));
    if (upload) out.push(upload);
  }
  return out;
}

export function pendingInboxUploadBlobs(inboxDirPath: string): Set<string> {
  return new Set(listInboxUploads(inboxDirPath).map((upload) => upload.sha256));
}

function recordPendingUpload(inboxDirPath: string, upload: InboxUpload): void {
  try {
    const dir = pendingDir(inboxDirPath);
    ensureDir(dir);
    const file = join(dir, `${upload.upload_id}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(upload)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    throw inboxDiskFullError(error, INBOX_FILE_NOT_ADDED) ?? error;
  }
}

const INBOX_FILE_NOT_ADDED = "The disk is full, so the file could not be added. Free some space and try again.";

export function inboxDiskFullError(error: unknown, words = "The disk is full, so that could not be saved. Free some space and try again."): InboxError | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? new InboxError("upload_no_space", words) : null;
}

/** The body is streamed to a temp file in the blob store (never held whole), refused past INBOX_UPLOAD_MAX_BYTES, then hashed, renamed to `blobs/<sha256>` and recorded as pending. Nothing is kept when anything fails, an abort included. */
export async function receiveInboxUpload(
  inboxDirPath: string,
  name: unknown,
  body: ReadableStream<Uint8Array> | null,
  options: { at: string; maxBytes?: number; shownSha256?: string },
): Promise<InboxUpload> {
  const refusal = inboxUploadNameRefusal(name);
  if (refusal) throw new InboxError("upload_refused", refusal, { field: "name" });
  if (!body) throw new InboxError("validation_error", "body: the file's bytes are required.", { field: "body" });
  const max = options.maxBytes ?? INBOX_UPLOAD_MAX_BYTES;
  const blobs = inboxBlobsDir(inboxDirPath);
  ensureDir(blobs);
  const temp = join(blobs, `.upload.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`);
  let out: FileHandle | null = null;
  let size = 0;
  try {
    out = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new InboxError("upload_too_large", `Not attached: a file is at most ${Math.round(max / (1024 * 1024))} MB.`, { max_bytes: max });
      }
      let written = 0;
      while (written < value.length) written += (await out.write(value, written, value.length - written)).bytesWritten;
    }
    await out.close();
    out = null;
    const scan = await scanInboxFile(temp);
    const path = inboxBlobPath(inboxDirPath, scan.sha256);
    if (existsSync(path)) unlinkSync(temp);
    else renameSync(temp, path);
    const decided = decideInboxAttachmentKind(name as string, scan.head, scan.text, scan.size);
    const upload: InboxUpload = {
      upload_id: inboxId("upl"),
      name: name as string,
      size: scan.size,
      kind: decided.kind,
      sha256: scan.sha256,
      created_at: options.at,
      ...(decided.media_type ? { media_type: decided.media_type } : {}),
      ...(decided.width !== undefined && decided.height !== undefined ? { width: decided.width, height: decided.height } : {}),
      ...(options.shownSha256 ? { shown_sha256: options.shownSha256 } : {}),
    };
    recordPendingUpload(inboxDirPath, upload);
    return upload;
  } catch (error) {
    if (out) await out.close().catch(() => {});
    try {
      unlinkSync(temp);
    } catch {
      // Renamed, or never written.
    }
    if (error instanceof InboxError) throw error;
    throw inboxDiskFullError(error, INBOX_FILE_NOT_ADDED) ?? new InboxError("upload_refused", "The file could not be received; try again.", { field: "body" });
  }
}

function streamOfFile(handle: FileHandle): ReadableStream<Uint8Array> {
  let position = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return controller.close();
      position += bytesRead;
      controller.enqueue(buffer.subarray(0, bytesRead));
    },
  });
}

/**
 * A pending upload naming the blob a file already has, so no bytes are written; it keeps no thread, message or path of where it came from. A changed agent file with no blob yet comes in once through the upload door, and the version is fixed then.
 * `sha256` is the version the page showed: a stale tab gets those bytes or a refusal, never newer bytes under the same tile. A big changed file is listed by its stat, so only a real hash is held to this.
 */
export async function inboxUploadFromAttachment(
  inboxDirPath: string,
  attachment: InboxAttachment,
  version: "current" | "sent",
  options: { at: string; sha256?: string },
): Promise<InboxUpload> {
  const refusal = inboxUploadNameRefusal(attachment.name);
  if (refusal) throw new InboxError("upload_refused", refusal, { field: "name" });
  const shown = options.sha256 && /^[0-9a-f]{64}$/.test(options.sha256) ? options.sha256 : null;
  if (version === "current" && shown !== attachment.sent_sha256) {
    const info = await inboxAttachmentCurrentInfo(attachment);
    if (!info.ok) throw new InboxError("upload_not_found", `${info.unavailable.message} Add the version it sent.`);
    if (shown && info.sha256 !== shown) throw new InboxError("upload_not_found", `${attachment.name} changed since this page showed it. Look at it again, then add it.`);
    if (info.sha256 !== attachment.sent_sha256) {
      const opened = await openInboxAttachmentVersion(inboxDirPath, attachment, "current", { hash: "none" });
      if (!opened.ok) throw new InboxError("upload_not_found", opened.message);
      try {
        return await receiveInboxUpload(inboxDirPath, attachment.name, streamOfFile(opened.handle), { at: options.at, maxBytes: Number.MAX_SAFE_INTEGER, ...(options.sha256 && INBOX_STAT_HASH_RE.test(options.sha256) ? { shownSha256: options.sha256 } : {}) });
      } finally {
        await opened.handle.close().catch(() => {});
      }
    }
  }
  if (!existsSync(inboxBlobPath(inboxDirPath, attachment.sent_sha256))) {
    throw new InboxError("upload_not_found", `${attachment.name} is no longer here.`);
  }
  const upload: InboxUpload = {
    upload_id: inboxId("upl"),
    name: attachment.name,
    size: attachment.size,
    kind: attachment.kind,
    sha256: attachment.sent_sha256,
    created_at: options.at,
    ...(attachment.media_type ? { media_type: attachment.media_type } : {}),
    ...(attachment.width !== undefined && attachment.height !== undefined ? { width: attachment.width, height: attachment.height } : {}),
    ...(attachment.duration_ms !== undefined ? { duration_ms: attachment.duration_ms } : {}),
  };
  recordPendingUpload(inboxDirPath, upload);
  return upload;
}

/** Each blob is copied to `uploads/<att_id>/<name>` (a clone where available; read-only outside Windows), its realpath the record's path. A copy, never a hard link: an agent writing to its file must not change the stored blob. Every id is checked before anything is written. */
export async function inboxUploadAttachments(inboxDirPath: string, ids: readonly unknown[], at: string): Promise<InboxAttachment[]> {
  const uploads = ids.map((id, index) => {
    const upload = readInboxUpload(inboxDirPath, id);
    if (!upload || !existsSync(inboxBlobPath(inboxDirPath, upload.sha256))) {
      throw new InboxError("upload_not_found", `uploads[${index}]: that file is no longer here; attach it again.`, { field: `uploads[${index}]` });
    }
    return upload;
  });
  const made: string[] = [];
  const attachments: InboxAttachment[] = [];
  const blobsDir = inboxBlobsDir(inboxDirPath);
  let temp: string | null = null;
  try {
    for (const upload of uploads) {
      const id = inboxAttachmentId();
      const dir = join(uploadsDir(inboxDirPath), id);
      const target = join(dir, upload.name);
      const blob = inboxBlobPath(inboxDirPath, upload.sha256);
      // A clone where the disk has them, else a full copy. Never a hard link: the read-only mode stops no agent that
      // chmods the file and writes it in place, and with a link that write would change the blob and every other
      // message's copy of these bytes, in any project (uploads-reuse.test.ts).
      // Not the sync call: where a disk has no clones, a big file would stop the whole Inbox while it copies.
      // Under a temp name the upload sweep knows, so a crash mid-copy leaves nothing in uploads/, which no sweep reads.
      temp = join(blobsDir, `.upload.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`);
      await copyFile(blob, temp, constants.COPYFILE_FICLONE);
      // Read-only, so the file reads as the version sent. Not on Windows,
      // where a read-only file cannot be deleted by the sweep.
      if (process.platform !== "win32") {
        try {
          chmodSync(temp, 0o400);
        } catch {
          // Best effort (a filesystem without modes).
        }
      }
      ensureDir(dir);
      made.push(dir);
      renameSync(temp, target);
      temp = null;
      const real = realpathSync(target);
      attachments.push({
        id,
        path: real,
        named_path: null,
        name: upload.name,
        kind: upload.kind,
        sent_sha256: upload.sha256,
        size: upload.size,
        sent_at: at,
        sent_mtime: statSync(real).mtime.toISOString(),
        ...(upload.media_type ? { media_type: upload.media_type } : {}),
        ...(upload.width !== undefined && upload.height !== undefined ? { width: upload.width, height: upload.height } : {}),
        ...(upload.duration_ms !== undefined ? { duration_ms: upload.duration_ms } : {}),
      });
    }
    return attachments;
  } catch (error) {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
    if (temp) rmSync(temp, { force: true });
    if (error instanceof InboxError) throw error;
    throw inboxDiskFullError(error, "The disk is full, so the file could not be attached and nothing was sent. Free some space and send again.") ?? new InboxError("upload_not_found", "An uploaded file could not be attached; attach it again.");
  }
}

/**
 * Whether these uploads are still pending after their files were copied. A Send that took them while this one
 * copied has them, so this one refuses, as it would have had the copy not left the event loop.
 */
export function assertInboxUploadsPending(inboxDirPath: string, ids: readonly unknown[], attachments: readonly InboxAttachment[]): void {
  const gone = ids.findIndex((id) => !readInboxUpload(inboxDirPath, id));
  if (gone < 0) return;
  removeInboxAttachmentFiles(inboxDirPath, attachments);
  throw new InboxError("upload_not_found", `uploads[${gone}]: that file was just sent; attach it again.`, { field: `uploads[${gone}]` });
}

export function removeInboxAttachmentFiles(inboxDirPath: string, attachments: readonly InboxAttachment[]): void {
  for (const attachment of attachments) {
    if (!ATTACHMENT_DIR_RE.test(attachment.id)) continue;
    rmSync(join(uploadsDir(inboxDirPath), attachment.id), { recursive: true, force: true });
  }
}

export function removeInboxUploads(inboxDirPath: string, ids: readonly string[]): void {
  for (const id of ids) {
    if (!isInboxId("upl", id)) continue;
    try {
      unlinkSync(join(pendingDir(inboxDirPath), `${id}.json`));
    } catch {
      // Already gone.
    }
  }
}

export function removeUnusedInboxUploadFiles(inboxDirPath: string, attachmentIds: ReadonlySet<string>): void {
  let names: string[];
  try {
    names = readdirSync(uploadsDir(inboxDirPath));
  } catch {
    return;
  }
  for (const name of names) {
    if (!ATTACHMENT_DIR_RE.test(name) || attachmentIds.has(name)) continue;
    rmSync(join(uploadsDir(inboxDirPath), name), { recursive: true, force: true });
  }
}

/** Pending uploads older than INBOX_UPLOAD_KEEP_MS that no draft names are forgotten and the blobs only they held removed (never one a message or another upload uses). Temp files a crash left go too. Returns the ids forgotten. */
export function sweepInboxUploads(
  inboxDirPath: string,
  options: { keep: ReadonlySet<string>; usedBlobs: ReadonlySet<string>; now?: number },
): string[] {
  const now = options.now ?? Date.now();
  const uploads = listInboxUploads(inboxDirPath);
  const stale = uploads.filter((u) => !options.keep.has(u.upload_id) && now - Date.parse(u.created_at) > INBOX_UPLOAD_KEEP_MS);
  const staleIds = new Set(stale.map((u) => u.upload_id));
  removeInboxUploads(inboxDirPath, [...staleIds]);
  const stillHeld = new Set(uploads.filter((u) => !staleIds.has(u.upload_id)).map((u) => u.sha256));
  for (const upload of stale) {
    if (options.usedBlobs.has(upload.sha256) || stillHeld.has(upload.sha256)) continue;
    try {
      unlinkSync(inboxBlobPath(inboxDirPath, upload.sha256));
    } catch {
      // Already gone.
    }
  }
  const blobs = inboxBlobsDir(inboxDirPath);
  try {
    for (const name of readdirSync(blobs)) {
      if (!UPLOAD_TEMP_RE.test(name)) continue;
      const path = join(blobs, name);
      try {
        if (now - statSync(path).mtimeMs > 10 * 60_000) unlinkSync(path);
      } catch {
        // Gone already.
      }
    }
  } catch {
    // No blobs yet.
  }
  return [...staleIds];
}
