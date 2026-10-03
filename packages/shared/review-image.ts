/**
 * Code-review image preview (#1598): `GET /api/review-image`.
 *
 * Every decision lives here so the Bun server and the Pi mirror only do
 * transport: which requests are allowed (a file in the current patch, with no
 * hunks and an image extension), which side exists, the byte and pixel caps,
 * the content type (sniffed from magic bytes, never the extension), the image
 * header parse, the error mapping, and the response headers. The two servers
 * supply one thing each: how to read a side's bytes in their current mode.
 */

import { createHash } from "node:crypto";
import {
  MAX_REVIEW_IMAGE_PREVIEW_BYTES,
  MAX_REVIEW_IMAGE_PREVIEW_PIXELS,
  isReviewImagePath,
  parseLfsPointerText,
  type LfsPointer,
} from "./diff-paths";
import {
  type DiffSide,
  type FileBytesRead,
  type PatchFileEntry,
  type ReviewGitRuntime,
  findPatchFileEntry,
  readDiffSideBytes,
  validateFilePath,
} from "./review-core";

export const REVIEW_IMAGE_ENDPOINT = "/api/review-image";

/** Server-side ceiling on concurrent side reads (git spawns, gh/glab calls). */
export const REVIEW_IMAGE_READ_CONCURRENCY = 4;

export type ReviewImageErrorReason =
  | "unavailable"
  | "bad-request"
  | "not-in-diff"
  | "absent"
  | "missing"
  | "stale"
  | "too-large"
  | "not-image"
  | "lfs-pointer"
  | "lfs-mismatch"
  | "fetch-failed"
  | "aborted";

export interface ReviewImageErrorBody {
  reason: ReviewImageErrorReason;
  error: string;
  /** Size in bytes, on `too-large` when the byte cap was the limit. */
  bytes?: number;
  /** Dimensions, on `too-large` when the pixel cap was the limit. */
  width?: number;
  height?: number;
}

/** A transport-neutral HTTP response the servers write out verbatim. */
export interface ReviewImageResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string | null;
}

// --- Content sniffing ---------------------------------------------------------

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < Math.min(end, bytes.byteLength); i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** True when the bytes are a Git LFS pointer rather than the file itself. */
export function isLfsPointer(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, LFS_POINTER_PREFIX.length) === LFS_POINTER_PREFIX;
}

function isIsoBmffAvif(bytes: Uint8Array): boolean {
  if (ascii(bytes, 4, 8) !== "ftyp") return false;
  const boxSize = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
  const end = Math.min(boxSize || 32, bytes.byteLength, 64);
  const major = ascii(bytes, 8, 12);
  if (major === "avif" || major === "avis") return true;
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = ascii(bytes, offset, offset + 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

/**
 * SVG: UTF-8 text whose first element is `<svg`, after an optional BOM, XML
 * declaration, comments, processing instructions, and doctype. An HTML file
 * named `.svg` is rejected, so it can never be served as an image.
 */
function isSvg(bytes: Uint8Array): boolean {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) return false;
      i = end + 3;
    } else if (text.slice(i, i + 9).toUpperCase() === "<!DOCTYPE") {
      const bracket = text.indexOf("[", i);
      const close = text.indexOf(">", i);
      if (close === -1) return false;
      if (bracket !== -1 && bracket < close) {
        const subsetEnd = text.indexOf("]", bracket);
        if (subsetEnd === -1) return false;
        const after = text.indexOf(">", subsetEnd);
        if (after === -1) return false;
        i = after + 1;
      } else {
        i = close + 1;
      }
    } else {
      return /^<svg[\s>/]/.test(text.slice(i, i + 5));
    }
  }
  return false;
}

/** The image content type from magic bytes, or null when it is not an image we serve. */
export function sniffImageContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const head6 = ascii(bytes, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (isIsoBmffAvif(bytes)) return "image/avif";
  if (ascii(bytes, 0, 2) === "BM" && bytes.byteLength >= 26) return "image/bmp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.byteLength >= 22) return "image/x-icon";
  if (isSvg(bytes)) return "image/svg+xml";
  return null;
}

// --- Header dimensions ---------------------------------------------------------

