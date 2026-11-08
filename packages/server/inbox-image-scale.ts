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
 * scaling. Inbox-only (Bun's `Bun.Image`), like the routes it serves.
 */

/** The widths the window asks for: a tile's icon, the gallery's frames, a message body's pictures. */
export const INBOX_IMAGE_WIDTHS = [128, 800, 1600] as const;
/** A file past this many bytes is served as it is (scaling it would hold it whole in memory). */
const SCALE_MAX_BYTES = 32 * 1024 * 1024;
/** Scaled copies kept in memory, by total bytes (a 1600-wide WebP screenshot is about 50 KB). */
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const WEBP_QUALITY = 90;

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

/** The ETag of the copy `to` wide of the picture whose own ETag is `etag` (`"<sha256>"`). */
export function scaledEtag(etag: string, to: number): string {
  return `"${etag.replace(/^W\//, "").replace(/"/g, "")}-w${to}"`;
}

/**
 * The picture `to` pixels wide (its height to scale), as WebP; null when it cannot be scaled (an animated PNG, a
 * decode that fails, no `Bun.Image`): the caller serves the original. `key` names the bytes (their hash).
 */
export async function scaleInboxImage(bytes: Uint8Array, contentType: string, to: number, key: string): Promise<ScaledImage | null> {
  const cacheKey = `${key}:${to}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit;
  }
  if (contentType === "image/png" && isAnimatedPng(bytes)) return null;
  const ImageClass = (globalThis as { Bun?: { Image?: new (input: Uint8Array) => BunImage } }).Bun?.Image;
  if (!ImageClass) return null;
  try {
    const image = new ImageClass(bytes).resize(to, undefined, { fit: "inside", withoutEnlargement: true }).webp({ quality: WEBP_QUALITY });
    const out = await image.bytes();
    const meta = await new ImageClass(out).metadata();
    const scaled: ScaledImage = { bytes: out, contentType: "image/webp", width: meta.width, height: meta.height };
    cache.set(cacheKey, scaled);
    cachedBytes += out.byteLength;
    while (cachedBytes > CACHE_MAX_BYTES && cache.size > 1) {
      const [oldest, value] = cache.entries().next().value!;
      cache.delete(oldest);
      cachedBytes -= value.bytes.byteLength;
    }
    return scaled;
  } catch {
    return null;
  }
}

/** The part of `Bun.Image` used here (typed locally: the Inbox's server types do not all carry it). */
interface BunImage {
  resize(width: number, height?: number, options?: { fit?: "fill" | "inside"; withoutEnlargement?: boolean }): BunImage;
  webp(options?: { quality?: number }): BunImage;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  metadata(): Promise<{ width: number; height: number }>;
}
