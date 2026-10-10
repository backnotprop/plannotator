/**
 * Plannotator Inbox attachments on disk: recording a file at send time, the
 * content-addressed blobs, and reading a file again by its record.
 *
 *   inbox/blobs/<sha256>    the bytes of a sent version, written once
 *
 * The rules (see packages/core/inbox-attachments.ts): a file is recorded by
 * its realpath, from anywhere on disk the agent can read (a relative path
 * resolves against the agent's project_path); it must be a regular file and
 * not of the dotenv family; there is no size bound. Its kind is decided from
 * its name and its bytes (`decideInboxAttachmentKind`). A file is only ever
 * read again through its record, never through a path a request names. When
 * the current file is read, the recorded realpath must still be that same
 * regular file: a path component that became a symlink, a file that became a
 * directory, or a symlink the agent attached that now points elsewhere is
 * refused (the sent version still opens from its blob).
 *
 * Nothing holds a whole file in memory: sending streams the bytes through
 * the hash into a temp blob, and the current file's hash is kept per
 * (dev, ino, size, mtime, ctime), so listing a thread re-reads a file only
 * when it changed.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  inboxAttachmentId,
  inboxAttachmentKind,
  inboxAttachmentNameRefusal,
  readInboxAttachmentKind,
  type InboxAttachment,
  type InboxAttachmentKind,
  type InboxAttachmentState,
  type InboxAttachmentUnavailable,
} from "@plannotator/core/inbox-types";
import { isLfsPointer, readImageDimensions, sniffImageContentType } from "../review-image";
import { InboxError } from "./schema";

export const BLOBS_DIR = "blobs";

const SHA256_RE = /^[0-9a-f]{64}$/;
/** How much of a file the kind is decided from (image headers, `%PDF-`, an SVG's first element). */
export const INBOX_ATTACHMENT_HEAD_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
/** Never follow a final symlink, never block on a FIFO. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export function inboxBlobsDir(inboxDirPath: string): string {
  return join(inboxDirPath, BLOBS_DIR);
}

export function inboxBlobPath(inboxDirPath: string, sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new InboxError("validation_error", "Not a blob hash.");
  return join(inboxBlobsDir(inboxDirPath), sha256);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write a blob once (temp file, then rename), owner-only. Also the guided reviews' writer (step 5, packages/server/inbox-guides.ts). */
export function writeBlob(inboxDirPath: string, sha256: string, bytes: Uint8Array): void {
  const dir = inboxBlobsDir(inboxDirPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = inboxBlobPath(inboxDirPath, sha256);
  if (existsSync(path)) return;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600 });
  renameSync(temp, path);
}

/** Whether the first bytes are a PDF's (`%PDF-` within the first 1024 bytes, as readers accept it). */
export function isPdfHead(head: Uint8Array): boolean {
  const scan = Buffer.from(head.subarray(0, 1024)).toString("latin1");
  return scan.includes("%PDF-");
}

export interface InboxAttachmentKindDecision {
  kind: InboxAttachmentKind;
  media_type?: string;
  width?: number;
  height?: number;
}

/**
 * The kind of a file from its name and its bytes. Plannotator's documents
 * (markdown, text, config and data, HTML, Mermaid, Graphviz) keep their
 * viewer by extension while their bytes are text; everything else is read
 * from the bytes: an image by its magic bytes (the extension is ignored, so
 * an HTML page named `.svg` is not an image), a PDF by `%PDF-`, UTF-8 text
 * with no NUL as `code`, and anything else as `file`.
 */
export function decideInboxAttachmentKind(name: string, head: Uint8Array, isText: boolean): InboxAttachmentKindDecision {
  const byName = inboxAttachmentKind(name);
  if (byName !== "code" && byName !== "file") return isText ? { kind: byName } : { kind: "file" };
  const image = isLfsPointer(head) ? null : sniffImageContentType(head);
  if (image) {
    const dims = readImageDimensions(head, image);
    return { kind: "image", media_type: image, ...(dims ? { width: dims.width, height: dims.height } : {}) };
  }
  if (isPdfHead(head)) return { kind: "pdf", media_type: "application/pdf" };
  if (isText) return { kind: "code" };
  return { kind: "file" };
}

interface Scan {
  sha256: string;
  size: number;
  head: Buffer;
  text: boolean;
}

/**
 * Read a descriptor from its start to its end in chunks: the sha256, the
 * size, the first INBOX_ATTACHMENT_HEAD_BYTES and whether it is UTF-8 text
 * with no NUL. `sink` sees every chunk (the send path copies them to a blob).
 */