export interface ImageDimensions {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32le = (b: Uint8Array, o: number) =>
  b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function jpegDimensions(b: Uint8Array): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 < b.byteLength) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = u16be(b, offset + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: u16be(b, offset + 5), width: u16be(b, offset + 7) };
    offset += 2 + length;
  }
  return null;
}

function avifDimensions(b: Uint8Array): ImageDimensions | null {
  const limit = Math.min(b.byteLength, 64 * 1024) - 16;
  for (let i = 0; i < limit; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      return { width: u32be(b, i + 8), height: u32be(b, i + 12) };
    }
  }
  return null;
}

/**
 * Dimensions from the image header, read from the first bytes only. Null when
 * the format has no fixed raster size (SVG) or the header is truncated; the
 * caller then serves without the pixel guard (the browser decodes at display
 * size for SVG).
 */
export function readImageDimensions(bytes: Uint8Array, contentType: string): ImageDimensions | null {
  const b = bytes;
  let dims: ImageDimensions | null = null;
  switch (contentType) {
    case "image/png":
      if (b.byteLength >= 24 && ascii(b, 12, 16) === "IHDR") dims = { width: u32be(b, 16), height: u32be(b, 20) };
      break;
    case "image/gif":
      if (b.byteLength >= 10) dims = { width: u16le(b, 6), height: u16le(b, 8) };
      break;
    case "image/jpeg":
      dims = jpegDimensions(b);
      break;
    case "image/webp": {
      const chunk = ascii(b, 12, 16);
      if (chunk === "VP8 " && b.byteLength >= 30) {
        dims = { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
      } else if (chunk === "VP8L" && b.byteLength >= 25 && b[20] === 0x2f) {
        dims = {
          width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
          height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
        };
      } else if (chunk === "VP8X" && b.byteLength >= 30) {
        dims = { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
      }
      break;
    }
    case "image/avif":
      dims = avifDimensions(b);
      break;
    case "image/bmp": {
      const headerSize = b.byteLength >= 18 ? (b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24)) : 0;
      if (headerSize === 12 && b.byteLength >= 22) dims = { width: u16le(b, 18), height: u16le(b, 20) };
      else if (headerSize >= 40 && b.byteLength >= 26) dims = { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
      break;
    }
    case "image/x-icon":
      if (b.byteLength >= 8) dims = { width: b[6] || 256, height: b[7] || 256 };
      break;
  }
  return dims && dims.width > 0 && dims.height > 0 ? dims : null;
}

// --- Concurrency -----------------------------------------------------------------

/** Thrown for work whose request went away before it ran. */
export class ReviewImageAbortError extends Error {
  constructor() {
    super("The image request was aborted");
    this.name = "AbortError";
  }
}

/** Throw when the request that asked for this work is already gone. */
export function throwIfReviewImageAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReviewImageAbortError();
}

/**
 * A FIFO semaphore: at most `limit` tasks run at once. A task whose `signal`
 * aborts while it is still queued leaves the queue without ever running, so a
 * burst of cards scrolled past cannot hold the slots (and the `gh api` quota)
 * that the card now on screen is waiting for.
 */
export function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const queue: Array<{ start: () => void; cancel: () => void; signal?: AbortSignal }> = [];
  const pump = () => {
    while (active < limit && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.signal?.aborted) entry.cancel();
      else entry.start();
    }
  };
  return function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ReviewImageAbortError());
        return;
      }
      const onAbort = () => {
        const index = queue.indexOf(entry);
        if (index !== -1) {
          queue.splice(index, 1);
          reject(new ReviewImageAbortError());
        }
      };
      const entry = {
        signal,
        cancel: () => {
          signal?.removeEventListener("abort", onAbort);
          reject(new ReviewImageAbortError());
        },
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          active++;
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              pump();
            });
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(entry);
      pump();
    });
  };
}

// --- Side readers shared by both servers ----------------------------------------

/**
 * PR layer mode: read from the local checkout first (fixed merge-base / head
 * commits, never the pool's worktree, which agents may edit), and fall back to
 * the platform API when the checkout is not ready or lacks the object (the
 * warmup's base fetch is shallow and best effort).
 */
