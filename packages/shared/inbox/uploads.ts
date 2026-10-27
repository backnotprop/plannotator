/**
 * Plannotator Inbox: files the person uploads from the window for a thread
 * they start (compose, "send a new message to a connected agent") or a reply
 * (pasted into the reply box).
 *
 *   inbox/uploads/pending/<upl_id>.json   an upload not sent yet; a draft may name it
 *   inbox/uploads/<att_id>/<name>         a sent upload: a read-only copy of its blob
 *   inbox/blobs/<sha256>                  the bytes, in the store agents' files use
 *
 * Agents attach paths; the person uploads bytes. Both end as the same
 * `InboxAttachment` record, so the window's tiles, viewers, download route and
 * the phone door carry an upload unchanged. At send each upload becomes a
 * real file with its real name (a copy of the blob, a clone where the
 * filesystem has them, never a hard link), so the agent can open it; it is
 * read-only, so it reads as the version sent.
 *
 * Rules: the name is a plain file name (no path separator, no control
 * character, at most 255 bytes) outside the dotenv family; the body is
 * streamed, never held whole, and at most INBOX_UPLOAD_MAX_BYTES (under the
 * Inbox's 128 MiB request bound: no chunked protocol, owner's "don't
 * overengineer"). The kind is decided by the same rules as an agent's file.
 * An upload no draft names is swept after INBOX_UPLOAD_KEEP_MS.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
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
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  inboxAttachmentId,
  inboxAttachmentNameRefusal,
  inboxBoardRequestBlock,
  inboxId,
  isInboxId,
  THREAD_NAME_BIDI,
  THREAD_NAME_CONTROL,
  type InboxAttachment,
  type InboxUpload,
} from "@plannotator/core/inbox-types";
import { decideInboxAttachmentKind, inboxBlobPath, inboxBlobsDir, scanInboxFile } from "./attachments";
import { InboxError } from "./schema";

export const INBOX_UPLOADS_DIR = "uploads";

/**
 * The lines an agent reads under a message's words for the files the person
 * attached, each with its path so the agent can open it: `Attached: name (path)`.
 * Empty when it carries none. The wake and `wait_for_reply` both append them.
 */
export function inboxAttachedLines(message: { attachments?: readonly InboxAttachment[] | null }): string {
  return (message.attachments ?? []).map((attachment) => `Attached: ${attachment.name} (${attachment.path})`).join("\n");
}

/**
 * The words an agent reads for a person's message: its body, then
 * `inboxAttachedLines`, then, on a message sent with compose's Board chip on,
 * the Board request (`inboxBoardRequestBlock`). The stored body never holds it.
 */
export function inboxBodyForAgent(
  message: { body: string; thread_id?: string; attachments?: readonly InboxAttachment[] | null; board_request?: true },
  options: { boardRequest?: boolean } = {},
): string {
  const attached = inboxAttachedLines(message);
  // A reply of pasted files alone may have no words.
  let words = !attached ? message.body : message.body.trim() ? `${message.body}\n\n${attached}` : attached;
  // `boardRequest: false`: a JSON field that keeps the person's words (the block is in the text beside it).
  if (options.boardRequest !== false && message.board_request === true && message.thread_id) words = `${words}\n\n${inboxBoardRequestBlock(message.thread_id)}`;
  return words;
}
const PENDING_DIR = "pending";
/** The most one uploaded file may hold (decision 1a: under the Inbox's 128 MiB request bound). */
export const INBOX_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** An upload no draft names is kept this long, then swept. */
export const INBOX_UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;
export const INBOX_UPLOAD_NAME_MAX_BYTES = 255;
const ATTACHMENT_DIR_RE = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
const UPLOAD_TEMP_RE = /^\.upload\..*\.tmp$/;

function uploadsDir(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_UPLOADS_DIR);
}

