/**
 * What a host needs to lay out a question's picture choices before any picture
 * loads: each picture's shape (from its size in pixels, when the host knows it),
 * the set's shape, and how long the longest choice's words run. The tile grid
 * writes these as data attributes (`[data-question-tiles-*]`,
 * `[data-question-tile-shape]`); the Plannotator Inbox draws its layout from
 * them in CSS. Pure, no DOM.
 */

/** A picture's size in pixels, as the host recorded it (the Inbox: when the message was sent). */
export interface QuestionPictureSize {
  width: number;
  height: number;
}

/**
 * - `pano`: three or more times as wide as tall (a terminal strip).
 * - `wide`: a laptop screenshot.
 * - `square`: about as wide as tall.
 * - `tall`: a phone screenshot.
 * - `scroll`: a full-page capture, much taller than a phone screen.
 */
export type QuestionPictureShape = 'pano' | 'wide' | 'square' | 'tall' | 'scroll';

/** A set of pictures: all tall (phone screenshots, scrolls), all panoramas, all wide (or square, or of unknown size), or a mix. */
export type QuestionPicturesShape = 'tall' | 'pano' | 'wide' | 'mixed';

/** How long the longest choice's words run, in columns of drawn text. */
export type QuestionChoiceWords = 'short' | 'medium' | 'long' | 'essay';

export function readQuestionPictureSize(size: { width?: unknown; height?: unknown } | null | undefined): QuestionPictureSize | null {
  const width = size?.width;
  const height = size?.height;
  return typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

export function questionPictureShape(size: QuestionPictureSize): QuestionPictureShape {
  const ratio = size.width / size.height;
  if (ratio >= 3) return 'pano';
  if (ratio >= 1.25) return 'wide';
  if (ratio > 0.8) return 'square';
  // A phone screenshot is about 0.46 (9 by 19.5); a full-page capture is far narrower.
  if (ratio >= 0.4) return 'tall';
  return 'scroll';
}

/** The set's shape. A picture of unknown size counts as wide: it gets the default box. */
export function questionPicturesShape(shapes: readonly (QuestionPictureShape | null)[]): QuestionPicturesShape {
  if (shapes.length === 0) return 'wide';
  const kinds = new Set(shapes.map((shape) => (shape === 'tall' || shape === 'scroll' ? 'tall' : shape === 'pano' ? 'pano' : 'wide')));
  return kinds.size === 1 ? [...kinds][0]! : 'mixed';
}

/** Two columns for CJK, Hangul, full-width forms and emoji, else one (as an Inbox thread's subject counts them). */
function charColumns(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

/**
 * How many columns a choice's inline markdown takes once drawn: an image draws
 * no words, a link only its text, an HTML tag and the marks around code and
 * emphasis nothing.
 */
export function drawnTextColumns(markdown: string): number {
  const drawn = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__|~~|`+|\*)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let columns = 0;
  for (const char of drawn) columns += charColumns(char);
  return columns;
}

export function questionChoiceWords(choices: readonly { label: string; description?: string | null }[]): QuestionChoiceWords {
  const longest = Math.max(0, ...choices.map((c) => drawnTextColumns(c.label) + drawnTextColumns(c.description ?? '')));
  return longest > 400 ? 'essay' : longest > 240 ? 'long' : longest > 90 ? 'medium' : 'short';
}
