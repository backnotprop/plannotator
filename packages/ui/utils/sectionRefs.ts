/**
 * `#Heading` references inside annotation text.
 *
 * Typing `#` followed by a heading's exact text links to that heading. Only
 * headings in the current document resolve, so `#123`, `#fff` or a URL
 * fragment stay plain text unless a heading is literally named that way.
 */

import { buildHeadingSlugMap } from './slugify';
import { transformPlainText } from './inlineTransforms';

export interface SectionRefSegment {
  /** The heading text, shown as the link label. */
  label: string;
  /** The heading's anchor id in the rendered document. */
  anchor: string;
}

export type SectionRefPart = string | SectionRefSegment;

/** A heading's text without its inline markdown syntax. */
function stripHeadingMarkdown(content: string): string {
  return content
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '');
}

/**
 * Heading text → anchor id. Each heading is indexed under its markdown source
 * (`**Don't** ship`), the text the page shows (`Don’t ship`), and that text as
 * typed with straight quotes (`Don't ship`). A title that two different
 * headings share is left out: it could mean either.
 */
export function buildSectionRefIndex(
  blocks: Array<{ id: string; type: string; content: string }>,
): Map<string, string> {
  const slugs = buildHeadingSlugMap(blocks);
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();

  const register = (title: string, anchor: string) => {
    const key = title.trim();
    if (!key) return;
    const existing = index.get(key);
    if (existing === undefined) index.set(key, anchor);
    else if (existing !== anchor) ambiguous.add(key);
  };

  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const anchor = slugs.get(block.id);
    if (!anchor) continue;
    const stripped = stripHeadingMarkdown(block.content);
    register(block.content, anchor);
    register(stripped, anchor);
    register(transformPlainText(stripped), anchor);
  }

  for (const title of ambiguous) index.delete(title);
  return index;
}

// A reference starts a word: at the start, after whitespace, or after an
// opening bracket or quote. This keeps `C#`, `issue#4` and `page/#intro` plain.
const REF_START = /[\s([{"'“‘「]/u;
const SPACED_WORD = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}_]/u;

function matchAt(text: string, hash: number, titles: string[]): string | null {
  // `# Title` is a markdown heading, not a reference.
  if (hash + 1 >= text.length || /\s/.test(text[hash + 1]!)) return null;
  // Longest first, so `#3.1 Scope` beats a sibling heading named `3.1`.
  for (const title of titles) {
    if (!text.startsWith(title, hash + 1)) continue;
    // `#Intro` must not link inside `#Introduction`. Only scripts that space
    // their words need the boundary: elsewhere a suffix follows the title directly.
    const end = hash + 1 + title.length;
    const next = text.slice(end, end + 2).match(/^./su)?.[0];
    const last = title.match(/.$/su)?.[0];
    if (next && last && SPACED_WORD.test(next) && SPACED_WORD.test(last)) continue;
    return title;
  }
  return null;
}

/**
 * Split annotation text into plain runs and `#Heading` references. Returns
 * `[text]` when nothing resolves. Text inside backticks is never linked.
 */
export function parseSectionRefs(text: string, index: Map<string, string>): SectionRefPart[] {
  if (!text || index.size === 0 || !text.includes('#')) return [text];

  const titles = [...index.keys()].sort((a, b) => b.length - a.length);
  const parts: SectionRefPart[] = [];
  let plain = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    const close = ch === '`' ? text.indexOf('`', i + 1) : -1;
    if (close !== -1) {
      plain += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    const title =
      ch === '#' && (i === 0 || REF_START.test(text[i - 1]!))
        ? matchAt(text, i, titles)
        : null;
    if (!title) {
      plain += ch;
      i += 1;
      continue;
    }
    if (plain) parts.push(plain);
    plain = '';
    parts.push({ label: title, anchor: index.get(title)! });
    i += 1 + title.length;
  }

  if (plain) parts.push(plain);
  return parts.some((p) => typeof p !== 'string') ? parts : [text];
}
