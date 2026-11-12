import type { Annotation } from '@plannotator/ui/types';

export const MARKUP_ONLY_TEXT = 'See the marked-up image.';

export function isWordlessMarkup(annotation: Pick<Annotation, 'text' | 'images'> | null | undefined): boolean {
  if (!annotation?.images?.length) return false;
  const text = (annotation.text ?? '').trim();
  return text === '' || text === MARKUP_ONLY_TEXT;
}

export function markupWords(words: string, hasDrawing: boolean): string {
  const trimmed = words.trim();
  return trimmed || (hasDrawing ? MARKUP_ONLY_TEXT : '');
}

export function noteOnto(current: Pick<Annotation, 'text' | 'images'>, words: string): string {
  const note = words.trim();
  if (!note) return current.text ?? '';
  return isWordlessMarkup(current) ? note : `${(current.text ?? '').trim()}\n\n${note}`;
}
