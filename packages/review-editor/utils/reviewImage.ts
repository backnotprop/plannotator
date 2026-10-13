/**
 * Client half of the code-review image preview (#1598): fetch one side of a
 * changed image from `/api/review-image` as a Blob, and keep a small LRU of
 * object URLs so scrolling back to a card does not refetch.
 *
 * Why `fetch` → Blob → `URL.createObjectURL` rather than `<img src=/api/…>`:
 * the JSON error reason stays readable, the request is abortable when a card
 * unmounts mid-scroll, and the byte size and a digest are known, which is what
 * "Contents unchanged" and the size delta are computed from. SVG is only ever
 * shown through `<img src=blob:…>`: no script, no external fetch, no DOM.
 */

export type ReviewImageSide = 'old' | 'new';

export interface ReviewImageData {
  url: string;
  bytes: number;
  contentType: string;
  /** SHA-256 of the bytes, hex; equal digests mean identical contents. */
  digest: string;
  /** From the server's header parse; the <img> fills these in otherwise. */
  width?: number;
  height?: number;
}

export interface ReviewImageError {
  status: number;
  /** Server reason (`not-image`, `too-large`, `lfs-pointer`, …) or `network`. */
  reason: string;
  bytes?: number;
  width?: number;
  height?: number;
}

export type ReviewImageResult =
  | { ok: true; image: ReviewImageData }
  | { ok: false; error: ReviewImageError };

const MAX_CACHED_IMAGES = 64;
/** Byte ceiling for the cache: 64 sides at the 10 MB cap would be 640 MB. */
export const MAX_CACHED_IMAGE_BYTES = 128 * 1024 * 1024;
const cache = new Map<string, ReviewImageData>();
let cachedBytes = 0;
let cachedSnapshot: string | undefined;
/**
 * Object URLs a mounted <img> is using. Eviction never revokes one of these
 * (the <img> may not have loaded it yet); the revoke waits for the release.
 */
const urlUsers = new Map<string, number>();
const pendingRevoke = new Set<string>();

const cacheKey = (snapshot: string, path: string, side: ReviewImageSide) => `${snapshot}|${side}|${path}`;

function revokeWhenUnused(url: string): void {
  if (urlUsers.has(url)) pendingRevoke.add(url);
  else URL.revokeObjectURL(url);
}

function dropEntry(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  cachedBytes -= entry.bytes;
  revokeWhenUnused(entry.url);
}

function revokeAll(): void {
  for (const key of [...cache.keys()]) dropEntry(key);
}

/**
 * Move the cache to `snapshot` when a request for it STARTS (switching back to
 * an earlier diff reuses its snapshot id, so that must stay allowed). A new
 * snapshot makes every cached side meaningless, so they are dropped. Responses
 * never move the cache: see the check in `fetchReviewImage`.
 */
function enterSnapshot(snapshot: string): void {
  if (cachedSnapshot === snapshot) return;
  revokeAll();
  cachedSnapshot = snapshot;
}

/**
 * Mark an object URL as in use by a mounted <img>. Returns the release
 * function; the URL is revoked on release if it was evicted meanwhile.
 */
export function retainReviewImageUrl(url: string): () => void {
  urlUsers.set(url, (urlUsers.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (urlUsers.get(url) ?? 1) - 1;
    if (count > 0) {
      urlUsers.set(url, count);
      return;
    }
    urlUsers.delete(url);
    if (pendingRevoke.delete(url)) URL.revokeObjectURL(url);
  };
}

/** Synchronous cache read, so a remounted card paints without a loading frame. */
export function peekReviewImage(
  snapshot: string,
  path: string,
  side: ReviewImageSide,
): ReviewImageData | undefined {
  if (cachedSnapshot !== snapshot) return undefined;
  const key = cacheKey(snapshot, path, side);
  const entry = cache.get(key);
  if (entry) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const numericHeader = (response: Response, name: string): number | undefined => {
  const value = Number(response.headers.get(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export async function fetchReviewImage(
  snapshot: string,
  path: string,
  side: ReviewImageSide,
  signal: AbortSignal,
): Promise<ReviewImageResult> {
  const cached = peekReviewImage(snapshot, path, side);
  if (cached) return { ok: true, image: cached };
  enterSnapshot(snapshot);

  const params = new URLSearchParams({ path, side, snapshot });
  let response: Response;
  try {
    response = await fetch(`/api/review-image?${params}`, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, error: { status: 0, reason: 'network' } };
  }
  if (!response.ok) {
    let body: Partial<ReviewImageError> = {};
    try {
      body = (await response.json()) as Partial<ReviewImageError>;
    } catch {
      // Non-JSON error body: the status alone has to do.
    }
    return {
      ok: false,
      error: {
        status: response.status,
        reason: typeof body.reason === 'string' ? body.reason : 'error',
        ...(typeof body.bytes === 'number' ? { bytes: body.bytes } : {}),
        ...(typeof body.width === 'number' ? { width: body.width } : {}),
        ...(typeof body.height === 'number' ? { height: body.height } : {}),
      },
    };
  }

  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const digest = await sha256Hex(buffer);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  // The page moved to a newer snapshot while this was in flight: its card is
  // gone, and caching it would evict the current snapshot's entries.
  if (cachedSnapshot !== snapshot) throw new DOMException('Superseded', 'AbortError');

  const image: ReviewImageData = {
    url: URL.createObjectURL(new Blob([buffer], { type: contentType })),
    bytes: buffer.byteLength,
    contentType,
    digest,
    width: numericHeader(response, 'x-image-width'),
    height: numericHeader(response, 'x-image-height'),
  };
  const key = cacheKey(snapshot, path, side);
  // Two fetches for the same side can overlap (a card remounting mid-fetch).
  // The first one's URL may already be on screen, so keep it and discard ours.
  const existing = cache.get(key);
  if (existing) {
    URL.revokeObjectURL(image.url);
    return { ok: true, image: existing };
  }
  cache.set(key, image);
  cachedBytes += image.bytes;
  // Evict least recently used first, by count and by bytes; the entry just
  // added always survives so the caller gets a live URL.
  while ((cache.size > MAX_CACHED_IMAGES || cachedBytes > MAX_CACHED_IMAGE_BYTES) && cache.size > 1) {
    dropEntry(cache.keys().next().value as string);
  }
  return { ok: true, image };
}

/** Test seam: drop every cached side. */
export function resetReviewImageCache(): void {
  revokeAll();
  cachedSnapshot = undefined;
}

/** Test seam: what the cache currently holds. */
export function reviewImageCacheStats(): { entries: number; bytes: number; snapshot?: string } {
  return { entries: cache.size, bytes: cachedBytes, snapshot: cachedSnapshot };
}

/** `12.4 KB`, `3.1 MB`, `512 B`. */
export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
