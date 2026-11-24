import type { CodeAnnotation, ImageAttachment } from '@plannotator/ui/types';

/**
 * A file's comment (the header's Comment box): its words and what was
 * attached (pictures and files). A comment of attachments alone is a comment,
 * as the box lets it be saved; only a box with neither words nor attachments
 * makes none.
 */
export function newFileComment(input: {
  id: string;
  filePath: string;
  text: string;
  images?: readonly ImageAttachment[];
  createdAt: number;
  author?: string;
}): CodeAnnotation | null {
  const text = input.text.trim();
  const images = input.images?.length ? [...input.images] : undefined;
  if (!text && !images) return null;
  return {
    id: input.id,
    type: 'comment',
    scope: 'file',
    filePath: input.filePath,
    lineStart: 1,
    lineEnd: 1,
    side: 'new',
    ...(text ? { text } : {}),
    ...(images ? { images } : {}),
    createdAt: input.createdAt,
    author: input.author,
  };
}
