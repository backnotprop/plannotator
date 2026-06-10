import type { ImageAttachment } from '../types';

export function hasUnsavedContent(text: string, images: ImageAttachment[]): boolean {
  return text.trim().length > 0 || images.length > 0;
}
