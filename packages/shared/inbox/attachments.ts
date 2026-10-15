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
 * Nothing holds a whole file in memory and nothing blocks the event loop on
 * a large file: every read is async, in 1 MiB chunks, through one descriptor
 * opened `O_NOFOLLOW | O_NONBLOCK` and checked against the path's stat by
 * dev and ino. Sending streams the bytes through the hash into a temp blob
 * and primes the current file's hash, which is kept per (dev, ino, size,
 * mtime, ctime). Listing a thread hashes a changed file only up to
 * INBOX_LISTING_HASH_MAX_BYTES; a larger one is judged by its stat until the
 * person opens it.
 */

import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  INBOX_VIEW_MAX_BYTES,
  inboxAttachmentId,
  inboxAttachmentKind,
  inboxAttachmentNameRefusal,
  isInboxTextKind,
  readInboxAttachmentKind,
  type InboxAttachment,
  type InboxAttachmentKind,
  type InboxAttachmentState,
  type InboxAttachmentUnavailable,
} from "@plannotator/core/inbox-types";
import { isLfsPointer, readImageDimensions, sniffImageContentType } from "../review-image";
import { InboxError } from "./schema";
import { readMp4VideoMetadata, sniffInboxVideo, type InboxVideoMetadata } from "./video";

export const BLOBS_DIR = "blobs";

const SHA256_RE = /^[0-9a-f]{64}$/;
/** How much of a file the kind is decided from (image headers, `%PDF-`, an SVG's first element). */
export const INBOX_ATTACHMENT_HEAD_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
/** Listing a thread hashes a changed current file only up to this size; a larger one is judged by its stat. */
export const INBOX_LISTING_HASH_MAX_BYTES = 8 * 1024 * 1024;
/** A send's temp blob left by a crash is removed once it is this old. */
export const STALE_SEND_TEMP_MS = 10 * 60_000;
/** Never follow a final symlink, never block on a FIFO. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const SEND_TEMP_RE = /^\.send\..*\.tmp$/;

export function inboxBlobsDir(inboxDirPath: string): string {
  return join(inboxDirPath, BLOBS_DIR);
}

export function inboxBlobPath(inboxDirPath: string, sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new InboxError("validation_error", "Not a blob hash.");
  return join(inboxBlobsDir(inboxDirPath), sha256);
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
  duration_ms?: number;
}

/**
 * The kind of a file from its name, its bytes and its size. Plannotator's
 * documents (markdown, text, config and data, HTML, Mermaid, Graphviz) keep
 * their viewer by extension while their bytes are text; everything else is
 * read from the bytes: an image by its magic bytes (the extension is
 * ignored, so an HTML page named `.svg` is not an image), a PDF by `%PDF-`,
 * a film by its container (`sniffInboxVideo`, after the image check so an
 * AVIF stays an image), UTF-8 text with no NUL as `code`, and anything else
 * as `file`. A text kind over INBOX_VIEW_MAX_BYTES is a `file` (a download),
 * since the window reads text whole: this is not a limit on what attaches.
 *
 * `video` is what the header walk read from an MP4/MOV (readMp4VideoMetadata):
 * its length and frame size are recorded, and a file whose tracks hold no
 * video (audio named `.mp4`) stays a `file`.
 */
export function decideInboxAttachmentKind(name: string, head: Uint8Array, isText: boolean, size = 0, video?: InboxVideoMetadata | null): InboxAttachmentKindDecision {
  const byName = inboxAttachmentKind(name);
  const fitsView = size <= INBOX_VIEW_MAX_BYTES;
  if (byName !== "code" && byName !== "file") return isText && fitsView ? { kind: byName } : { kind: "file" };
  const image = isLfsPointer(head) ? null : sniffImageContentType(head);
  if (image) {
    const dims = readImageDimensions(head, image);
    return { kind: "image", media_type: image, ...(dims ? { width: dims.width, height: dims.height } : {}) };
  }
  if (isPdfHead(head)) return { kind: "pdf", media_type: "application/pdf" };
  const film = sniffInboxVideo(head);
  if (film && (!video || video.hasVideoTrack)) {
    return {
      kind: "video",
      media_type: film,
      ...(film !== "video/webm" && video?.duration_ms ? { duration_ms: video.duration_ms } : {}),
      ...(film !== "video/webm" && video?.width && video.height ? { width: video.width, height: video.height } : {}),
    };
  }
  if (isText && fitsView) return { kind: "code" };
  return { kind: "file" };
}

