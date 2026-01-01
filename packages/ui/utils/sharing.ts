/**
 * Portable sharing utilities for Plannotator
 *
 * Enables sharing plan + annotations via URL hash using:
 * - Native CompressionStream/DecompressionStream (deflate-raw)
 * - Base64url encoding for URL safety
 *
 * Inspired by textarea.my's approach.
 */

import { Annotation, AnnotationType } from '../types';

// Minimal shareable annotation format: [type, originalText, text?, author?]
export type ShareableAnnotation =
  | ['D', string, string | null]                    // Deletion: type, original, author
  | ['R', string, string, string | null]            // Replacement: type, original, replacement, author
  | ['C', string, string, string | null]            // Comment: type, original, comment, author
  | ['I', string, string, string | null]            // Insertion: type, context, new text, author
  | ['G', string, string | null];                   // Global Comment: type, comment, author

export interface SharePayload {
  p: string;  // plan markdown
  a: ShareableAnnotation[];
}

/**
 * Compress a SharePayload to a base64url string
 */
export async function compress(payload: SharePayload): Promise<string> {
  const json = JSON.stringify(payload);
  const byteArray = new TextEncoder().encode(json);

  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(byteArray);
  writer.close();

  const buffer = await new Response(stream.readable).arrayBuffer();
  const compressed = new Uint8Array(buffer);

  // Convert to base64url (URL-safe base64)
  const base64 = btoa(String.fromCharCode(...compressed));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decompress a base64url string back to SharePayload
 */
export async function decompress(b64: string): Promise<SharePayload> {
  // Restore standard base64
  const base64 = b64
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const binary = atob(base64);
  const byteArray = Uint8Array.from(binary, c => c.charCodeAt(0));

  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(byteArray);
  writer.close();

  const buffer = await new Response(stream.readable).arrayBuffer();
  const json = new TextDecoder().decode(buffer);

  return JSON.parse(json) as SharePayload;
}

/**
 * Convert full Annotation objects to minimal shareable format
 */
export function toShareable(annotations: Annotation[]): ShareableAnnotation[] {
  return annotations.map(ann => {
    const author = ann.author || null;

    // Handle GLOBAL_COMMENT specially - it starts with 'G' (from GLOBAL_COMMENT)
    if (ann.type === AnnotationType.GLOBAL_COMMENT) {
      return ['G', ann.text || '', author] as ShareableAnnotation;
    }

    const type = ann.type[0] as 'D' | 'R' | 'C' | 'I';

    if (type === 'D') {
      return ['D', ann.originalText, author] as ShareableAnnotation;
    }

    // R, C, I all have text
    return [type, ann.originalText, ann.text || '', author] as ShareableAnnotation;
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

    // Handle global comments specially: ['G', text, author]
    if (type === 'G') {
      const text = item[1] as string;
      const author = item[2] as string | null;

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
      };
    }

    const originalText = item[1];
    // For deletion: [type, original, author]
    // For others: [type, original, text, author]
    const text = type === 'D' ? undefined : item[2] as string;
    const author = type === 'D' ? item[2] as string | null : item[3] as string | null;

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
      // startMeta/endMeta will be set by web-highlighter
    };
  });
}

/**
 * Generate a full shareable URL from plan and annotations
 */
const SHARE_BASE_URL = 'https://share.plannotator.ai';

export async function generateShareUrl(
  markdown: string,
  annotations: Annotation[]
): Promise<string> {
  const payload: SharePayload = {
    p: markdown,
    a: toShareable(annotations),
  };

  const hash = await compress(payload);
  return `${SHARE_BASE_URL}/#${hash}`;
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
