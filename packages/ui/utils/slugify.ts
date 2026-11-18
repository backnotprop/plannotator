import { footnoteKeysOf, withoutFootnoteRefs } from './footnotes';

/**
 * Convert heading text into a URL-safe anchor id.
 * Strips common inline markdown so `**Install** \`bun\`` → `install-bun`.
 * Preserves unicode letters (e.g. "Café" → "café").
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a blockId → anchor-id map for all headings in the doc, applying
 * GitHub's dedup convention: repeated slugs become `slug-1`, `slug-2`, etc.
 * First occurrence keeps the bare slug so stable links don't shift when a
 * later duplicate is added.
 */
export function buildHeadingSlugMap(
  blocks: Array<{ id: string; type: string; content: string; footnoteLabel?: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  const counts = new Map<string, number>();
  // A reference to a note is not part of the heading's name (`Title[^1]` is `#title`).
  const notes = footnoteKeysOf(blocks);
  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const base = slugifyHeading(withoutFootnoteRefs(block.content, notes));
    if (!base) continue;
    const n = counts.get(base) ?? 0;
    const slug = n === 0 ? base : `${base}-${n}`;
    counts.set(base, n + 1);
    map.set(block.id, slug);
  }
  return map;
}