/** An MP4/MOV's header read through a file handle (a few small reads; the film itself is never read). */
export async function readInboxVideoMetadata(handle: FileHandle, size: number, head: Uint8Array): Promise<InboxVideoMetadata | null> {
  const film = sniffInboxVideo(head);
  if (film !== "video/mp4" && film !== "video/quicktime") return null;
  try {
    return await readMp4VideoMetadata(async (position, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      if (buffer.length === 0) return buffer;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    }, size);
  } catch {
    return null;
  }
}

interface Scan {
  sha256: string;
  size: number;
  head: Buffer;
  text: boolean;
}

/**
 * Read a file handle from its start to its end in 1 MiB chunks, yielding to
 * the event loop between them: the sha256, the size, the first
 * INBOX_ATTACHMENT_HEAD_BYTES and whether it is UTF-8 text with no NUL.
 * `sink` sees every chunk (the send path copies them to a blob).
 */
async function scanHandle(handle: FileHandle, sink?: (chunk: Buffer) => Promise<void>): Promise<Scan> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const headParts: Buffer[] = [];
  let headSize = 0;
  let size = 0;
  let text = true;
  for (;;) {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (sink) await sink(chunk);
    size += bytesRead;
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

/** A file's sha256, size, first bytes and whether it is UTF-8 text with no NUL (one async pass, never whole in memory). */
export async function scanInboxFile(path: string): Promise<{ sha256: string; size: number; head: Buffer; text: boolean }> {
  const handle = await open(path, OPEN_FLAGS);
  try {
    return await scanHandle(handle);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The first bytes of a file handle. */
async function readHead(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(INBOX_ATTACHMENT_HEAD_BYTES);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

/** A file handle's whole contents, at most `max` bytes (the caller checked the size first; a file that grew is cut at `max + 1` and refused). */
async function readAll(handle: FileHandle, max: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, max + 1 - total));
    if (buffer.length === 0) return null;
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) break;
    parts.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > max) return null;
  }
  return Buffer.concat(parts, total);
}

/** Remove send temp blobs a crash left behind (older than STALE_SEND_TEMP_MS). */
export function sweepStaleInboxSendTemps(inboxDirPath: string, now = Date.now()): void {
  const dir = inboxBlobsDir(inboxDirPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!SEND_TEMP_RE.test(name)) continue;
    try {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > STALE_SEND_TEMP_MS) unlinkSync(path);
    } catch {
      // Gone already.
    }
  }
}

/**
 * Record the files an agent attached: each path absolute (anywhere the agent
 * can read) or relative to `base` (the agent's project_path), resolved to its
 * realpath, a regular file outside the dotenv family. Every file is checked
 * before any blob is committed; one refusal refuses the whole send. The bytes
 * stream through the hash into a temp blob, so a file of any size is taken
 * without holding it in memory or blocking other requests.
 */