function scanFd(fd: number, sink?: (chunk: Buffer) => void): Scan {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const headParts: Buffer[] = [];
  let headSize = 0;
  let size = 0;
  let text = true;
  let position = 0;
  for (;;) {
    const n = readSync(fd, buffer, 0, buffer.length, position);
    if (n === 0) break;
    position += n;
    const chunk = buffer.subarray(0, n);
    hash.update(chunk);
    sink?.(chunk);
    size += n;
    if (headSize < INBOX_ATTACHMENT_HEAD_BYTES) {
      const part = Buffer.from(chunk.subarray(0, INBOX_ATTACHMENT_HEAD_BYTES - headSize));
      headParts.push(part);
      headSize += part.length;
    }
    if (text) {
      if (chunk.includes(0)) text = false;
      else {
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          text = false;
        }
      }
    }
  }
  if (text) {
    try {
      decoder.decode();
    } catch {
      text = false;
    }
  }
  return { sha256: hash.digest("hex"), size, head: Buffer.concat(headParts), text };
}

/** The first bytes of a descriptor. */
function readHead(fd: number): Buffer {
  const buffer = Buffer.alloc(INBOX_ATTACHMENT_HEAD_BYTES);
  let total = 0;
  while (total < buffer.length) {
    const n = readSync(fd, buffer, total, buffer.length - total, total);
    if (n === 0) break;
    total += n;
  }
  return buffer.subarray(0, total);
}

/**
 * Record the files an agent attached: each path absolute (anywhere the agent
 * can read) or relative to `base` (the agent's project_path), resolved to its
 * realpath, a regular file outside the dotenv family. Every file is checked
 * before any blob is committed; one refusal refuses the whole send. The bytes
 * stream through the hash into a temp blob, so a file of any size is taken.
 */
export function recordInboxAttachments(
  inboxDirPath: string,
  paths: readonly unknown[],
  options: { base: string; at: string },
): InboxAttachment[] {
  const checked: { named: string; real: string; stat: Stats; field: string }[] = [];
  paths.forEach((value, index) => {
    const field = `attachments[${index}]`;
    const refuse = (message: string): never => {
      throw new InboxError("validation_error", `${field}: ${message}`, { field });
    };
    if (typeof value !== "string" || value.trim() === "") refuse("a file path is required.");
    const named = isAbsolute(value as string) ? resolve(value as string) : resolve(options.base, value as string);
    const nameRefusal = inboxAttachmentNameRefusal(named);
    if (nameRefusal) refuse(`${basename(named)}: ${nameRefusal}`);
    let real: string;
    try {
      real = realpathSync(named);
    } catch {
      return refuse(`${named}: no such file.`);
    }
    const realRefusal = inboxAttachmentNameRefusal(real);
    if (realRefusal) refuse(`${basename(named)} resolves to ${basename(real)}: ${realRefusal}`);
    let stat: Stats;
    try {
      stat = statSync(real);
    } catch {
      return refuse(`${named}: no such file.`);
    }
    if (stat.isDirectory()) refuse(`${named}: a folder. Attach the files in it, or a zip of them.`);
    if (!stat.isFile()) refuse(`${named}: not a regular file.`);
    checked.push({ named, real, stat, field });
  });

  // Copy each file into a temp blob while hashing it; nothing is committed
  // until every file read.
  const dir = inboxBlobsDir(inboxDirPath);
  const read: { named: string; real: string; scan: Scan; mtime: string; temp: string }[] = [];
  const dropTemps = () => {
    for (const entry of read) {
      try {
        unlinkSync(entry.temp);
      } catch {
        // Already gone.
      }
    }
  };
  for (const [index, { named, real, stat, field }] of checked.entries()) {
    const refuse = (message: string): never => {
      dropTemps();
      throw new InboxError("validation_error", `${field}: ${message}`, { field });
    };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.send.${process.pid}.${Date.now()}.${index}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    let fd: number;
    try {
      fd = openSync(real, OPEN_FLAGS);
    } catch {
      return refuse(`${named}: could not be read.`);
    }
    let out: number | null = null;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) refuse(`${named}: changed while it was read.`);
      out = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const target = out;
      const scan = scanFd(fd, (chunk) => {
        let written = 0;
        while (written < chunk.length) written += writeSync(target, chunk, written, chunk.length - written);
      });
      read.push({ named, real, scan, mtime: opened.mtime.toISOString(), temp });
    } catch (error) {
      if (error instanceof InboxError) throw error;
      try {
        unlinkSync(temp);
      } catch {
        // Never written.
      }
      return refuse(`${named}: could not be read.`);
    } finally {
      closeSync(fd);
      if (out !== null) closeSync(out);
    }
  }

  return read.map(({ named, real, scan, mtime, temp }) => {
    const path = inboxBlobPath(inboxDirPath, scan.sha256);
    if (existsSync(path)) unlinkSync(temp);
    else renameSync(temp, path);
    const decided = decideInboxAttachmentKind(real, scan.head, scan.text);
    return {
      id: inboxAttachmentId(),
      path: real,
      named_path: named === real ? null : named,
      name: basename(real),
      kind: decided.kind,
      sent_sha256: scan.sha256,
      size: scan.size,
      sent_at: options.at,
      sent_mtime: mtime,
      ...(decided.media_type ? { media_type: decided.media_type } : {}),
      ...(decided.width !== undefined && decided.height !== undefined ? { width: decided.width, height: decided.height } : {}),
    } satisfies InboxAttachment;
  });
}

