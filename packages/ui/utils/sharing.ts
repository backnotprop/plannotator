import { AnnotationType, type Annotation, type DocumentRenderAs, type ImageAttachment } from '../types';
import { isDiagramRenderKind } from '@plannotator/core/annotatable';
import { compress, decompress } from '@plannotator/core/compress';
import { encrypt, decrypt } from '@plannotator/core/crypto';

type ShareableImage = string | [string, string];

export type ShareableAnnotation =
  | ['D', string, string | null, ShareableImage[]?]
  | ['C', string, string, string | null, ShareableImage[]?, (1)?, string?]
  | ['G', string, string | null, ShareableImage[]?];

export interface SharePayload {
  p: string;
  a: ShareableAnnotation[];
  g?: ShareableImage[];
  d?: (string | null)[];
  s?: (string | undefined)[];
  h?: string;
  r?: 'html' | 'asciidoc';
}

export function shareableDocumentMarkdown(
  markdown: string,
  renderAs: DocumentRenderAs | undefined,
): string {
  if (!isDiagramRenderKind(renderAs) || markdown === '') return markdown;
  const language = renderAs === 'graphviz' ? 'dot' : 'mermaid';
  const fence = markdown.includes('```') ? '````' : '```';
  return `${fence}${language}\n${markdown.replace(/\n+$/, '')}\n${fence}`;
}

export function parseShareableImages(raw: ShareableImage[] | undefined): ImageAttachment[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map(img => {
    if (typeof img === 'string') {
      const name = img.split('/').pop()?.replace(/\.[^.]+$/, '') || 'image';
      return { path: img, name };
    }
    return { path: img[0], name: img[1] };
  });
}

export function toShareableImages(images: ImageAttachment[] | undefined): ShareableImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map(img => [img.path, img.name]);
}

export { compress, decompress };

export function toShareable(annotations: Annotation[]): ShareableAnnotation[] {
  return annotations.map(ann => {
    const author = ann.author || null;
    const images = toShareableImages(ann.images);

    if (ann.type === AnnotationType.GLOBAL_COMMENT) {
      return ['G', ann.text || '', author, images] as ShareableAnnotation;
    }

    if (ann.type === AnnotationType.DELETION) {
      return ['D', ann.originalText, author, images] as ShareableAnnotation;
    }

    if (ann.isQuickLabel) {
      if (ann.quickLabelTip) {
        return ['C', ann.originalText, ann.text || '', author, images ?? undefined, 1, ann.quickLabelTip] as ShareableAnnotation;
      }
      return ['C', ann.originalText, ann.text || '', author, images ?? undefined, 1] as ShareableAnnotation;
    }
    return ['C', ann.originalText, ann.text || '', author, images] as ShareableAnnotation;
  });
}

export function fromShareable(data: ShareableAnnotation[], diffContexts?: (string | null)[] | null, sources?: (string | undefined)[] | null): Annotation[] {
  const typeMap: Record<string, AnnotationType> = {
    'D': AnnotationType.DELETION,
    'C': AnnotationType.COMMENT,
    'G': AnnotationType.GLOBAL_COMMENT,
  };

  return data.map((item, index) => {
    const type = item[0];

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
        ...(sources?.[index] ? { source: sources[index] } : {}),
      };
    }

    const originalText = item[1];
    const text = type === 'D' ? undefined : item[2] as string;
    const author = type === 'D' ? item[2] as string | null : item[3] as string | null;
    const rawImages = type === 'D' ? item[3] as ShareableImage[] | undefined : item[4] as ShareableImage[] | undefined;
    const isQuickLabel = type === 'C' && item.length > 5 && item[5] === 1 ? true : undefined;
    const quickLabelTip = isQuickLabel && typeof item[6] === 'string' && item[6] ? item[6] : undefined;

    return {
      id: `shared-${index}-${Date.now()}`,
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: typeMap[type],
      text: text || undefined,
      originalText,
      createdA: Date.now() + index,
      author: author || undefined,
      images: parseShareableImages(rawImages),
      ...(isQuickLabel ? { isQuickLabel } : {}),
      ...(quickLabelTip ? { quickLabelTip } : {}),
      ...(diffContexts?.[index] ? { diffContext: diffContexts[index] as Annotation['diffContext'] } : {}),
      ...(sources?.[index] ? { source: sources[index] } : {}),
    };
  });
}

