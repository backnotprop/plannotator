/**
 * Portable sharing utilities for Plannotator
 *
 * Enables sharing plan + annotations via URL hash using:
 * - Native CompressionStream/DecompressionStream (deflate-raw)
 * - Base64url encoding for URL safety
 *
 * Inspired by textarea.my's approach.
 */

import { Annotation, AnnotationType, type ImageAttachment } from '../types';
import { compress, decompress } from '@plannotator/shared/compress';

// Image in shareable format: plain string (old) or [path, name] tuple (new)
type ShareableImage = string | [string, string];

// Minimal shareable annotation format: [type, originalText, text?, author?, images?]
export type ShareableAnnotation =
  | ['D', string, string | null, ShareableImage[]?]             // Deletion: type, original, author, images
  | ['R', string, string, string | null, ShareableImage[]?]     // Replacement: type, original, replacement, author, images
  | ['C', string, string, string | null, ShareableImage[]?]     // Comment: type, original, comment, author, images
  | ['I', string, string, string | null, ShareableImage[]?]     // Insertion: type, context, new text, author, images
  | ['G', string, string | null, ShareableImage[]?];            // Global Comment: type, comment, author, images

export interface SharePayload {
  p: string;  // plan markdown
  a: ShareableAnnotation[];
  g?: ShareableImage[];  // global attachments (path strings or [path, name] tuples)
}

/**
 * Convert ShareableImage[] to ImageAttachment[] (handles old plain-string format)
 */
export function parseShareableImages(raw: ShareableImage[] | undefined): ImageAttachment[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map(img => {
    if (typeof img === 'string') {
      // Old format: plain path string — derive name from filename
      const name = img.split('/').pop()?.replace(/\.[^.]+$/, '') || 'image';
      return { path: img, name };
    }
    return { path: img[0], name: img[1] };
  });
}

/**
 * Convert ImageAttachment[] to ShareableImage[] for compact serialization
 */
export function toShareableImages(images: ImageAttachment[] | undefined): ShareableImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map(img => [img.path, img.name]);
}

// Re-export compress/decompress from shared package (single source of truth)
export { compress, decompress };

/**
 * Convert full Annotation objects to minimal shareable format
 */
export function toShareable(annotations: Annotation[]): ShareableAnnotation[] {
  return annotations.map(ann => {
    const author = ann.author || null;
    const images = toShareableImages(ann.images);

    // Handle GLOBAL_COMMENT specially - it starts with 'G' (from GLOBAL_COMMENT)
    if (ann.type === AnnotationType.GLOBAL_COMMENT) {
      return ['G', ann.text || '', author, images] as ShareableAnnotation;
    }

    const type = ann.type[0] as 'D' | 'R' | 'C' | 'I';

    if (type === 'D') {
      return ['D', ann.originalText, author, images] as ShareableAnnotation;
    }

    // R, C, I all have text
    return [type, ann.originalText, ann.text || '', author, images] as ShareableAnnotation;
  });
}

/**
 * Convert shareable format back to full Annotation objects
 * Note: blockId, offsets, and meta will need to be populated separately
 * by finding the text in the rendered document.
 */
export function fromShareable(data: ShareableAnnotation[]): Annotation[] {
  const typeMap: Record<string, AnnotationType> = {
    'D': AnnotationType.DELETION,
    'R': AnnotationType.REPLACEMENT,
    'C': AnnotationType.COMMENT,
    'I': AnnotationType.INSERTION,
    'G': AnnotationType.GLOBAL_COMMENT,
  };

  return data.map((item, index) => {
    const type = item[0];

    // Handle global comments specially: ['G', text, author, images?]
    if (type === 'G') {
      const text = item[1] as string;
      const author = item[2] as string | null;
      const rawImages = item[3] as ShareableImage[] | undefined;

      return {
        id: `shared-${index}-${Date.now()}`,
        blockId: '',
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.GLOBAL_COMMENT,
        text: text || undefined,
        originalText: '',
        createdA: Date.now() + index,
        author: author || undefined,
        images: parseShareableImages(rawImages),
      };
    }

    const originalText = item[1];
    // For deletion: [type, original, author, images?]
    // For others: [type, original, text, author, images?]
    const text = type === 'D' ? undefined : item[2] as string;
    const author = type === 'D' ? item[2] as string | null : item[3] as string | null;
    const rawImages = type === 'D' ? item[3] as ShareableImage[] | undefined : item[4] as ShareableImage[] | undefined;

    return {
      id: `shared-${index}-${Date.now()}`,
      blockId: '',  // Will be populated during highlight restoration
      startOffset: 0,
      endOffset: 0,
      type: typeMap[type],
      text: text || undefined,
      originalText,
      createdA: Date.now() + index,  // Preserve order
      author: author || undefined,
      images: parseShareableImages(rawImages),
      // startMeta/endMeta will be set by web-highlighter
    };
  });
}