function pendingDir(inboxDirPath: string): string {
  return join(uploadsDir(inboxDirPath), PENDING_DIR);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Why a name cannot be uploaded, or null. */
export function inboxUploadNameRefusal(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return "A file needs a name.";
  if (name === "." || name === "..") return "Not a file name.";
  if (/[/\\]/.test(name)) return "A file name cannot hold a path separator.";
  // The thread-name sets: C0 and C1 controls, line and paragraph separators, bidi controls.
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

/** One upload not sent yet, by id. */
export function readInboxUpload(inboxDirPath: string, id: unknown): InboxUpload | null {
  if (!isInboxId("upl", id)) return null;
  try {
    return parseUpload(readFileSync(join(pendingDir(inboxDirPath), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Every upload not sent yet. */
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

/** The blobs the uploads not sent yet hold: the store's blob sweep keeps them. */
export function pendingInboxUploadBlobs(inboxDirPath: string): Set<string> {
  return new Set(listInboxUploads(inboxDirPath).map((upload) => upload.sha256));
}

/**
 * Take one file the person uploaded: the body streamed to a temp file in the
 * blob store (never held whole), refused past INBOX_UPLOAD_MAX_BYTES, then
 * hashed, renamed to `blobs/<sha256>` and recorded as pending. Nothing is
 * kept when anything fails, the request is aborted included.
 */
export async function receiveInboxUpload(
  inboxDirPath: string,
  name: unknown,
  body: ReadableStream<Uint8Array> | null,
  options: { at: string; maxBytes?: number },
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
    };
    const dir = pendingDir(inboxDirPath);
    ensureDir(dir);
    const file = join(dir, `${upload.upload_id}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(upload)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return upload;
  } catch (error) {
    if (out) await out.close().catch(() => {});
    try {
      unlinkSync(temp);
    } catch {
      // Renamed, or never written.
    }
    if (error instanceof InboxError) throw error;
    throw new InboxError("upload_refused", "The file could not be received; try again.", { field: "body" });
  }
}

/**
 * The uploads a message carries, as attachment records: each blob copied to
 * `uploads/<att_id>/<name>` (a clone where the filesystem has them, so it
 * costs no space; read-only outside Windows), its realpath the record's path,
 * so the agent opens a real file with its real name. A copy, never a hard
 * link: an agent that writes to its file must not change the stored blob the
 * window shows as the version sent. Every id is checked before anything is
 * written. `removeInboxAttachmentFiles` takes them back when the message is
 * not written after all.
 */
export function inboxUploadAttachments(inboxDirPath: string, ids: readonly unknown[], at: string): InboxAttachment[] {
  const uploads = ids.map((id, index) => {
    const upload = readInboxUpload(inboxDirPath, id);
    if (!upload || !existsSync(inboxBlobPath(inboxDirPath, upload.sha256))) {
      throw new InboxError("upload_not_found", `uploads[${index}]: that file is no longer here; attach it again.`, { field: `uploads[${index}]` });
    }
    return upload;
  });
  const made: string[] = [];
  try {
    return uploads.map((upload) => {
      const id = inboxAttachmentId();
      const dir = join(uploadsDir(inboxDirPath), id);
      ensureDir(dir);
      made.push(dir);
      const target = join(dir, upload.name);
      const blob = inboxBlobPath(inboxDirPath, upload.sha256);
      copyFileSync(blob, target, constants.COPYFILE_FICLONE);
      // Read-only, so the file reads as the version sent. Not on Windows,
      // where a read-only file cannot be deleted by the sweep.
      if (process.platform !== "win32") {
        try {
          chmodSync(target, 0o400);
        } catch {
          // Best effort (a filesystem without modes).
        }
      }
      const real = realpathSync(target);
      return {
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
      } satisfies InboxAttachment;
    });
  } catch (error) {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
    if (error instanceof InboxError) throw error;
    throw new InboxError("upload_not_found", "An uploaded file could not be attached; attach it again.");
  }
}

/** Remove the files `inboxUploadAttachments` wrote, for a message that was not written (a replay, a refusal). */
export function removeInboxAttachmentFiles(inboxDirPath: string, attachments: readonly InboxAttachment[]): void {
  for (const attachment of attachments) {
    if (!ATTACHMENT_DIR_RE.test(attachment.id)) continue;
    rmSync(join(uploadsDir(inboxDirPath), attachment.id), { recursive: true, force: true });
  }
}

/** Forget pending uploads (sent, or swept); their blobs go with the store's next blob sweep. */
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

/**
 * Remove a sent upload's file once no message carries its attachment (a
 * deleted thread or project). Called by the store after a deletion.
 */
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

/**
 * The periodic sweep: pending uploads older than INBOX_UPLOAD_KEEP_MS that no
 * draft names are forgotten, and the blobs only they held are removed (never
 * a blob a message or another upload uses). Temp files a crash left go too.
 * Returns the ids it forgot.
 */
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
