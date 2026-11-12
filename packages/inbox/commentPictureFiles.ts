import { inboxCommentPicture, inboxCommentPictureUploads, type InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { inboxUrl, machineOf } from './inboxUrl';

export function commentPictureUrl(path: string): string | null {
  const picture = inboxCommentPicture(path);
  return picture ? inboxUrl(`/uploads/${picture.upload_id}/image`, undefined, machineOf(picture.upload_id)) : null;
}

export function commentPictureUploads(records: readonly InboxAnnotationRecord[]): string[] {
  return [...new Set(records.flatMap((record) => inboxCommentPictureUploads(record.annotation)))];
}

export function pictureFileNames(records: readonly InboxAnnotationRecord[]): string[] {
  return records.flatMap((record) => {
    const images = (record.annotation as { images?: unknown }).images;
    return Array.isArray(images) ? images.flatMap((image) => inboxCommentPicture((image as { path?: unknown })?.path)?.file ?? []) : [];
  });
}

export function withPictures(uploads: readonly string[], records: readonly InboxAnnotationRecord[]): string[] {
  return [...new Set([...uploads, ...commentPictureUploads(records)])];
}

export function withPictureFiles<T extends { images?: ImageAttachment[] }>(annotation: T): T {
  if (!annotation.images?.some((image) => inboxCommentPicture(image.path))) return annotation;
  return { ...annotation, images: annotation.images.map((image) => ({ ...image, path: inboxCommentPicture(image.path)?.file ?? image.path })) };
}

export function pictureLines(annotation: Pick<Annotation, 'images'>): string {
  const images = withPictureFiles(annotation).images ?? [];
  if (images.length === 0) return '';
  return `**Attached images:**\n${images.map((image) => `- [${image.name}] \`${image.path}\``).join('\n')}\n`;
}