export async function readPRImageSide(options: {
  gitRuntime: ReviewGitRuntime;
  poolCwd?: string;
  oldSha: string;
  headSha: string;
  side: DiffSide;
  filePath: string;
  oldPath?: string;
  maxBytes: number;
  fetchBytes: (sha: string, path: string, maxBytes: number) => Promise<FileBytesRead>;
  /** The request's abort signal: no platform call is made for a request that is gone. */
  signal?: AbortSignal;
}): Promise<FileBytesRead> {
  const sha = options.side === "old" ? options.oldSha : options.headSha;
  const path = options.side === "old" ? options.oldPath ?? options.filePath : options.filePath;
  if (options.poolCwd) {
    const local = await readDiffSideBytes(
      options.gitRuntime,
      { kind: "object", rev: sha, path },
      options.maxBytes,
      options.poolCwd,
    );
    if (local.kind === "ok" || local.kind === "too-large") return local;
  }
  throwIfReviewImageAborted(options.signal);
  return options.fetchBytes(sha, path, options.maxBytes);
}

// --- Git LFS (#1665) ---------------------------------------------------------------
//
// An LFS-tracked image's diff side is a pointer (`version …`, `oid sha256:…`,
// `size …`), not the image. The pointer names the real file by its sha256 and
// byte size, so a side resolves from wherever those bytes already are — the
// repository's LFS object cache, a smudged working-tree file — and only then
// from the platform. Every candidate is checked against the oid, so a stale
// worktree file or a corrupt cache entry can never be shown as the image.

/** Lower-case hex sha256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True when `bytes` are exactly the file `pointer` names (size and sha256). */
export function matchesLfsPointer(bytes: Uint8Array, pointer: LfsPointer): boolean {
  return bytes.byteLength === pointer.size && sha256Hex(bytes) === pointer.oid;
}