export async function recordInboxAttachments(inboxDirPath: string, paths: readonly unknown[], options: { base: string; at: string }): Promise<InboxAttachment[]> {
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
  const read: { named: string; real: string; scan: Scan; stat: Stats; temp: string; video: InboxVideoMetadata | null }[] = [];
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
    let handle: FileHandle;
    try {
      handle = await open(real, OPEN_FLAGS);
    } catch {
      return refuse(`${named}: could not be read.`);
    }
    let out: FileHandle | null = null;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) refuse(`${named}: changed while it was read.`);
      out = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const target = out;
      const scan = await scanHandle(handle, async (chunk) => {
        let written = 0;
        while (written < chunk.length) written += (await target.write(chunk, written, chunk.length - written)).bytesWritten;
      });
      // A film's length and frame size, from its header (a few small reads through the same handle).
      const video = await readInboxVideoMetadata(handle, scan.size, scan.head);
      read.push({ named, real, scan, stat: opened, temp, video });
    } catch (error) {
      if (error instanceof InboxError) throw error;
      try {
        unlinkSync(temp);
      } catch {
        // Never written.
      }
      return refuse(`${named}: could not be read.`);
    } finally {
      await handle.close().catch(() => {});
      if (out) await out.close().catch(() => {});
    }
  }

  return read.map(({ named, real, scan, stat, temp, video }) => {
    const path = inboxBlobPath(inboxDirPath, scan.sha256);
    if (existsSync(path)) unlinkSync(temp);
    else renameSync(temp, path);
    const decided = decideInboxAttachmentKind(real, scan.head, scan.text, scan.size, video);
    const attachment = {
      id: inboxAttachmentId(),
      path: real,
      named_path: named === real ? null : named,
      name: basename(real),
      kind: decided.kind,
      sent_sha256: scan.sha256,
      size: scan.size,
      sent_at: options.at,
      sent_mtime: stat.mtime.toISOString(),
      ...(decided.media_type ? { media_type: decided.media_type } : {}),
      ...(decided.width !== undefined && decided.height !== undefined ? { width: decided.width, height: decided.height } : {}),
      ...(decided.duration_ms !== undefined ? { duration_ms: decided.duration_ms } : {}),
    } satisfies InboxAttachment;
    // The file was just read whole: listing the thread needs no second read.
    primeCurrentInfo(attachment, stat, { ok: true, sha256: scan.sha256, size: scan.size, mtime: stat.mtime.toISOString() });
    return attachment;
  });
}

export type CurrentCheck = { ok: true; stat: Stats } | { ok: false; unavailable: InboxAttachmentUnavailable };

const missing = (message: string): { ok: false; unavailable: InboxAttachmentUnavailable } => ({ ok: false, unavailable: { code: "attachment_missing", message } });
const changedType = (message: string): { ok: false; unavailable: InboxAttachmentUnavailable } => ({
  ok: false,
  unavailable: { code: "attachment_changed_type", message },
});

/**
 * The one check before the current file is read, for every route that reads
 * it (the window's and, through it, the phone's door): the recorded realpath
 * still leads to itself, the named symlink still points there, it is a
 * regular file, and its name is not of the dotenv family. Exported for the
 * routes that hand the file to something other than a read: the new-tab
 * page and the "Open in" launcher (packages/server/inbox-open-in.ts).
 */