type CurrentCheck = { ok: true; stat: Stats } | { ok: false; unavailable: InboxAttachmentUnavailable };

const missing = (message: string): { ok: false; unavailable: InboxAttachmentUnavailable } => ({ ok: false, unavailable: { code: "attachment_missing", message } });
const changedType = (message: string): { ok: false; unavailable: InboxAttachmentUnavailable } => ({
  ok: false,
  unavailable: { code: "attachment_changed_type", message },
});

/**
 * The one check before the current file is read, for every route that reads
 * it (the window's and, through it, the phone's door): the recorded realpath
 * still leads to itself, the named symlink still points there, it is a
 * regular file, and its name is not of the dotenv family.
 */
function checkCurrent(attachment: InboxAttachment): CurrentCheck {
  let real: string;
  try {
    real = realpathSync(attachment.path);
  } catch {
    return missing(`${attachment.name} is no longer on disk.`);
  }
  if (real !== attachment.path) return changedType(`${attachment.path} now leads somewhere else (${real}).`);
  if (attachment.named_path) {
    let target: string;
    try {
      target = realpathSync(attachment.named_path);
    } catch {
      return missing(`${attachment.named_path} is no longer on disk.`);
    }
    if (target !== attachment.path) return changedType(`${attachment.named_path} now points somewhere else (${target}).`);
  }
  let stat: Stats;
  try {
    stat = lstatSync(attachment.path);
  } catch {
    return missing(`${attachment.name} is no longer on disk.`);
  }
  if (!stat.isFile()) return changedType(`${attachment.path} is no longer a regular file.`);
  const refusal = inboxAttachmentNameRefusal(attachment.path);
  if (refusal) return changedType(refusal);
  return { ok: true, stat };
}

/** Whether a file's first bytes still read as the kind it was sent as (an image stays an image, a PDF a PDF). */
function headMatchesKind(attachment: InboxAttachment, head: Uint8Array): string | null {
  const kind = readInboxAttachmentKind(attachment.kind);
  if (kind === "image" && (isLfsPointer(head) || !sniffImageContentType(head))) return `${attachment.name} is no longer an image.`;
  if (kind === "pdf" && !isPdfHead(head)) return `${attachment.name} is no longer a PDF.`;
  return null;
}

interface CurrentInfo {
  key: string;
  result: { ok: true; sha256: string; size: number; mtime: string } | { ok: false; unavailable: InboxAttachmentUnavailable };
}

/** The current file's hash per attachment path, valid while (dev, ino, size, mtime, ctime) stay the same. */
const currentInfoCache = new Map<string, CurrentInfo>();
const CURRENT_INFO_CACHE_MAX = 2048;

