/**
 * Plannotator Inbox: a smaller copy of a big picture, for the places the window draws it small (`?w=` on
 * `/api/inbox/attachments/<id>/image` and `/api/inbox/messages/<id>/image`). A browser decodes a picture at its own
 * size whatever size it is drawn at: a thread with 89 screenshots of 3840 by 2242 held about 1.5 GB of decoded
 * pictures once scrolled through, and a tab that big can die ("Aw, Snap"). The window asks for the width it draws
 * at; the viewer that opens a picture whole still loads the original, with no `w`.
 *
 * Only a PNG (not animated) or a JPEG wider than the asked width is scaled, to that width, as WebP; anything else,
 * or a scale that fails, is the original as before. The copies are kept in memory by the original's hash, so a
 * second read costs nothing, and the ETag names the hash and the width, so a revalidation answers 304 without
 * scaling. The work is bounded: two scales at once, one for the same copy asked twice, none for a picture past the
 * pixel cap or one that already failed. Inbox-only (Bun's `Bun.Image`), like the routes it serves.
 *
 * Scaled on first view, not when the agent sends: most pictures are never looked at, the message image route serves
 * the file as it is on disk now (a copy made at send time would go stale), and a send stays fast.
 */
import { MAX_REVIEW_IMAGE_PREVIEW_PIXELS } from "@plannotator/shared/diff-paths";
import { createConcurrencyLimiter } from "@plannotator/shared/review-image";

/** The widths the window asks for: a tile's icon, the gallery's frames, a message body's pictures. */
export const INBOX_IMAGE_WIDTHS = [128, 800, 1600] as const;
/** A file past this many bytes is served as it is (scaling it would hold it whole in memory). */
const SCALE_MAX_BYTES = 32 * 1024 * 1024;
/** Scaled copies kept in memory, by total bytes (a 1600-wide WebP of a UI screenshot is about 100 KB, 800 wide about 40 KB). */
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const WEBP_QUALITY = 90;
/**
 * Scales at once. Each one decodes the whole picture first (about 55 to 85 MB for a 3840 by 2242 PNG, whatever the
 * width asked), so a browser's six parallel requests on a heavy thread took the Inbox past 500 MB; two at once peak
 * near 260 MB and still finish 89 screenshots in about 3 s. The work runs off the JS thread either way.
 */
const SCALE_CONCURRENCY = 2;
/** Past this many pixels a picture is not decoded to be scaled (a small PNG can declare 16000 by 16000): the original as before. */
const SCALE_MAX_PIXELS = MAX_REVIEW_IMAGE_PREVIEW_PIXELS;
/** WebP's own limit on either side: a very tall screenshot is scaled to fit it, or encoding fails. */
const WEBP_MAX_SIDE = 16_383;
/** Pictures that could not be scaled, remembered so a failure is not paid again on every request. */
const FAILED_MAX = 512;

/** The width the request asks for, or null: absent, or not one the window uses. */
export function inboxImageWidth(url: URL): number | null {
  const raw = url.searchParams.get("w");
  if (raw === null) return null;
  const width = Number(raw);
  return (INBOX_IMAGE_WIDTHS as readonly number[]).includes(width) ? width : null;
}

/** An animated PNG (an `acTL` chunk before the first `IDAT`): scaling would keep only its first frame. */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    at += 12 + length;
  }
  return false;
}

/** Whether a picture of this type and width is worth scaling to `to`. */
export function inboxImageScales(contentType: string, width: number | undefined, to: number | null, size: number): to is number {
  if (to === null || width === undefined || width <= to || size > SCALE_MAX_BYTES) return false;
  return contentType === "image/png" || contentType === "image/jpeg";
}

export interface ScaledImage {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: "image/webp";
  width: number;
  height: number;
}

const cache = new Map<string, ScaledImage>();
let cachedBytes = 0;
/** A scale in progress, by key: a second request for the same copy waits for it instead of scaling again. */
const inflight = new Map<string, Promise<ScaledImage | null>>();
const failed = new Set<string>();
const limit = createConcurrencyLimiter(SCALE_CONCURRENCY);

/** The ETag of the copy `to` wide of the picture whose own ETag is `etag` (`"<sha256>"`). */
export function scaledEtag(etag: string, to: number): string {
  return `"${etag.replace(/^W\//, "").replace(/"/g, "")}-w${to}"`;
}

function remember(cacheKey: string, scaled: ScaledImage): void {
  const old = cache.get(cacheKey);
  if (old) {
    cache.delete(cacheKey);
    cachedBytes -= old.bytes.byteLength;
  }
  cache.set(cacheKey, scaled);
  cachedBytes += scaled.bytes.byteLength;
  while (cachedBytes > CACHE_MAX_BYTES && cache.size > 1) {
    const [oldest, value] = cache.entries().next().value!;
    cache.delete(oldest);
    cachedBytes -= value.bytes.byteLength;
  }
}

function rememberFailure(cacheKey: string): void {
  failed.add(cacheKey);
  if (failed.size > FAILED_MAX) failed.delete(failed.values().next().value!);
}

/**
 * The picture `to` pixels wide (its height to scale, at most WebP's 16383), as WebP; null when it cannot be scaled
 * (an animated PNG, too many pixels, a decode that fails, no `Bun.Image`): the caller serves the original. `key`
 * names the bytes (their hash). At most SCALE_CONCURRENCY scales run at once; the same copy asked twice is scaled once.
 */
export function scaleInboxImage(bytes: Uint8Array, contentType: string, to: number, key: string): Promise<ScaledImage | null> {
  const cacheKey = `${key}:${to}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return Promise.resolve(hit);
  }
  if (failed.has(cacheKey)) return Promise.resolve(null);
  const running = inflight.get(cacheKey);
  if (running) return running;
  const job = limit(() => scaleNow(bytes, contentType, to))
    .catch(() => null)
    .then((scaled) => {
      if (scaled) remember(cacheKey, scaled);
      else rememberFailure(cacheKey);
      return scaled;
    })
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, job);
  return job;
}

async function scaleNow(bytes: Uint8Array, contentType: string, to: number): Promise<ScaledImage | null> {
  if (contentType === "image/png" && isAnimatedPng(bytes)) return null;
  const ImageClass = (globalThis as { Bun?: { Image?: new (input: Uint8Array, options?: { maxPixels?: number }) => BunImage } }).Bun?.Image;
  if (!ImageClass) return null;
  const image = new ImageClass(bytes, { maxPixels: SCALE_MAX_PIXELS }).resize(to, WEBP_MAX_SIDE, { fit: "inside", withoutEnlargement: true }).webp({ quality: WEBP_QUALITY });
  const out = await image.bytes();
  const meta = await new ImageClass(out).metadata();
  return { bytes: out, contentType: "image/webp", width: meta.width, height: meta.height };
}

/** The part of `Bun.Image` used here (typed locally: the Inbox's server types do not all carry it). */
interface BunImage {
  resize(width: number, height?: number, options?: { fit?: "fill" | "inside"; withoutEnlargement?: boolean }): BunImage;
  webp(options?: { quality?: number }): BunImage;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  metadata(): Promise<{ width: number; height: number }>;
}
