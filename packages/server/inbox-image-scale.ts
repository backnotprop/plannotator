/** A smaller copy of a big picture for places drawn small (`?w=`): a browser decodes at full size, so dozens of large screenshots can kill a tab. Scaled on first view, not at send: the image route serves the file as it is on disk now, so a send-time copy would go stale. Inbox-only (`Bun.Image`). */
import { MAX_REVIEW_IMAGE_PREVIEW_PIXELS } from "@plannotator/shared/diff-paths";
import { createConcurrencyLimiter } from "@plannotator/shared/review-image";

export const INBOX_IMAGE_WIDTHS = [128, 800, 1600] as const;
const SCALE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const WEBP_QUALITY = 90;
/** Scales at once: each decodes the whole picture first, and a browser's six parallel requests took the Inbox past 500 MB; two at once peak near 260 MB. */
const SCALE_CONCURRENCY = 2;
/** Past this many pixels a picture is not decoded to be scaled (a small PNG can declare 16000 by 16000): the original as before. */
const SCALE_MAX_PIXELS = MAX_REVIEW_IMAGE_PREVIEW_PIXELS;
/** WebP's own limit on either side: a very tall screenshot is scaled to fit it, or encoding fails. */
const WEBP_MAX_SIDE = 16_383;
const FAILED_MAX = 512;

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
const inflight = new Map<string, Promise<ScaledImage | null>>();
const failed = new Set<string>();
const limit = createConcurrencyLimiter(SCALE_CONCURRENCY);

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
