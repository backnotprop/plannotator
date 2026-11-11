/**
 * A comment's pictures (commentPictures.tsx) in what the window reads and the
 * agent reads: where one shows from before its Send, the uploads a Send
 * carries, and the feedback's lines naming each by the file it is attached as.
 */
import { inboxCommentPicture, inboxCommentPictureUploads, type InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { inboxUrl, machineOf } from './inboxUrl';

/** Where a comment's picture shows from before its Send, or null for any other path. */
export function commentPictureUrl(path: string): string | null {
  const picture = inboxCommentPicture(path);
  return picture ? inboxUrl(`/uploads/${picture.upload_id}/image`, undefined, machineOf(picture.upload_id)) : null;
}

/** The uploads the comments of one reply carry: its attachments, beside the reply box's files. */
export function commentPictureUploads(records: readonly InboxAnnotationRecord[]): string[] {
  return [...new Set(records.flatMap((record) => inboxCommentPictureUploads(record.annotation)))];
}

/** The file names the comments' pictures go as. */
export function pictureFileNames(records: readonly InboxAnnotationRecord[]): string[] {
  return records.flatMap((record) => {
    const images = (record.annotation as { images?: unknown }).images;
    return Array.isArray(images) ? images.flatMap((image) => inboxCommentPicture((image as { path?: unknown })?.path)?.file ?? []) : [];
  });
}

/** One reply's uploads: the reply box's files, then its comments' pictures. */
export function withPictures(uploads: readonly string[], records: readonly InboxAnnotationRecord[]): string[] {
  return [...new Set([...uploads, ...commentPictureUploads(records)])];
}

/** A comment for the feedback: each picture by the file it is attached as (Annotate's "- [name] `path`"). */
export function withPictureFiles<T extends { images?: ImageAttachment[] }>(annotation: T): T {
  if (!annotation.images?.some((image) => inboxCommentPicture(image.path))) return annotation;
  return { ...annotation, images: annotation.images.map((image) => ({ ...image, path: inboxCommentPicture(image.path)?.file ?? image.path })) };
}

/** Annotate's lines for a comment's pictures (ui parser.ts), for the Inbox's own sections (messages, global comments). */
export function pictureLines(annotation: Pick<Annotation, 'images'>): string {
  const images = withPictureFiles(annotation).images ?? [];
  if (images.length === 0) return '';
  return `**Attached images:**\n${images.map((image) => `- [${image.name}] \`${image.path}\``).join('\n')}\n`;
}
