import type { ImageAttachment } from "../types";

export function hasUnsavedCommentContent(
  text: string,
  images: readonly ImageAttachment[] = [],
): boolean {
  return text.trim().length > 0 || images.length > 0;
}