/**
 * Generate a full shareable URL from plan and annotations
 */
export async function generateShareUrl(
  markdown: string,
  annotations: Annotation[],
  globalAttachments?: ImageAttachment[],
  baseUrl: string = DEFAULT_SHARE_BASE
): Promise<string> {
  const payload: SharePayload = {
    p: markdown,
    a: toShareable(annotations),
    g: globalAttachments?.length ? toShareableImages(globalAttachments) : undefined,
  };

  const hash = await compress(payload);
  return `${baseUrl}/#${hash}`;
}

/**
 * Parse a share URL hash and return the payload
 * Returns null if no valid hash or parsing fails
 */
export async function parseShareHash(): Promise<SharePayload | null> {
  const hash = window.location.hash.slice(1); // Remove leading #

  if (!hash) {
    return null;
  }

  try {
    return await decompress(hash);
  } catch (e) {
    console.warn('Failed to parse share hash:', e);
    return null;
  }
}

/**
 * Get the size of a URL in a human-readable format
 */
export function formatUrlSize(url: string): string {
  const bytes = new Blob([url]).size;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------
// Short URL support (paste-service backed)
// ---------------------------------------------------------------------------

const DEFAULT_PASTE_API = 'https://paste.plannotator.ai';
const DEFAULT_SHARE_BASE = 'https://share.plannotator.ai';

/**
 * Create a short share URL by posting compressed plan data to the paste service.
 *
 * Returns `{ shortUrl, id }` on success, or `null` when the paste service is
 * unavailable (e.g. self-hosted environments without a paste backend). Callers
 * should fall back to the hash-based URL in that case.
 *
 * The request has a 5-second timeout so UI responsiveness is not affected.
 */
export async function createShortShareUrl(
  markdown: string,
  annotations: Annotation[],
  globalAttachments?: ImageAttachment[],
  options?: {
    /** Override the paste API base URL (default: https://paste.plannotator.ai) */
    pasteApiUrl?: string;
    /** Override the share site base URL used in the returned short link */
    shareBaseUrl?: string;
  }
): Promise<{ shortUrl: string; id: string } | null> {
  const pasteApi = options?.pasteApiUrl ?? DEFAULT_PASTE_API;
  const shareBase = options?.shareBaseUrl ?? DEFAULT_SHARE_BASE;

  try {
    const payload: SharePayload = {
      p: markdown,
      a: toShareable(annotations),
      g: globalAttachments?.length ? toShareableImages(globalAttachments) : undefined,
    };

    const compressed = await compress(payload);

    const response = await fetch(`${pasteApi}/api/paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: compressed }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      console.warn(`[sharing] Paste service returned ${response.status}`);
      return null;
    }

    const result = (await response.json()) as { id: string };
    const shortUrl = `${shareBase}/p/${result.id}`;

    return { shortUrl, id: result.id };
  } catch (e) {
    // Service unavailable — expected for self-hosted setups without a paste backend.
    // The caller is responsible for falling back to hash-based sharing silently.
    console.debug('[sharing] Short URL service unavailable, using hash-based sharing:', e);
    return null;
  }
}

/**
 * Load plan data from a paste service using the paste ID embedded in a short URL.
 *
 * Fetches the compressed payload from `<pasteApiUrl>/api/paste/<pasteId>` and
 * decompresses it into a `SharePayload`. Returns `null` on any failure.
 */
export async function loadFromPasteId(
  pasteId: string,
  pasteApiUrl: string = DEFAULT_PASTE_API
): Promise<SharePayload | null> {
  try {
    const response = await fetch(`${pasteApiUrl}/api/paste/${pasteId}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[sharing] Paste fetch returned ${response.status} for id ${pasteId}`);
      return null;
    }

    const result = (await response.json()) as { data: string };
    return await decompress(result.data);
  } catch (e) {
    console.warn('[sharing] Failed to load from paste ID:', e);
    return null;
  }
}
