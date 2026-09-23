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
const cache = new Map<string, ReviewImageData>();
let cachedSnapshot: string | undefined;

const cacheKey = (snapshot: string, path: string, side: ReviewImageSide) => `${snapshot}|${side}|${path}`;

function revokeAll(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
}

/** A new snapshot makes every cached side meaningless: drop and revoke them. */
function enterSnapshot(snapshot: string): void {
  if (cachedSnapshot === snapshot) return;
  revokeAll();
  cachedSnapshot = snapshot;
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

  enterSnapshot(snapshot);
  const image: ReviewImageData = {
    url: URL.createObjectURL(new Blob([buffer], { type: contentType })),
    bytes: buffer.byteLength,
    contentType,
    digest,
    width: numericHeader(response, 'x-image-width'),
    height: numericHeader(response, 'x-image-height'),
  };
  const key = cacheKey(snapshot, path, side);
  cache.set(key, image);
  while (cache.size > MAX_CACHED_IMAGES) {
    const oldest = cache.keys().next().value as string;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) URL.revokeObjectURL(evicted.url);
  }
  return { ok: true, image };
}

/** Test seam: drop every cached side. */
export function resetReviewImageCache(): void {
  revokeAll();
  cachedSnapshot = undefined;
}

/** `12.4 KB`, `3.1 MB`, `512 B`. */
export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