export function checkCurrent(attachment: InboxAttachment): CurrentCheck {
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

/**
 * The check before the current file is handed to an app ("Open in"): the
 * one check every read takes (`checkCurrent`), and for an image or a PDF its
 * first bytes must still be that kind, read through the same descriptor
 * rules as a read. Nothing else is read.
 *
 * What it guarantees is the state at the moment of the check. The app is
 * then handed the PATH (an app cannot take a descriptor), so a swap in the
 * few milliseconds between this check and the launch is not refused here;
 * only someone who can already write that folder (the agent itself) could
 * do it. The per-kind policy (`inboxOpenInPolicy`) is what bounds that: the
 * OS default only ever gets a path whose own extension is an image, a PDF
 * or a plain text format, so a swapped-in file still opens by that extension.
 */
export async function checkInboxAttachmentForLaunch(inboxDirPath: string, attachment: InboxAttachment): Promise<CurrentCheck> {
  const check = checkCurrent(attachment);
  if (!check.ok) return check;
  const kind = readInboxAttachmentKind(attachment.kind);
  if (kind !== "image" && kind !== "pdf" && kind !== "video") return check;
  const opened = await openInboxAttachmentVersion(inboxDirPath, attachment, "current");
  if (!opened.ok) return { ok: false, unavailable: { code: opened.code, message: opened.message } };
  await opened.handle.close().catch(() => {});
  return check;
}

/** Whether a file's first bytes still read as the kind it was sent as (an image stays an image, a PDF a PDF). */
function headMatchesKind(attachment: InboxAttachment, head: Uint8Array): string | null {
  const kind = readInboxAttachmentKind(attachment.kind);
  if (kind === "image" && (isLfsPointer(head) || !sniffImageContentType(head))) return `${attachment.name} is no longer an image.`;
  if (kind === "pdf" && !isPdfHead(head)) return `${attachment.name} is no longer a PDF.`;
  if (kind === "video" && !sniffInboxVideo(head)) return `${attachment.name} is no longer a video.`;
  return null;
}

/**
 * Open the current file through the one check: `O_NOFOLLOW | O_NONBLOCK`,
 * and the descriptor must be the very file the check saw (dev and ino), so a
 * swap in between, a FIFO or a device is refused without being read.
 */
async function openCurrent(attachment: InboxAttachment): Promise<{ ok: true; handle: FileHandle; stat: Stats } | { ok: false; unavailable: InboxAttachmentUnavailable }> {
  const check = checkCurrent(attachment);
  if (!check.ok) return check;
  let handle: FileHandle;
  try {
    handle = await open(attachment.path, OPEN_FLAGS);
  } catch {
    return missing(`${attachment.name} could not be opened.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== check.stat.dev || stat.ino !== check.stat.ino) {
      await handle.close().catch(() => {});
      return changedType(`${attachment.name} changed while it was opened.`);
    }
    return { ok: true, handle, stat };
  } catch {
    await handle.close().catch(() => {});
    return missing(`${attachment.name} could not be read.`);
  }
}

type CurrentResult = { ok: true; sha256: string; size: number; mtime: string } | { ok: false; unavailable: InboxAttachmentUnavailable };

interface CurrentInfo {
  key: string;
  result: CurrentResult;
}

/** The current file's hash per attachment path, valid while (dev, ino, size, mtime, ctime) stay the same. */
const currentInfoCache = new Map<string, CurrentInfo>();
/** One read per path at a time: concurrent listings share it. */
const currentInfoReads = new Map<string, Promise<CurrentResult>>();
const CURRENT_INFO_CACHE_MAX = 2048;

function statKey(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function cacheKey(attachment: InboxAttachment, stat: Stats): string {
  return `${attachment.kind}\0${statKey(stat)}`;
}

function primeCurrentInfo(attachment: InboxAttachment, stat: Stats, result: CurrentResult): void {
  if (currentInfoCache.size >= CURRENT_INFO_CACHE_MAX) currentInfoCache.delete(currentInfoCache.keys().next().value!);
  currentInfoCache.set(attachment.path, { key: cacheKey(attachment, stat), result });
}

/**
 * The current file's hash, size and mtime (or why it cannot be read),
 * re-read only when the file changed. `hash: "small"` (listing a thread)
 * hashes a changed file only up to INBOX_LISTING_HASH_MAX_BYTES; a larger one
 * is judged by its stat (unchanged when size and mtime are the sent ones),
 * so a growing log is not re-read on every listing.
 */
export async function inboxAttachmentCurrentInfo(attachment: InboxAttachment, options: { hash?: "always" | "small" } = {}): Promise<CurrentResult> {
  const check = checkCurrent(attachment);
  if (!check.ok) return check;
  const key = cacheKey(attachment, check.stat);
  const cached = currentInfoCache.get(attachment.path);
  if (cached && cached.key === key) return cached.result;
  if (options.hash === "small" && check.stat.size > INBOX_LISTING_HASH_MAX_BYTES) {
    const mtime = check.stat.mtime.toISOString();
    const unchanged = check.stat.size === attachment.size && mtime === attachment.sent_mtime;
    // Not cached: the full hash is taken when the person opens or downloads the file.
    return { ok: true, sha256: unchanged ? attachment.sent_sha256 : `stat:${check.stat.size}:${check.stat.mtimeMs}`, size: check.stat.size, mtime };
  }
  const inFlight = currentInfoReads.get(`${attachment.path}\0${key}`);
  if (inFlight) return inFlight;
  const run = (async (): Promise<CurrentResult> => {
    const opened = await openCurrent(attachment);
    if (!opened.ok) return opened;
    try {
      const scan = await scanHandle(opened.handle);
      const wrong = headMatchesKind(attachment, scan.head);
      const result: CurrentResult = wrong ? changedType(wrong) : { ok: true, sha256: scan.sha256, size: scan.size, mtime: opened.stat.mtime.toISOString() };
      primeCurrentInfo(attachment, opened.stat, result);
      return result;
    } catch {
      return missing(`${attachment.name} could not be read.`);
    } finally {
      await opened.handle.close().catch(() => {});
    }
  })();
  currentInfoReads.set(`${attachment.path}\0${key}`, run);
  try {
    return await run;
  } finally {
    currentInfoReads.delete(`${attachment.path}\0${key}`);
  }
}

export type InboxAttachmentRead =
  | { ok: true; bytes: Buffer; sha256: string; size: number; mtime: string }
  | { ok: false; code: InboxAttachmentUnavailable["code"] | "attachment_too_large"; message: string };

/**
 * One version's whole text, for the text routes: the size is checked on the
 * open descriptor first, so a file over INBOX_VIEW_MAX_BYTES (one that grew
 * after it was sent, say) answers `attachment_too_large` without being read.
 */
export async function readInboxAttachmentText(inboxDirPath: string, attachment: InboxAttachment, version: "current" | "sent"): Promise<InboxAttachmentRead> {
  const opened = await openInboxAttachmentVersion(inboxDirPath, attachment, version, { hash: "none" });
  if (!opened.ok) return opened;
  try {
    const tooLarge = (): InboxAttachmentRead => ({
      ok: false,
      code: "attachment_too_large",
      message: `${attachment.name} is too large to show here (over ${Math.round(INBOX_VIEW_MAX_BYTES / 1024 / 1024)} MB). Download it instead.`,
    });
    if (opened.size > INBOX_VIEW_MAX_BYTES) return tooLarge();
    const bytes = await readAll(opened.handle, INBOX_VIEW_MAX_BYTES);
    if (!bytes) return tooLarge();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { ok: true, bytes, sha256, size: bytes.length, mtime: opened.mtime };
  } finally {
    await opened.handle.close().catch(() => {});
  }
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
  | {
      ok: true;
      handle: FileHandle;
      size: number;
      head: Buffer;
      sha256: string | null;
      mtime: string;
      /**
       * A validator for this version, taken without reading the file (a seek
       * in a film is one request each): the sent version's `"<sha256>"`, and
       * for the current file a tag of the opened descriptor's stat
       * (`"<dev>-<ino>-<size>-<mtime µs>"`, strong as nginx's is), which changes when the agent
       * rewrites the file. The Range routes answer `If-Range` with it.
       */
      etag: string;
    }
  | { ok: false; code: InboxAttachmentUnavailable["code"]; message: string };

/**
 * The validator of a file as a descriptor saw it: no read, and it moves with
 * any rewrite (a new inode, size or mtime to the microsecond). Strong, as
 * nginx's stat ETag is, because `If-Range` takes only a strong comparison
 * (RFC 9110 13.1.5): a range is only ever served from those exact bytes.
 */
export function inboxStatEtag(stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">): string {
  return `"${stat.dev.toString(16)}-${stat.ino.toString(16)}-${stat.size.toString(16)}-${Math.round(stat.mtimeMs * 1000).toString(16)}"`;
}

/**
 * One version of an attachment opened for streaming: the file handle (the
 * caller closes it, or hands it to a stream that does), its size, its first
 * bytes for sniffing, and its hash when asked for (`hash: "always"`, the
 * image route's ETag; the sent version's is its record's). The current
 * version goes through `openCurrent`, so a swap after the check is refused.
 */
export async function openInboxAttachmentVersion(
  inboxDirPath: string,
  attachment: InboxAttachment,
  version: "current" | "sent",
  options: { hash?: "always" | "none" } = {},
): Promise<InboxAttachmentOpen> {
  const fail = (code: InboxAttachmentUnavailable["code"], message: string): InboxAttachmentOpen => ({ ok: false, code, message });
  if (version === "sent") {
    let handle: FileHandle;
    try {
      handle = await open(inboxBlobPath(inboxDirPath, attachment.sent_sha256), OPEN_FLAGS);
    } catch {
      return fail("attachment_missing", `The sent version of ${attachment.name} is gone.`);
    }
    try {
      const stat = await handle.stat();
      return { ok: true, handle, size: stat.size, head: await readHead(handle), sha256: attachment.sent_sha256, mtime: attachment.sent_mtime, etag: `"${attachment.sent_sha256}"` };
    } catch {
      await handle.close().catch(() => {});
      return fail("attachment_missing", `The sent version of ${attachment.name} could not be read.`);
    }
  }
  let sha256: string | null = null;
  if (options.hash === "always") {
    const info = await inboxAttachmentCurrentInfo(attachment);
    if (!info.ok) return fail(info.unavailable.code, info.unavailable.message);
    sha256 = info.sha256;
  }
  const opened = await openCurrent(attachment);
  if (!opened.ok) return fail(opened.unavailable.code, opened.unavailable.message);
  try {
    const head = await readHead(opened.handle);
    const wrong = headMatchesKind(attachment, head);
    if (wrong) {
      await opened.handle.close().catch(() => {});
      return fail("attachment_changed_type", wrong);
    }
    return { ok: true, handle: opened.handle, size: opened.stat.size, head, sha256, mtime: opened.stat.mtime.toISOString(), etag: inboxStatEtag(opened.stat) };
  } catch {
    await opened.handle.close().catch(() => {});
    return fail("attachment_missing", `${attachment.name} could not be read.`);
  }
}

/** The record plus the file as it is now. `hash: "small"` when listing a thread (see inboxAttachmentCurrentInfo). */
export async function inboxAttachmentState(attachment: InboxAttachment, messageId: string, options: { hash?: "always" | "small" } = {}): Promise<InboxAttachmentState> {
  const current = await inboxAttachmentCurrentInfo(attachment, options);
  return {
    ...attachment,
    message_id: messageId,
    current: current.ok ? { sha256: current.sha256, size: current.size, mtime: current.mtime } : null,
    changed_since_sent: current.ok && current.sha256 !== attachment.sent_sha256,
    unavailable: current.ok ? null : current.unavailable,
  };
}

/** Whether an attachment's kind is read whole as text by the `view` and raw routes. */
export function isInboxAttachmentText(attachment: Pick<InboxAttachment, "kind">): boolean {
  return isInboxTextKind(attachment.kind);
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

/** Remove every blob no record uses any more, and send temps a crash left behind. */
export function removeUnusedInboxBlobs(inboxDirPath: string, used: ReadonlySet<string>): void {
  for (const sha256 of inboxBlobSizes(inboxDirPath).keys()) {
    if (used.has(sha256)) continue;
    try {
      unlinkSync(inboxBlobPath(inboxDirPath, sha256));
    } catch {
      // Already gone.
    }
  }
  sweepStaleInboxSendTemps(inboxDirPath);
}
