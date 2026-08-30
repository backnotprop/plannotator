/**
 * Section references inside annotation text.
 *
 * An annotation that says "this contradicts 3.1" forces the reader to go find
 * 3.1 by hand — the exact cross-referencing cost the annotation surface exists
 * to remove. Writing `#3.1 Single source of truth` instead makes the reference
 * a link to that heading.
 *
 * The document defines the vocabulary: only text that exactly matches a heading
 * in THIS document resolves. There is no grammar of section numbers to get
 * wrong, and `#fff` / `#123` / `C#` stay plain text unless a heading is
 * literally named `fff` / `123`.
 */

import { buildHeadingSlugMap } from './slugify';

export interface SectionRefSegment {
  /** The heading text, rendered as the link label. */
  label: string;
  /** Anchor id to navigate to, matching the heading's rendered element id. */
  anchor: string;
}

export type SectionRefPart = string | SectionRefSegment;

/**
 * heading content → anchor id, for headings whose text is unambiguous.
 *
 * A title used by two headings is dropped rather than resolved to the first:
 * a reference that could mean either is not a reference.
 */
export function buildSectionRefIndex(
  blocks: Array<{ id: string; type: string; content: string }>,
): Map<string, string> {
  const slugs = buildHeadingSlugMap(blocks);
  const index = new Map<string, string>();
  const duplicated = new Set<string>();

  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const title = block.content.trim();
    const anchor = slugs.get(block.id);
    if (!title || !anchor) continue;
    if (index.has(title)) {
      duplicated.add(title);
      continue;
    }
    index.set(title, anchor);
  }

  for (const title of duplicated) index.delete(title);
  return index;
}

/** Backtick-delimited spans are quoted material, never markup. */
function splitOnCodeSpans(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const pattern = /`[^`]*`/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push({ code: false, text: text.slice(last, match.index) });
    parts.push({ code: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

function matchAt(segment: string, start: number, titles: string[]): string | null {
  // `# heading` is someone writing a markdown heading, not a reference.
  if (segment[start + 1] === undefined || /\s/.test(segment[start + 1]!)) return null;
  // Longest first, so `#3.1 Scope` never resolves to a shorter `#3.1` sibling.
  for (const title of titles) {
    if (segment.startsWith(title, start + 1)) return title;
  }
  return null;
}

/**
 * Split annotation text into plain runs and resolved section references.
 *
 * Returns a single-element array of the original text when nothing resolves,
 * so callers can render the common case without special-casing.
 */
export function parseSectionRefs(
  text: string,
  index: Map<string, string>,
): SectionRefPart[] {
  if (!text || index.size === 0 || !text.includes('#')) return [text];

  // Longest-first is what makes the scan greedy; ties are irrelevant since
  // equal-length distinct titles cannot both match at one position.
  const titles = [...index.keys()].sort((a, b) => b.length - a.length);
  const parts: SectionRefPart[] = [];
  let pending = '';

  const flush = () => {
    if (pending) {
      parts.push(pending);
      pending = '';
    }
  };

  for (const segment of splitOnCodeSpans(text)) {
    if (segment.code) {
      pending += segment.text;
      continue;
    }

    let i = 0;
    while (i < segment.text.length) {
      if (segment.text[i] !== '#') {
        pending += segment.text[i];
        i += 1;
        continue;
      }
      // `C#`, `issue#4` — a `#` welded to a word is part of that word.
      const previous = i > 0 ? segment.text[i - 1]! : (pending.slice(-1) || '');
      if (/[\p{L}\p{N}_]/u.test(previous)) {
        pending += segment.text[i];
        i += 1;
        continue;
      }

      const title = matchAt(segment.text, i, titles);
      if (!title) {
        pending += segment.text[i];
        i += 1;
        continue;
      }

      flush();
      parts.push({ label: title, anchor: index.get(title)! });
      i += 1 + title.length;
    }
  }

  flush();
  return parts.length > 0 ? parts : [text];
}