function statKey(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** The current file's hash, size and mtime (or why it cannot be read), re-read only when the file changed. */
export function inboxAttachmentCurrentInfo(attachment: InboxAttachment): CurrentInfo["result"] {
  const check = checkCurrent(attachment);
  if (!check.ok) return check;
  const key = `${attachment.kind}\0${statKey(check.stat)}`;
  const cached = currentInfoCache.get(attachment.path);
  if (cached && cached.key === key) return cached.result;
  let result: CurrentInfo["result"];
  let fd: number | null = null;
  try {
    fd = openSync(attachment.path, OPEN_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== check.stat.dev || opened.ino !== check.stat.ino) {
      result = changedType(`${attachment.name} changed while it was read.`);
    } else {
      const scan = scanFd(fd);
      const wrong = headMatchesKind(attachment, scan.head);
      result = wrong ? changedType(wrong) : { ok: true, sha256: scan.sha256, size: scan.size, mtime: opened.mtime.toISOString() };
    }
  } catch {
    result = missing(`${attachment.name} could not be read.`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (currentInfoCache.size >= CURRENT_INFO_CACHE_MAX) currentInfoCache.delete(currentInfoCache.keys().next().value!);
  currentInfoCache.set(attachment.path, { key, result });
  return result;
}

export type InboxAttachmentRead =
  | { ok: true; bytes: Buffer; sha256: string; size: number; mtime: string }
  | { ok: false; unavailable: InboxAttachmentUnavailable };

/** The current file's bytes, read only through its record (the rules in the header). For the text routes. */
export function readInboxAttachmentCurrent(attachment: InboxAttachment): InboxAttachmentRead {
  const check = checkCurrent(attachment);
  if (!check.ok) return check;
  let bytes: Buffer;
  try {
    bytes = readFileSync(attachment.path);
  } catch {
    return missing(`${attachment.name} could not be read.`);
  }
  return { ok: true, bytes, sha256: sha256Of(bytes), size: bytes.length, mtime: check.stat.mtime.toISOString() };
}

/** The sent version's bytes, or null when its blob is gone. */
export function readInboxAttachmentSent(inboxDirPath: string, attachment: InboxAttachment): Buffer | null {
  try {
    return readFileSync(inboxBlobPath(inboxDirPath, attachment.sent_sha256));
  } catch {
    return null;
  }
}

export type InboxAttachmentOpen =
  | { ok: true; fd: number; size: number; head: Buffer; sha256: string; mtime: string }
  | { ok: false; code: InboxAttachmentUnavailable["code"]; message: string };

/**
 * One version of an attachment opened for streaming: the descriptor (the
 * caller closes it, or hands it to a stream that does), its size, its first
 * bytes for sniffing, and its hash. The current version passes `checkCurrent`
 * first, and the descriptor must be the very file that check saw (dev and
 * ino), so a swap in between is refused.
 */
export function openInboxAttachmentVersion(inboxDirPath: string, attachment: InboxAttachment, version: "current" | "sent"): InboxAttachmentOpen {
  const fail = (code: InboxAttachmentUnavailable["code"], message: string): InboxAttachmentOpen => ({ ok: false, code, message });
  if (version === "sent") {
    let fd: number;
    try {
      fd = openSync(inboxBlobPath(inboxDirPath, attachment.sent_sha256), OPEN_FLAGS);
    } catch {
      return fail("attachment_missing", `The sent version of ${attachment.name} is gone.`);
    }
    try {
      const stat = fstatSync(fd);
      return { ok: true, fd, size: stat.size, head: readHead(fd), sha256: attachment.sent_sha256, mtime: attachment.sent_mtime };
    } catch {
      closeSync(fd);
      return fail("attachment_missing", `The sent version of ${attachment.name} could not be read.`);
    }
  }
  const info = inboxAttachmentCurrentInfo(attachment);
  if (!info.ok) return fail(info.unavailable.code, info.unavailable.message);
  const check = checkCurrent(attachment);
  if (!check.ok) return fail(check.unavailable.code, check.unavailable.message);
  let fd: number;
  try {
    fd = openSync(attachment.path, OPEN_FLAGS);
  } catch {
    return fail("attachment_missing", `${attachment.name} could not be opened.`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== check.stat.dev || stat.ino !== check.stat.ino) {
      closeSync(fd);
      return fail("attachment_changed_type", `${attachment.name} changed while it was opened.`);
    }
    const head = readHead(fd);
    const wrong = headMatchesKind(attachment, head);
    if (wrong) {
      closeSync(fd);
      return fail("attachment_changed_type", wrong);
    }
    return { ok: true, fd, size: stat.size, head, sha256: info.sha256, mtime: stat.mtime.toISOString() };
  } catch {
    closeSync(fd);
    return fail("attachment_missing", `${attachment.name} could not be read.`);
  }
}

/** The record plus the file as it is now. */
export function inboxAttachmentState(attachment: InboxAttachment, messageId: string): InboxAttachmentState {
  const current = inboxAttachmentCurrentInfo(attachment);
  return {
    ...attachment,
    message_id: messageId,
    current: current.ok ? { sha256: current.sha256, size: current.size, mtime: current.mtime } : null,
    changed_since_sent: current.ok && current.sha256 !== attachment.sent_sha256,
    unavailable: current.ok ? null : current.unavailable,
  };
}

/** Each blob's size on disk, by hash. */
export function inboxBlobSizes(inboxDirPath: string): Map<string, number> {
  const sizes = new Map<string, number>();
  const dir = inboxBlobsDir(inboxDirPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return sizes;
  }
  for (const name of names) {
    if (!SHA256_RE.test(name)) continue;
    try {
      sizes.set(name, statSync(join(dir, name)).size);
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return sizes;
}

/** Remove every blob no record uses any more. */
export function removeUnusedInboxBlobs(inboxDirPath: string, used: ReadonlySet<string>): void {
  for (const sha256 of inboxBlobSizes(inboxDirPath).keys()) {
    if (used.has(sha256)) continue;
    try {
      unlinkSync(inboxBlobPath(inboxDirPath, sha256));
    } catch {
      // Already gone.
    }
  }
}
