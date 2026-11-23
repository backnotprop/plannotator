/**
 * Drawing on an image or a video frame (approval "inbox-markup-flow",
 * 2026-10-26): the ✓ adds the drawing to the reply at once, as its own
 * comment; words are optional and go onto that same comment.
 */
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { inboxCommentPicture } from '@plannotator/core/inbox-types';

/**
 * The words a drawing with none carries, for the agent: the feedback still
 * says it, while the window shows the drawing's picture in its place.
 */
export const MARKUP_ONLY_TEXT = 'See the marked-up image.';

/** A picture or file added to a comment (an upload, commentFiles.tsx), not a drawing or a film's frame (kept by path on this computer). */
export function isAddedToComment(image: ImageAttachment): boolean {
  return image.kind === 'file' || inboxCommentPicture(image.path) !== null;
}

/** The drawing on an image, or a film's frame, a comment carries: its first entry that is not a picture or file added to it. */
export function markupOf(annotation: Pick<Annotation, 'images'> | null | undefined): ImageAttachment | null {
  return annotation?.images?.find((image) => !isAddedToComment(image)) ?? null;
}

/** The pictures and files added to a comment (its uploads). */
export function addedToComment(annotation: Pick<Annotation, 'images'> | null | undefined): ImageAttachment[] {
  return annotation?.images?.filter(isAddedToComment) ?? [];
}

/** A comment that is only a drawing: a picture, and the stand-in words (or none). Pictures or files added to it make it a comment with them. */
export function isWordlessMarkup(annotation: Pick<Annotation, 'text' | 'images'> | null | undefined): boolean {
  if (!annotation?.images?.length || annotation.images.some(isAddedToComment)) return false;
  const text = (annotation.text ?? '').trim();
  return text === '' || text === MARKUP_ONLY_TEXT;
}

/** The words a comment carries: a drawing's stand-in when the person wrote none. */
export function markupWords(words: string, hasDrawing: boolean): string {
  const trimmed = words.trim();
  return trimmed || (hasDrawing ? MARKUP_ONLY_TEXT : '');
}

/**
 * A note from the comment box onto the comment the ✓ added, as the comment
 * reads NOW (it may have been edited in the panel meanwhile): the note replaces
 * the stand-in words, and follows words already there.
 */
export function noteOnto(current: Pick<Annotation, 'text' | 'images'>, words: string): string {
  const note = words.trim();
  if (!note) return current.text ?? '';
  return isWordlessMarkup(current) ? note : `${(current.text ?? '').trim()}\n\n${note}`;
}
