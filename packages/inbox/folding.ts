/**
 * Moved to @plannotator/core (packages/core/inbox-folding.ts) unchanged, so a host of the
 * shared thread parts reads the fold rules from core. This path re-exports it so every
 * existing import and test keeps working.
 */
import { firstWords } from '@plannotator/core/inbox-folding';

export * from '@plannotator/core/inbox-folding';

/** How many bodies `keptFirstWords` keeps: a long thread's, with room for the next one opened. */
const KEPT_MAX = 4000;
const kept = new Map<string, string>();

/**
 * `firstWords` with its defaults, kept per text (it reads the whole body). A long thread draws a folded line for
 * hundreds of messages on every refresh, so each body is read once, not on every render. Same answer: it is pure.
 */
export function keptFirstWords(markdown: string): string {
  const hit = kept.get(markdown);
  if (hit !== undefined) return hit;
  const words = firstWords(markdown);
  if (kept.size >= KEPT_MAX) kept.delete(kept.keys().next().value as string);
  kept.set(markdown, words);
  return words;
}
