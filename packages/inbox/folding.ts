/**
 * Moved to @plannotator/core (packages/core/inbox-folding.ts) unchanged, so a host of the
 * shared thread parts reads the fold rules from core. This path re-exports it so every
 * existing import and test keeps working.
 */
import { firstWords } from '@plannotator/core/inbox-folding';

export * from '@plannotator/core/inbox-folding';

/** How many bodies `keptFirstWords` keeps: a long thread's, with room for the next one opened. */
const KEPT_MAX = 4000;
/** And how many characters, bodies and words together (about 8 MB as UTF-16): a few long plans cannot pin tens of MB. */
export const KEPT_CHARS_MAX = 4_000_000;
const kept = new Map<string, string>();
let keptChars = 0;

/** The characters `keptFirstWords` holds now, bodies and words together. */
export function keptFirstWordsChars(): number {
  return keptChars;
}

/**
 * `firstWords` with its defaults, kept per text (it reads the whole body). A long thread draws a folded line for
 * hundreds of messages on every refresh, so each body is read once, not on every render. Same answer: it is pure.
 * The oldest go first once either cap is reached; a body too long for the character cap alone is read and not kept.
 */
export function keptFirstWords(markdown: string): string {
  const hit = kept.get(markdown);
  if (hit !== undefined) return hit;
  const words = firstWords(markdown);
  const size = markdown.length + words.length;
  if (size > KEPT_CHARS_MAX) return words;
  while (kept.size > 0 && (kept.size >= KEPT_MAX || keptChars + size > KEPT_CHARS_MAX)) {
    const [oldest, oldWords] = kept.entries().next().value as [string, string];
    kept.delete(oldest);
    keptChars -= oldest.length + oldWords.length;
  }
  kept.set(markdown, words);
  keptChars += size;
  return words;
}