function buildDiffContextArray(annotations: Annotation[]): (string | null)[] | null {
  const arr = annotations.map(a => a.diffContext || null);
  return arr.some(v => v !== null) ? arr : null;
}

function buildSourceArray(annotations: Annotation[]): (string | undefined)[] | null {
  const arr = annotations.map(a => a.source || undefined);
  return arr.some(v => v !== undefined) ? arr : null;
}

export async function generateShareUrl(
  markdown: string,
  annotations: Annotation[],
  globalAttachments?: ImageAttachment[],
  baseUrl: string = DEFAULT_SHARE_BASE,
  rawHtml?: string,
  renderAs?: DocumentRenderAs,
): Promise<string | null> {
  if (rawHtml) return null;
  const diffContexts = buildDiffContextArray(annotations);
  const sources = buildSourceArray(annotations);
  const payload: SharePayload = {
    p: markdown,
    a: toShareable(annotations),
    g: globalAttachments?.length ? toShareableImages(globalAttachments) : undefined,
    ...(diffContexts ? { d: diffContexts } : {}),
    ...(sources ? { s: sources } : {}),
    ...(renderAs === 'asciidoc' ? { r: 'asciidoc' as const } : {}),
  };

  const hash = await compress(payload);
  return `${baseUrl}/#${hash}`;
}

export async function parseShareHash(): Promise<SharePayload | null> {
  const raw = window.location.hash.slice(1);
  const hash = raw.split('?')[0];

  if (!hash) {
    return null;
  }

  try {
    return (await decompress(hash)) as SharePayload;
  } catch (e) {
    console.warn('Failed to parse share hash:', e);
    return null;
  }
}

export function formatUrlSize(url: string): string {
  const bytes = new Blob([url]).size;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const DEFAULT_PASTE_API = 'https://plannotator-paste.plannotator.workers.dev';
const DEFAULT_SHARE_BASE = 'https://share.plannotator.ai';

export class ShortShareUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortShareUrlError';
  }
}

export async function createShortShareUrl(
  markdown: string,
  annotations: Annotation[],
  globalAttachments?: ImageAttachment[],
  options?: {
    pasteApiUrl?: string;
    shareBaseUrl?: string;
  },
  rawHtml?: string,
  renderAs?: DocumentRenderAs,
): Promise<{ shortUrl: string; id: string } | null> {
  const pasteApi = options?.pasteApiUrl ?? DEFAULT_PASTE_API;
  const shareBase = options?.shareBaseUrl ?? DEFAULT_SHARE_BASE;

  try {
    const diffContexts = buildDiffContextArray(annotations);
    const sources = buildSourceArray(annotations);
    const payload: SharePayload = {
      p: markdown,
      a: toShareable(annotations),
      g: globalAttachments?.length ? toShareableImages(globalAttachments) : undefined,
      ...(diffContexts ? { d: diffContexts } : {}),
      ...(sources ? { s: sources } : {}),
      ...(rawHtml ? { h: rawHtml, r: 'html' as const } : renderAs === 'asciidoc' ? { r: 'asciidoc' as const } : {}),
    };

    const compressed = await compress(payload);

    const { ciphertext, key } = await encrypt(compressed);

    const response = await fetch(`${pasteApi}/api/paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: ciphertext }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      if (response.status === 413) {
        throw new ShortShareUrlError(await readPasteError(response, 'Share payload is too large'));
      }
      console.warn(`[sharing] Paste service returned ${response.status}`);
      return null;
    }

    const result = (await response.json()) as { id: string };
    const pasteParam = pasteApi !== DEFAULT_PASTE_API
      ? `&paste=${btoa(pasteApi).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`
      : '';
    const shortUrl = `${shareBase}/p/${result.id}#key=${key}${pasteParam}`;

    return { shortUrl, id: result.id };
  } catch (e) {
    if (e instanceof ShortShareUrlError) {
      throw e;
    }
    return null;
  }
}

async function readPasteError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export async function loadFromPasteId(
  pasteId: string,
  pasteApiUrl: string = DEFAULT_PASTE_API,
  encryptionKey?: string
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

    if (encryptionKey) {
      const compressed = await decrypt(result.data, encryptionKey);
      return await decompress(compressed) as SharePayload;
    }

    return await decompress(result.data) as SharePayload;
  } catch (e) {
    console.warn('[sharing] Failed to load from paste ID:', e);
    return null;
  }
}