/** The pointer `bytes` hold, when they are an LFS pointer file. */
export function lfsPointerFromBytes(bytes: Uint8Array): LfsPointer | null {
  if (bytes.byteLength > 1024 || !isLfsPointer(bytes)) return null;
  return parseLfsPointerText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

const isAbsolutePath = (path: string) => /^(?:[a-zA-Z]:)?[\\/]/.test(path);

/** `<git-common-dir>/lfs/objects`, honoring `lfs.storage`; null outside a git repository. */
async function lfsObjectsDir(runtime: ReviewGitRuntime, cwd?: string): Promise<string | null> {
  let common: string | null = null;
  const absolute = await runtime.runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (absolute.exitCode === 0 && absolute.stdout.trim()) {
    common = absolute.stdout.trim();
  } else {
    // git < 2.31 has no --path-format; the plain answer is relative to cwd.
    const plain = await runtime.runGit(["rev-parse", "--git-common-dir"], { cwd });
    if (plain.exitCode !== 0 || !plain.stdout.trim()) return null;
    common = plain.stdout.trim();
    if (!isAbsolutePath(common) && cwd) common = `${cwd.replace(/[\\/]+$/, "")}/${common}`;
  }
  let lfsRoot = `${common}/lfs`;
  const storage = await runtime.runGit(["config", "--get", "lfs.storage"], { cwd });
  const configured = storage.exitCode === 0 ? storage.stdout.trim() : "";
  if (configured) lfsRoot = isAbsolutePath(configured) ? configured : `${common}/${configured}`;
  return `${lfsRoot}/objects`;
}

/**
 * Resolve a pointer from the local repository at `cwd`: its LFS object cache
 * first, then each working-tree path (repo-root relative) whose bytes hash to
 * the oid. `missing` when neither holds it.
 */
export async function readLfsObjectLocally(
  runtime: ReviewGitRuntime,
  cwd: string | undefined,
  pointer: LfsPointer,
  worktreePaths: string[],
  maxBytes: number,
): Promise<FileBytesRead> {
  if (pointer.size > maxBytes) return { kind: "too-large", size: pointer.size };
  if (!runtime.readFileBytes) return { kind: "unavailable" };
  const etag = `"lfs-${pointer.oid}"`;
  const objects = await lfsObjectsDir(runtime, cwd);
  if (objects) {
    const file = `${objects}/${pointer.oid.slice(0, 2)}/${pointer.oid.slice(2, 4)}/${pointer.oid}`;
    const info = await runtime.getFileInfo(undefined, file);
    if (info?.isFile && !info.isSymbolicLink && info.size === pointer.size) {
      const bytes = await runtime.readFileBytes(info.path, maxBytes);
      if (bytes && matchesLfsPointer(bytes, pointer)) return { kind: "ok", bytes, etag };
    }
  }
  for (const path of worktreePaths) {
    const read = await readDiffSideBytes(runtime, { kind: "worktree", path }, maxBytes, cwd);
    if (read.kind === "ok" && matchesLfsPointer(read.bytes, pointer)) return { kind: "ok", bytes: read.bytes, etag };
  }
  return { kind: "missing" };
}

/**
 * PR layer mode: the PR checkout (its LFS cache, and its working tree, which
 * git-lfs smudged at head) first; the platform only for a side neither has.
 * `fetchLfs` absent means the platform has no route, and the side answers
 * `missing` (the existing `lfs-pointer` error).
 */
export async function readPRLfsSide(options: {
  gitRuntime: ReviewGitRuntime;
  poolCwd?: string;
  oldSha: string;
  headSha: string;
  side: DiffSide;
  filePath: string;
  oldPath?: string;
  pointer: LfsPointer;
  maxBytes: number;
  fetchLfs?: (sha: string, path: string, maxBytes: number, signal?: AbortSignal) => Promise<FileBytesRead>;
  signal?: AbortSignal;
}): Promise<FileBytesRead> {
  const sha = options.side === "old" ? options.oldSha : options.headSha;
  const path = options.side === "old" ? options.oldPath ?? options.filePath : options.filePath;
  if (options.poolCwd) {
    const local = await readLfsObjectLocally(options.gitRuntime, options.poolCwd, options.pointer, [path], options.maxBytes);
    if (local.kind === "ok" || local.kind === "too-large") return local;
  }
  throwIfReviewImageAborted(options.signal);
  if (!options.fetchLfs) return { kind: "missing" };
  return options.fetchLfs(sha, path, options.maxBytes, options.signal);
}

type LfsResolution = FileBytesRead | { kind: "mismatch" };

const isAbortLike = (error: unknown) =>
  error instanceof ReviewImageAbortError || (error instanceof Error && error.name === "AbortError");

/**
 * Verified LFS objects by oid, per server session. Content-addressed and only
 * ever filled with bytes that hashed to their oid, so an entry is valid in any
 * mode. Concurrent requests for one oid share one resolution: the two sides of
 * a rename whose pointers name the same object download it once.
 */
export function createLfsObjectCache(options: { maxEntries?: number; maxBytes?: number } = {}) {
  const maxEntries = options.maxEntries ?? 8;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const done = new Map<string, Uint8Array>();
  const inflight = new Map<string, Promise<LfsResolution>>();
  let total = 0;
  const remember = (oid: string, bytes: Uint8Array) => {
    if (bytes.byteLength > maxBytes || done.has(oid)) return;
    done.set(oid, bytes);
    total += bytes.byteLength;
    for (const [key, value] of done) {
      if (done.size <= maxEntries && total <= maxBytes) break;
      done.delete(key);
      total -= value.byteLength;
    }
  };
  return {
    async resolve(oid: string, run: () => Promise<LfsResolution>, signal?: AbortSignal): Promise<LfsResolution> {
      const hit = done.get(oid);
      if (hit) {
        done.delete(oid);
        done.set(oid, hit);
        return { kind: "ok", bytes: hit, etag: `"lfs-${oid}"` };
      }
      const pending = inflight.get(oid);
      if (pending) {
        try {
          const shared = await pending;
          // Only a verified object is content-addressed. `missing` and the
          // other misses depend on the side and path that asked (the old path
          // of a rename may be absent from the worktree while the new one is
          // there), so a different caller resolves its own.
          if (shared.kind === "ok") return shared;
        } catch (error) {
          // The request that started it went away; ours did not, so run our own.
          if (!isAbortLike(error) || signal?.aborted) throw error;
        }
      }
      const own = run();
      inflight.set(oid, own);
      try {
        const result = await own;
        if (result.kind === "ok") remember(oid, result.bytes);
        return result;
      } finally {
        if (inflight.get(oid) === own) inflight.delete(oid);
      }
    },
  };
}

export type LfsObjectCache = ReturnType<typeof createLfsObjectCache>;

// --- The request -------------------------------------------------------------------

export interface ReviewImageRequest {
  /** Query parameters of the request (`path`, `side`, `snapshot`). */
  params: URLSearchParams;
  /** `If-None-Match` request header, for the 304 path. */
  ifNoneMatch?: string | null;
  /** False for static-patch and P4 sessions: nothing is ever read. */
  available: boolean;
  /** The session's current patch; only its files are servable. */
  patch: string;
  /** Whether `snapshot` names the snapshot the server is serving right now. */
  isCurrentSnapshot: (snapshot: string) => boolean;
  /** Aborts when the client goes away; queued and not-yet-started reads are dropped. */
  signal?: AbortSignal;
  /**
   * Read one side in the server's current mode. `filePath` / `oldPath` are the
   * chunk's own display paths (the client never supplies the old path).
   */
  readSide: (
    side: DiffSide,
    filePath: string,
    oldPath: string | undefined,
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<FileBytesRead>;
  /**
   * Resolve a Git LFS pointer to the real file (#1665), in the server's
   * current mode. Absent: LFS pointer chunks are not previewable and a side
   * that reads as a pointer answers `lfs-pointer`, exactly as before. The
   * bytes it returns are verified against the pointer here, never trusted.
   */
  resolveLfs?: (
    side: DiffSide,
    filePath: string,
    oldPath: string | undefined,
    pointer: LfsPointer,
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<FileBytesRead>;
  /** The session's verified-object cache (see `createLfsObjectCache`). */
  lfsObjects?: LfsObjectCache;
}

const IMAGE_RESPONSE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

function errorResponse(status: number, body: ReviewImageErrorBody): ReviewImageResponse {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isEligibleEntry(entry: PatchFileEntry, lfs: boolean): boolean {
  if (!isReviewImagePath(entry.newPath) && !isReviewImagePath(entry.oldPath)) return false;
  return !entry.hasHunks || (lfs && entry.lfs !== undefined);
}

const LFS_POINTER_ERROR: ReviewImageErrorBody = { reason: "lfs-pointer", error: "The file is stored in Git LFS" };

/** Resolve one pointer through the server, verify it, and share it through the cache. */
function resolveVerifiedLfs(
  request: ReviewImageRequest,
  side: DiffSide,
  filePath: string,
  oldPath: string | undefined,
  pointer: LfsPointer,
): Promise<LfsResolution> {
  const run = async (): Promise<LfsResolution> => {
    const read = await request.resolveLfs!(side, filePath, oldPath, pointer, MAX_REVIEW_IMAGE_PREVIEW_BYTES, request.signal);
    if (read.kind !== "ok") return read;
    if (!matchesLfsPointer(read.bytes, pointer)) return { kind: "mismatch" };
    return { kind: "ok", bytes: read.bytes, etag: `"lfs-${pointer.oid}"` };
  };
  return request.lfsObjects ? request.lfsObjects.resolve(pointer.oid, run, request.signal) : run();
}

/** Resolve one `GET /api/review-image` request to a transport-neutral response. */
export async function handleReviewImageRequest(request: ReviewImageRequest): Promise<ReviewImageResponse> {
  if (!request.available) {
    return errorResponse(400, { reason: "unavailable", error: "Image preview is unavailable for this review" });
  }
  const path = request.params.get("path");
  const side = request.params.get("side");
  const snapshot = request.params.get("snapshot");
  if (!path || (side !== "old" && side !== "new") || !snapshot) {
    return errorResponse(400, { reason: "bad-request", error: "Expected path, side=old|new and snapshot" });
  }
  if (!request.isCurrentSnapshot(snapshot)) {
    return errorResponse(409, { reason: "stale", error: "Diff snapshot is stale; refresh the review" });
  }

  const entry = findPatchFileEntry(request.patch, path);
  if (!entry || !isEligibleEntry(entry, request.resolveLfs !== undefined)) {
    return errorResponse(404, { reason: "not-in-diff", error: "No previewable image by that path in this diff" });
  }
  const sidePath = side === "old" ? entry.oldPath : entry.newPath;
  if (!sidePath) {
    return errorResponse(404, { reason: "absent", error: `This file has no ${side === "old" ? "before" : "after"} version` });
  }
  try {
    validateFilePath(sidePath);
    if (entry.newPath) validateFilePath(entry.newPath);
  } catch {
    return errorResponse(404, { reason: "not-in-diff", error: "Invalid file path" });
  }

  // A pointer chunk names the pointer in the patch itself (#1665).
  let pointer: LfsPointer | null = request.resolveLfs ? entry.lfs?.[side] ?? null : null;
  if (entry.hasHunks && !pointer) {
    return errorResponse(404, { reason: "absent", error: `This file has no ${side === "old" ? "before" : "after"} version` });
  }

  let read: FileBytesRead = { kind: "missing" };
  try {
    // The display path keys the new side; a deleted file's only path is its old one.
    const filePath = entry.newPath ?? sidePath;
    if (!pointer) {
      read = await request.readSide(side, filePath, entry.oldPath, MAX_REVIEW_IMAGE_PREVIEW_BYTES, request.signal);
      // A hunkless chunk (a pure rename, a mode change) whose side is a pointer.
      if (read.kind === "ok" && request.resolveLfs) pointer = lfsPointerFromBytes(read.bytes);
    }
    if (pointer) {
      // The pointer carries the real size: the cap applies before any read or download.
      if (pointer.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) {
        return errorResponse(413, {
          reason: "too-large",
          error: `The file is larger than ${formatMegabytes(MAX_REVIEW_IMAGE_PREVIEW_BYTES)}`,
          bytes: pointer.size,
        });
      }
      const resolved = await resolveVerifiedLfs(request, side, filePath, entry.oldPath, pointer);
      if (resolved.kind === "mismatch") {
        return errorResponse(502, {
          reason: "lfs-mismatch",
          error: "The Git LFS object does not match its pointer",
        });
      }
      // Nowhere to resolve it from: the pre-#1665 answer.
      if (resolved.kind === "missing" || resolved.kind === "unavailable") return errorResponse(415, LFS_POINTER_ERROR);
      read = resolved;
    }
  } catch (error) {
    if (error instanceof ReviewImageAbortError || request.signal?.aborted) {
      // Nobody is listening; the status only matters to logs.
      return errorResponse(499, { reason: "aborted", error: "The request was aborted" });
    }
    return errorResponse(502, {
      reason: "fetch-failed",
      error: error instanceof Error ? error.message : "Failed to read the image",
    });
  }

  switch (read.kind) {
    case "unavailable":
      return errorResponse(400, { reason: "unavailable", error: "Image preview is unavailable for this review" });
    case "missing":
      return errorResponse(404, { reason: "missing", error: "The file could not be found at this version" });
    case "too-large":
      return errorResponse(413, {
        reason: "too-large",
        error: `The file is larger than ${formatMegabytes(MAX_REVIEW_IMAGE_PREVIEW_BYTES)}`,
        bytes: read.size,
      });
  }

  const bytes = read.bytes;
  if (bytes.byteLength > MAX_REVIEW_IMAGE_PREVIEW_BYTES) {
    return errorResponse(413, {
      reason: "too-large",
      error: `The file is larger than ${formatMegabytes(MAX_REVIEW_IMAGE_PREVIEW_BYTES)}`,
      bytes: bytes.byteLength,
    });
  }
  if (isLfsPointer(bytes)) {
    return errorResponse(415, { reason: "lfs-pointer", error: "The file is stored in Git LFS" });
  }
  const contentType = sniffImageContentType(bytes);
  if (!contentType) {
    return errorResponse(415, { reason: "not-image", error: "The file is not a recognized image format" });
  }
  const dims = readImageDimensions(bytes, contentType);
  if (dims && dims.width * dims.height > MAX_REVIEW_IMAGE_PREVIEW_PIXELS) {
    return errorResponse(413, {
      reason: "too-large",
      error: `The image is ${dims.width} × ${dims.height} px, over the preview limit`,
      width: dims.width,
      height: dims.height,
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": IMAGE_RESPONSE_CSP,
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(read.etag ? { ETag: read.etag } : {}),
    ...(dims ? { "X-Image-Width": String(dims.width), "X-Image-Height": String(dims.height) } : {}),
  };
  if (read.etag && request.ifNoneMatch && request.ifNoneMatch === read.etag) {
    const { "Content-Length": _length, ...rest } = headers;
    return { status: 304, headers: rest, body: null };
  }
  return { status: 200, headers, body: bytes };
}
