import type { Block, Annotation, CodeAnnotation, EditorAnnotation, ImageAttachment } from '../types';
import { planDenyFeedback } from '@plannotator/core/feedback-templates';
import { skillReferenceExportBlock } from './skillReferences';

/**
 * Parsed YAML frontmatter as key-value pairs.
 */
export interface Frontmatter {
  [key: string]: string | string[];
}

/** Number of leading whitespace characters on a line. */
function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

/** Strip the common leading indentation shared by all non-empty lines. */
function dedentLines(lines: string[]): string[] {
  const indents = lines.filter((l) => l !== '').map(indentWidth);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l === '' ? '' : l.slice(minIndent)));
}

/**
 * Fold YAML `>`-style scalar lines: adjacent non-empty lines join with a
 * single space, and a run of N blank lines between paragraphs folds to N
 * newlines.
 */
function foldScalarLines(lines: string[]): string {
  let text = '';
  let started = false;
  let blanks = 0;
  for (const l of lines) {
    if (l === '') {
      blanks++;
      continue;
    }
    if (!started) {
      text = l;
      started = true;
    } else {
      text += blanks > 0 ? '\n'.repeat(blanks) : ' ';
      text += l;
    }
    blanks = 0;
  }
  return text;
}

/**
 * Parse a YAML block scalar (`|` literal keeps newlines / `>` folded joins
 * with spaces) whose body is the run of lines below `bodyStart` indented
 * deeper than `keyIndent`. Trailing blank lines are dropped and chomping
 * indicators are treated as strip. Returns the value and the index of the
 * last line the scalar consumed.
 */
function parseBlockScalar(
  lines: string[],
  bodyStart: number,
  keyIndent: number,
  folded: boolean,
): { value: string; endIndex: number } {
  const body: string[] = [];
  let j = bodyStart;
  for (; j < lines.length; j++) {
    // CRLF sources split on '\n' leave a trailing '\r' that would otherwise
    // survive into the folded value (every other parser path trims lines).
    const bodyLine = lines[j].replace(/\r$/, '');
    if (bodyLine.trim() === '') {
      body.push('');
      continue;
    }
    if (indentWidth(bodyLine) <= keyIndent) break; // dedent ends the block
    body.push(bodyLine);
  }
  const dedented = dedentLines(body);
  while (dedented.length && dedented[dedented.length - 1] === '') dedented.pop();
  const value = (folded ? foldScalarLines(dedented) : dedented.join('\n')).trim();
  return { value, endIndex: j - 1 };
}

/**
 * Extract YAML frontmatter from markdown if present.
 * Returns the parsed frontmatter, the remaining markdown, and the 1-based
 * line number where content begins in the original file (so downstream
 * line references stay accurate).
 */
export function extractFrontmatter(markdown: string): { frontmatter: Frontmatter | null; content: string; contentStartLine: number } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, content: markdown, contentStartLine: 1 };
  }

  // Find the closing ---
  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, content: markdown, contentStartLine: 1 };
  }

  // Extract frontmatter content (between the --- delimiters)
  const frontmatterRaw = trimmed.slice(4, endIndex).trim();
  const rawAfterFrontmatter = trimmed.slice(endIndex + 4);
  const afterFrontmatter = rawAfterFrontmatter.trimStart();

  // Compute the 1-based line where content begins in the original file.
  // Account for: leading whitespace trimmed from original, the frontmatter
  // block itself, and any blank lines between closing --- and first content.
  const leadingChars = markdown.length - trimmed.length;
  const consumedInTrimmed = endIndex + 4 + (rawAfterFrontmatter.length - afterFrontmatter.length);
  const consumedTotal = leadingChars + consumedInTrimmed;
  const contentStartLine = (markdown.slice(0, consumedTotal).match(/\n/g) || []).length + 1;

  // Parse simple YAML (key: value pairs)
  const frontmatter: Frontmatter = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  const lines = frontmatterRaw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmedLine = rawLine.trim();

    // Array item (- value)
    if (trimmedLine.startsWith('- ') && currentKey) {
      const value = trimmedLine.slice(2).trim();
      if (!currentArray) {
        currentArray = [];
        frontmatter[currentKey] = currentArray;
      }
      currentArray.push(value);
      continue;
    }

    // Key: value pair
    const colonIndex = trimmedLine.indexOf(':');
    if (colonIndex > 0) {
      currentKey = trimmedLine.slice(0, colonIndex).trim();
      const value = trimmedLine.slice(colonIndex + 1).trim();
      currentArray = null;

      // Block scalar: `|` (literal, keep newlines) or `>` (folded, join with
      // spaces), each with optional chomping indicator (`-`/`+`). The value
      // spans the following lines indented deeper than the key, e.g.
      //   description: >-
      //     line one
      //     line two
      // Without this, the indicator (">-") was stored verbatim and the body
      // silently dropped.
      const blockScalar = value.match(/^([|>])[+-]?$/);
      if (blockScalar) {
        const { value: scalarValue, endIndex } = parseBlockScalar(
          lines,
          i + 1,
          indentWidth(rawLine),
          blockScalar[1] === '>',
        );
        frontmatter[currentKey] = scalarValue;
        i = endIndex;
        continue;
      }

      if (value) {
        frontmatter[currentKey] = value;
      }
    }
  }

  return { frontmatter, content: afterFrontmatter, contentStartLine };
}

/**
 * Tag names that trigger a raw HTML block per CommonMark §4.6, Type 6.
 * A line starting with `<tag` or `</tag` (where `tag` is in this set) opens
 * an HTML block that continues verbatim until a blank line or EOF.
 *
 * Inline-only tags (`kbd`, `sub`, `sup`, `mark`, etc.) are NOT here — a line
 * that happens to start with one of those still goes through the paragraph
 * path and renders as escaped text, matching prior behavior.
 */
export const HTML_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'details', 'summary',
  'div', 'section', 'article', 'aside', 'header', 'footer',
  'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'p',
  // Media: GitHub embeds screenshots/videos as raw HTML on their own line.
  'img', 'video', 'picture',
]);

/** Void elements — no closing tag, so the block is a single line (don't scan
 *  ahead for a `</tag>` that will never come). */
const VOID_HTML_TAGS: ReadonlySet<string> = new Set([
  'img', 'br', 'hr', 'source', 'input', 'wbr', 'area', 'col', 'embed',
]);

const HTML_BLOCK_OPEN_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s|>|\/|$)/;

export interface ParseMarkdownOptions {
  /**
   * Strip a leading `--- ... ---` pair as frontmatter (default true).
   * Pass false for non-markdown plain-text sources (.yaml/.json/.txt/…)
   * where the delimiters are real content — a multi-document YAML starts
   * with them (see shouldStripFrontmatter in @plannotator/core/annotatable).
   */
  frontmatter?: boolean;
}

// CommonMark bounds a link label to 999 characters. Reusing that bound here
// also caps the worst-case backtracking cost of the bracket-matching groups
// below to a constant per starting position, turning a document with a very
// long run of unmatched `[` characters (a real hazard within the 2MB annotate
// cap) into a linear scan instead of a quadratic one. A label longer than
// this is a deliberate, documented degradation: it is neither collected as a
// definition nor resolved as a reference, so it is simply left untouched
// rather than partially or incorrectly rewritten.
const MAX_REF_LABEL_CHARS = 999;
// Same reasoning applied to the inline-code-span alternative: bounding how far
// a lazy scan for a closing backtick run can travel keeps a line with many
// stray, unterminated backticks linear too. 5000 is far beyond any realistic
// inline code span, so legitimate spans are unaffected.
const MAX_CODE_SPAN_CHARS = 5000;
// Defense-in-depth cap on the number of definitions collected from a single
// document. A pathological document could otherwise grow the map without
// bound; this keeps that growth bounded even though ordinary documents never
// approach it.
const MAX_TRACKED_DEFINITIONS = 20_000;

// A link reference definition: `[label]: destination "optional title"`, with up
// to three leading spaces. The destination is a bare token or an <...> form; any
// trailing text must be a quoted or parenthesized title, otherwise the line is
// ordinary prose (so `[Reminder]: call the bank` is NOT a definition). Matches
// the CommonMark shape closely enough for the simplified parser. `\r?` before
// the end anchor tolerates a CRLF source (lines are split on `\n` only, so a
// CRLF line keeps its trailing `\r`).
const REFERENCE_DEFINITION_RE = new RegExp(
  `^ {0,3}\\[([^\\]]{1,${MAX_REF_LABEL_CHARS}})\\]:[ \\t]*(?:<([^>]*)>|(\\S+))[ \\t]*(?:"[^"]*"|'[^']*'|\\([^)]*\\))?[ \\t]*\\r?$`,
);

// One left-to-right pass over a line. The first alternative matches a whole
// inline code span (balanced backtick run) so its contents are skipped; the
// second matches a reference link/image: optional `!`, the bracketed text, then
// an optional second bracket for the full (`[label]`) or collapsed (`[]`) forms.
// A bare `[text]` is the shortcut form, resolved only when it names a definition
// and is not actually an inline link. Groups: 1 code ticks, 2 `!`, 3 text,
// 4 second bracket, 5 label.
const REFERENCE_LINK_RE = new RegExp(
  `(\`+)[^\\n]{0,${MAX_CODE_SPAN_CHARS}}?\\1|(!?)\\[([^\\]]{1,${MAX_REF_LABEL_CHARS}})\\](\\[([^\\]]{0,${MAX_REF_LABEL_CHARS}})\\])?`,
  'g',
);

// CommonMark label matching is case-insensitive and collapses internal runs of
// whitespace.
const normalizeRefLabel = (label: string): string =>
  label.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * One pass over the lines that marks every line the block parser (below) will
 * render as code or raw HTML — fenced code blocks and HTML blocks — so link
 * reference definitions and references inside them are left completely
 * untouched. This reuses the exact same conditions the block parser itself
 * uses (not a looser approximation), so the two can never disagree about
 * where code/HTML starts and ends:
 *
 * - Fences: `trimmed.startsWith('```')` after a full `.trim()` — the block
 *   parser has no minimum-indent exemption, so ANY indentation (a fence
 *   nested inside a list item, or simply indented 4+ spaces) still opens a
 *   code block, and this must too. Only backtick fences are recognized —
 *   the block parser has no `~~~` support, so this doesn't either (a `~~~`
 *   line is ordinary text to both).
 * - Raw HTML blocks: the same `HTML_BLOCK_OPEN_RE`/`HTML_BLOCK_TAGS`/
 *   `VOID_HTML_TAGS` the block parser uses, with the same three extents
 *   (blank-line termination for a leading close tag, single-line for void
 *   tags, balanced-depth scanning otherwise) — so a definition sitting
 *   inside `<details>…</details>` or `<pre>…</pre>` is protected exactly as
 *   far as the block parser's own HTML block extends.
 */
/**
 * Per-tag-name index backing `findHtmlBlockEnd`. `augmented` is the running
 * open-tag-count-minus-close-tag-count prefix sum for this tag name, with a
 * virtual baseline of 0 prepended at index 0 — so `augmented[k]` is the sum
 * through line `k-1` (the depth baseline a block opening at line `k` must
 * return to) and `augmented[k+1]` is the sum through line `k`.
 * `nextAtOrBelow[m]` is the classic "next element at or below this one"
 * index over `augmented`: the smallest `m' > m` with `augmented[m'] <=
 * augmented[m]`, or -1 if none exists.
 */
interface TagCloseIndex {
  augmented: number[];
  nextAtOrBelow: number[];
}

/**
 * Builds a `TagCloseIndex` for one tag name in a single O(N) pass (plus a
 * classic O(N) monotonic-stack pass for `nextAtOrBelow` — each index is
 * pushed and popped at most once, so the two passes together are linear in
 * the document's line count, independent of how many opening/closing tags
 * it contains).
 */
function buildTagCloseIndex(lines: string[], tagName: string): TagCloseIndex {
  const openRe = new RegExp(`<${tagName}(?:\\s|>|/|$)`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  const n = lines.length;
  const augmented = new Array<number>(n + 1);
  augmented[0] = 0;
  let running = 0;
  for (let k = 0; k < n; k++) {
    running += (lines[k].match(openRe) || []).length;
    running -= (lines[k].match(closeRe) || []).length;
    augmented[k + 1] = running;
  }
  const nextAtOrBelow = new Array<number>(n + 1).fill(-1);
  const stack: number[] = [];
  for (let m = n; m >= 0; m--) {
    while (stack.length && augmented[stack[stack.length - 1]] > augmented[m]) stack.pop();
    nextAtOrBelow[m] = stack.length ? stack[stack.length - 1] : -1;
    stack.push(m);
  }
  return { augmented, nextAtOrBelow };
}

/**
 * Shared helper computing the last line index of a balanced open/close-tag
 * HTML block that opens at `startIndex` with the given already-computed
 * `depth` (the opening line's own open-tag count minus close-tag count).
 * Used by both `markProtectedLines` (the resolver's protection pass) and
 * `parseMarkdownToBlocks` (the block parser) so the two can never disagree
 * about a multi-line HTML block's extent, and so a fix here lives in exactly
 * one place instead of two copies drifting apart.
 *
 * History: naively scanning line-by-line from `startIndex` until depth
 * returns to zero (or giving up at end-of-document) is O(N^2) for a
 * document with many consecutive unclosed openers (e.g. thousands of bare
 * `<div>` lines), since every one of them re-scans to EOF. A first fix
 * added an O(1) "does a close exist anywhere" pre-check plus a fixed
 * line-count cap on the residual scan — but that cap silently truncated
 * VALID blocks longer than it, and removing the cap alone reopened a
 * closely related O(N^2) case: N unclosed openers followed by a SINGLE
 * trailing close still all pass the "a close exists somewhere" pre-check,
 * so every one of them still scans forward (mostly to EOF) before giving up.
 *
 * Fixed properly here with a per-tag-name prefix-sum index
 * (`buildTagCloseIndex`, O(N), built once per tag name and cached per
 * document — see `closeCache`): finding "the exact line where a block
 * starting at `startIndex` closes, if ever" is exactly the classic "next
 * smaller-or-equal element" query against that prefix sum, which the index
 * answers in O(1). No scanning happens per opener at all — not for a block
 * that never closes, not for one that closes after any number of
 * intervening lines, however many. This is provably linear overall (a
 * document with T distinct protected tag names costs O(T * N) to index,
 * and T is bounded by the small, fixed `HTML_BLOCK_TAGS` set) and can never
 * truncate a valid block, because it always finds the block's real end
 * (however far away) rather than giving up at a fixed distance.
 *
 * Returns `startIndex` unchanged when the block never closes: depth <= 0,
 * or the running depth never returns to exactly zero anywhere in the rest
 * of the document (whether because no close exists at all, or one exists
 * but is insufficient to bring the count back to exactly the opener's own
 * baseline — e.g. an unbalanced/self-closing tag).
 */
function findHtmlBlockEnd(
  lines: string[],
  startIndex: number,
  tagName: string,
  depth: number,
  closeCache: Map<string, TagCloseIndex>,
): number {
  if (depth <= 0) return startIndex;
  let index = closeCache.get(tagName);
  if (!index) {
    index = buildTagCloseIndex(lines, tagName);
    closeCache.set(tagName, index);
  }
  const { augmented, nextAtOrBelow } = index;
  const m = nextAtOrBelow[startIndex];
  if (m === -1) return startIndex;
  return augmented[m] === augmented[startIndex] ? m - 1 : startIndex;
}

const markProtectedLines = (lines: string[]): boolean[] => {
  const isProtected = new Array<boolean>(lines.length).fill(false);
  let fenceLen = 0; // 0 = not currently inside a fence
  const closeCache = new Map<string, TagCloseIndex>();
  for (let i = 0; i < lines.length; i++) {
    if (fenceLen > 0) {
      isProtected[i] = true;
      if (new RegExp('^\\s*`{' + fenceLen + ',}').test(lines[i])) fenceLen = 0;
      continue;
    }
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      fenceLen = trimmed.match(/^`+/)![0].length;
      isProtected[i] = true;
      continue;
    }
    const htmlTagMatch = trimmed.match(HTML_BLOCK_OPEN_RE);
    if (htmlTagMatch && HTML_BLOCK_TAGS.has(htmlTagMatch[1].toLowerCase())) {
      const tagName = htmlTagMatch[1].toLowerCase();
      const isCloseTag = trimmed.startsWith('</');
      isProtected[i] = true;
      if (isCloseTag) {
        while (i + 1 < lines.length && lines[i + 1].trim() !== '') {
          i++;
          isProtected[i] = true;
        }
      } else if (VOID_HTML_TAGS.has(tagName)) {
        while (!lines[i].includes('>') && i + 1 < lines.length && lines[i + 1].trim() !== '') {
          i++;
          isProtected[i] = true;
        }
      } else {
        const openRe = new RegExp(`<${tagName}(?:\\s|>|/|$)`, 'gi');
        const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
        const depth = (lines[i].match(openRe) || []).length - (lines[i].match(closeRe) || []).length;
        const end = findHtmlBlockEnd(lines, i, tagName, depth, closeCache);
        if (end > i) {
          for (let idx = i + 1; idx <= end; idx++) isProtected[idx] = true;
          i = end;
        }
      }
    }
  }
  return isProtected;
};

/** Resolve reference links/images in one non-code, non-HTML line. A single
 * left-to-right pass: an inline code span is matched as a whole and returned
 * verbatim, so a reference-looking pattern inside backticks is never
 * rewritten; only bracketed references outside code are resolved. Every label
 * that actually resolves against a definition is recorded into `usedLabels`,
 * so the caller can tell a genuinely consumed definition from an unused one. */
const resolveRefsInLine = (
  line: string,
  defs: Map<string, string>,
  usedLabels: Set<string>,
): string => {
  if (!line.includes('[')) return line;
  return line.replace(
    REFERENCE_LINK_RE,
    (match, codeTicks, bang, text, secondBracket, label, offset: number, whole: string) => {
      if (codeTicks !== undefined) return match; // inline code span: keep verbatim
      let refLabel: string;
      if (secondBracket === undefined) {
        // Shortcut `[text]`: not a link when an inline `(...)` destination
        // follows (that is an inline link the existing renderer already draws).
        if (whole[offset + match.length] === '(') return match;
        // Nor when it is a task-list checkbox marker at the start of a list
        // item (`- [x]`); the checkbox parser owns that `[x]`, and resolving it
        // against a stray `x`/`X` definition would clobber the item.
        if (/^[ xX]$/.test(text) && /^\s*(?:[-*+]|\d+[.)])\s+$/.test(whole.slice(0, offset))) {
          return match;
        }
        refLabel = text;
      } else {
        refLabel = label === '' ? text : label;
      }
      const normalized = normalizeRefLabel(refLabel);
      const dest = defs.get(normalized);
      // An unknown reference stays literal, matching CommonMark and avoiding
      // false links for bracketed prose like `[TODO]` or array indices.
      if (!dest) return match;
      usedLabels.add(normalized);
      return `${bang}[${text}](${dest})`;
    },
  );
};

/**
 * Resolve CommonMark link reference definitions and reference links into inline
 * `[text](url)` links, so the shared inline renderer draws them instead of
 * showing raw `[text][id]` and `[id]: url` text (issue #923). Definitions and
 * references inside fenced code blocks, raw HTML blocks, and inline code spans
 * are left untouched. A definition-shaped line is only ever blanked when its
 * label was actually consumed by a resolved reference outside a protected
 * region — an unused definition, or one referenced only from inside code/HTML,
 * stays visible exactly as written. Blanked lines keep block start-line
 * numbers accurate (and their own CRLF ending, so line endings round-trip).
 * GFM footnote definitions (`[^label]: ...`) are never treated as link
 * definitions. No-op (returns the input) when the document defines no
 * (non-footnote) references.
 */
export const resolveReferenceLinks = (markdown: string): string => {
  if (!markdown.includes('[')) return markdown;
  const lines = markdown.split('\n');
  const isProtected = markProtectedLines(lines);
  const defs = new Map<string, string>();
  // The normalized label a definition-shaped line defines, or null if the
  // line isn't a definition (or is a footnote definition, which is never
  // collected/blanked).
  const defLabelByLine = new Array<string | null>(lines.length).fill(null);
  // A definition cannot interrupt a paragraph (CommonMark 4.7): a line matching
  // the definition shape is only a definition when it can start a block, i.e.
  // the previous line is the document start, blank, a protected code/HTML
  // line (each is its own block), or itself a definition. Otherwise the line
  // is paragraph continuation text and must be left untouched, or a bare
  // `[word]: token` under a sentence would be silently deleted.
  let canStartDefinition = true;
  for (let i = 0; i < lines.length; i++) {
    if (isProtected[i]) {
      canStartDefinition = true;
      continue;
    }
    const blank = lines[i].trim() === '';
    const match = canStartDefinition && !blank ? lines[i].match(REFERENCE_DEFINITION_RE) : null;
    if (match) {
      const rawLabel = match[1];
      // GFM footnote definition ([^label]: ...) — not a link reference
      // definition. Leave it out of `defs` entirely so it can never be
      // collected, blanked, or accidentally satisfy a footnote reference's
      // lookup; it stays block-starting like any other definition line.
      if (!rawLabel.startsWith('^') && defs.size < MAX_TRACKED_DEFINITIONS) {
        const label = normalizeRefLabel(rawLabel);
        const dest = match[2] !== undefined ? match[2] : match[3];
        // First definition wins, per CommonMark.
        if (label && dest && !defs.has(label)) defs.set(label, dest);
        defLabelByLine[i] = label;
      }
      // A run of definitions stays eligible; canStartDefinition remains true.
    } else {
      // Blank keeps a new block startable; any other non-definition line starts
      // (or continues) a paragraph, so a following definition-shaped line is text.
      canStartDefinition = blank;
    }
  }
  if (defs.size === 0) return markdown;
  const usedLabels = new Set<string>();
  // Resolve references first; definition-shaped lines are passed through
  // unresolved (never fed to resolveRefsInLine) so a definition's own
  // `[label]` can never be mistaken for a reference to itself.
  const resolved = lines.map((line, i) =>
    isProtected[i] || defLabelByLine[i] !== null ? line : resolveRefsInLine(line, defs, usedLabels),
  );
  return resolved
    .map((line, i) => {
      const label = defLabelByLine[i];
      if (label === null || !usedLabels.has(label)) return line;
      // Blank in place, preserving this line's own CRLF ending if it had one.
      return line.endsWith('\r') ? '\r' : '';
    })
    .join('\n');
};

/**
 * A simplified markdown parser that splits content into linear blocks.
 * For a production app, we would use a robust AST walker (remark),
 * but for this demo, we want predictable text-anchoring.
 */
export const parseMarkdownToBlocks = (markdown: string, options?: ParseMarkdownOptions): Block[] => {
  const { content: rawContent, contentStartLine } =
    options?.frontmatter === false
      ? { content: markdown, contentStartLine: 1 }
      : extractFrontmatter(markdown);
  // Resolve link reference definitions into inline links before splitting. This
  // blanks definition lines in place, so line count (and every block's
  // startLine) is preserved.
  const cleanMarkdown = resolveReferenceLinks(rawContent);
  const lines = cleanMarkdown.split('\n');
  const blocks: Block[] = [];
  let currentId = 0;
  // Cache for findHtmlBlockEnd's per-tag-name prefix-sum index — scoped per
  // parse call (per document) and shared across every HTML-block opener
  // encountered below, so a document with many consecutive openers of the
  // same tag only pays its one-time O(N) build cost once.
  const htmlCloseCache = new Map<string, TagCloseIndex>();

  let buffer: string[] = [];
  let currentType: Block['type'] = 'paragraph';
  let currentLevel = 0;
  let bufferStartLine = contentStartLine;
  let lastLineWasBlank = false;

  const flush = () => {
    if (buffer.length > 0) {
      const content = buffer.join('\n');
      blocks.push({
        id: `block-${currentId++}`,
        type: currentType,
        content: content,
        level: currentLevel,
        order: currentId,
        startLine: bufferStartLine
      });
      buffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const currentLineNum = i + contentStartLine;
    const prevLineWasBlank = lastLineWasBlank;
    lastLineWasBlank = false;

    // Headings
    if (trimmed.startsWith('#')) {
      flush();
      const level = trimmed.match(/^#+/)?.[0].length || 1;
      blocks.push({
        id: `block-${currentId++}`,
        type: 'heading',
        content: trimmed.replace(/^#+\s*/, ''),
        level,
        order: currentId,
        startLine: currentLineNum
      });
      continue;
    }

    // Horizontal Rule
    if (trimmed === '---' || trimmed === '***') {
      flush();
      blocks.push({
        id: `block-${currentId++}`,
        type: 'hr',
        content: '',
        order: currentId,
        startLine: currentLineNum
      });
      continue;
    }

    // List Items (Simple detection)
    const listMatch = trimmed.match(/^(\*|-|(\d+)\.)\s/);
    if (listMatch) {
      flush(); // Treat each list item as a separate block for easier annotation
      // Calculate indentation level from leading whitespace
      const leadingWhitespace = line.match(/^(\s*)/)?.[1] || '';
      // Count spaces (2 spaces = 1 level) or tabs (1 tab = 1 level)
      const spaceCount = leadingWhitespace.replace(/\t/g, '  ').length;
      const listLevel = Math.floor(spaceCount / 2);

      // Distinguish numeric markers (\d+.) from bullet markers (* / -)
      const ordered = listMatch[2] !== undefined;
      const orderedStart = ordered ? parseInt(listMatch[2]!, 10) : undefined;

      // Remove list marker
      let content = trimmed.slice(listMatch[0].length);

      // Check for checkbox syntax: [ ] or [x] or [X]
      let checked: boolean | undefined = undefined;
      const checkboxMatch = content.match(/^\[([ xX])\]\s*/);
      if (checkboxMatch) {
        checked = checkboxMatch[1].toLowerCase() === 'x';
        content = content.replace(/^\[([ xX])\]\s*/, '');
      }

      blocks.push({
        id: `block-${currentId++}`,
        type: 'list-item',
        content,
        level: listLevel,
        checked,
        ordered: ordered || undefined,
        orderedStart,
        order: currentId,
        startLine: currentLineNum
      });
      continue;
    }

    // Blockquotes — consecutive `>` lines merge into one block so wrapped
    // paragraph quotes render as a single continuous quote box. A blank line
    // breaks the blockquote so the next `>` starts a fresh one.
    //
    // Exception: if the stripped content starts with a block-level marker
    // (list item, heading, code fence, nested blockquote) we do NOT merge.
    // Our flat block model can't render a list-inside-a-quote as an actual
    // nested list, so merging would flatten the markers into run-on inline
    // text. Leaving them as separate blockquote blocks preserves each line's
    // visual identity (a stacked-box layout) — imperfect but legible. A
    // proper recursive blockquote parser is tracked as a follow-up.
    if (trimmed.startsWith('>')) {
      flush();
      const stripped = trimmed.replace(/^>\s*/, '');
      // List markers require trailing whitespace to avoid matching inline
      // text like "-hyphen" or "1.5 seconds"; headings, code fences, and
      // nested blockquote markers don't require it (``` can be followed
      // directly by a language tag, # can start a dense heading).
      const blockMarkerRe = /^(?:(?:\*|-|\d+\.)\s|#|```|>)/;
      const hasBlockMarker = blockMarkerRe.test(stripped);
      const prevBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      // Don't merge into a previous blockquote whose content itself starts
      // with a block marker — otherwise a `> some text` line following a
      // `> 1. item` line would get glued onto the list-item block.
      const prevIsMarkerQuote =
        prevBlock?.type === 'blockquote' && blockMarkerRe.test(prevBlock.content);
      // Alerts own their body: once a blockquote is tagged as an alert,
      // subsequent `>` lines always merge into it (until a blank line).
      // Without this, `> [!NOTE]\n> - item` splits the list item off into
      // a separate plain quote, losing the callout.
      const prevIsAlert = prevBlock?.type === 'blockquote' && !!prevBlock.alertKind;
      const shouldMergeIntoAlert = prevIsAlert && !prevLineWasBlank;
      const shouldMergeNormal =
        !hasBlockMarker &&
        !prevIsMarkerQuote &&
        !prevLineWasBlank &&
        prevBlock?.type === 'blockquote';
      if (shouldMergeIntoAlert || shouldMergeNormal) {
        prevBlock!.content = prevBlock!.content
          ? prevBlock!.content + '\n' + stripped
          : stripped;
      } else {
        // GitHub alert marker: a blockquote whose first line is [!KIND].
        // We strip the marker from content and tag the block; rendering decides the style.
        const alertMatch = stripped.match(/^\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]\s*$/i);
        blocks.push({
          id: `block-${currentId++}`,
          type: 'blockquote',
          content: alertMatch ? '' : stripped,
          alertKind: alertMatch
            ? (alertMatch[1].toLowerCase() as 'note' | 'tip' | 'warning' | 'caution' | 'important')
            : undefined,
          order: currentId,
          startLine: currentLineNum
        });
      }
      continue;
    }
    
    // Code blocks (naive)
    if (trimmed.startsWith('```')) {
      flush();
      const codeStartLine = currentLineNum;
      // Count backticks in opening fence to support nested fences (e.g. ```` wrapping ```)
      const fenceLen = trimmed.match(/^`+/)?.[0].length ?? 3;
      const closingFence = new RegExp('^\\s*`{' + fenceLen + ',}');
      // Extract language from fence (e.g., ```rust → "rust")
      const language = trimmed.slice(fenceLen).trim() || undefined;
      // Fast forward until end of code block
      let codeContent = [];
      i++; // Skip start fence
      while(i < lines.length && !closingFence.test(lines[i])) {
        codeContent.push(lines[i]);
        i++;
      }
      blocks.push({
        id: `block-${currentId++}`,
        type: 'code',
        content: codeContent.join('\n'),
        language,
        order: currentId,
        startLine: codeStartLine
      });
      continue;
    }

    // Display math: $$ ... $$ — only when a closing $$ actually exists. An
    // unclosed $$ (a stray delimiter or informal money like "$$100k for infra")
    // must NOT swallow the rest of the document: scan ahead without committing,
    // and if there's no close, fall through and treat the line as ordinary text.
    if (trimmed.startsWith('$$')) {
      const mathStartLine = currentLineNum;
      const afterOpen = trimmed.slice(2);
      const mathLines: string[] = [];
      let remainder = '';
      let closed = false;
      let closeLine = i;
      // Find the closing $$ anywhere on the opening line (not just at its end),
      // so `$$x$$.` or `$$x$$ trailing` close correctly instead of running on.
      const inlineClose = afterOpen.indexOf('$$');
      if (inlineClose !== -1) {
        const body = afterOpen.slice(0, inlineClose).trim();
        if (body) mathLines.push(body);
        remainder = afterOpen.slice(inlineClose + 2).trim();
        closed = true;
      } else {
        const scanned: string[] = afterOpen.trim() ? [afterOpen.trim()] : [];
        let j = i;
        while (j + 1 < lines.length) {
          j++;
          // A blank line ends the search: real $$…$$ has no blank line before its
          // close, so a blank means this opener was never closed. Stopping here
          // also prevents matching a stray $$ far below (e.g. inside a later code
          // fence) and swallowing everything in between.
          if (lines[j].trim() === '') break;
          const closeAt = lines[j].indexOf('$$');
          if (closeAt !== -1) {
            const before = lines[j].slice(0, closeAt);
            if (before.trim()) scanned.push(before);
            remainder = lines[j].slice(closeAt + 2).trim();
            closed = true;
            closeLine = j;
            break;
          }
          scanned.push(lines[j]);
        }
        if (closed) for (const s of scanned) mathLines.push(s);
      }

      if (closed) {
        flush();
        i = closeLine;
        blocks.push({
          id: `block-${currentId++}`,
          type: 'math',
          content: mathLines.join('\n'),
          order: currentId,
          startLine: mathStartLine,
          sourceLineCount: i + contentStartLine - mathStartLine + 1,
        });
        // Trailing text after the closing $$ isn't math — reprocess it as its own
        // line so it renders normally instead of being swallowed into the block.
        if (remainder) {
          lines[i] = remainder;
          i--;
        }
        continue;
      }
      // No closing $$ found — not display math; fall through to normal handling.
    }

    // Display math: \[ ... \] — same unclosed-guard as $$ above: only treat as
    // math when the closing \] exists, so a stray `\[deprecated\]`-style line or
    // an unclosed `\[` doesn't swallow the rest of the document.
    if (trimmed.startsWith('\\[')) {
      const mathStartLine = currentLineNum;
      const afterOpen = trimmed.slice(2);
      const mathLines: string[] = [];
      let remainder = '';
      let closed = false;
      let closeLine = i;
      const inlineClose = afterOpen.indexOf('\\]');
      if (inlineClose !== -1) {
        const body = afterOpen.slice(0, inlineClose).trim();
        if (body) mathLines.push(body);
        remainder = afterOpen.slice(inlineClose + 2).trim();
        closed = true;
      } else {
        const scanned: string[] = afterOpen.trim() ? [afterOpen.trim()] : [];
        let j = i;
        while (j + 1 < lines.length) {
          j++;
          // Blank line ends the search (see the $$ branch): unclosed \[ must not
          // swallow later blocks or match a stray \] inside a later code fence.
          if (lines[j].trim() === '') break;
          const closeAt = lines[j].indexOf('\\]');
          if (closeAt !== -1) {
            const before = lines[j].slice(0, closeAt);
            if (before.trim()) scanned.push(before);
            remainder = lines[j].slice(closeAt + 2).trim();
            closed = true;
            closeLine = j;
            break;
          }
          scanned.push(lines[j]);
        }
        if (closed) for (const s of scanned) mathLines.push(s);
      }

      if (closed) {
        flush();
        i = closeLine;
        blocks.push({
          id: `block-${currentId++}`,
          type: 'math',
          content: mathLines.join('\n'),
          order: currentId,
          startLine: mathStartLine,
          sourceLineCount: i + contentStartLine - mathStartLine + 1,
        });
        if (remainder) {
          lines[i] = remainder;
          i--;
        }
        continue;
      }
      // No closing \] found — not display math; fall through to normal handling.
    }

    // Tables (lines starting with |)
    if (trimmed.startsWith('|')) {
      flush();
      const tableStartLine = currentLineNum;
      const tableLines: string[] = [line];

      // Collect all consecutive table lines
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        // Continue if line starts with | (table row or separator)
        if (nextLine.startsWith('|')) {
          i++;
          tableLines.push(lines[i]);
        } else {
          break;
        }
      }

      blocks.push({
        id: `block-${currentId++}`,
        type: 'table',
        content: tableLines.join('\n'),
        order: currentId,
        startLine: tableStartLine
      });
      continue;
    }

    // Raw HTML blocks. A line starting with a known block-level HTML tag
    // opens an HTML block. For opening tags we accumulate until the matching
    // close tag is balanced (so `<details>…blank line…</details>` renders as
    // one unit, matching GitHub's flavored behavior rather than strict
    // CommonMark §4.6 Type 6 blank-line termination). For a line that starts
    // with a close tag, we fall back to blank-line termination. Content is
    // sanitized at render time, not here.
    // Directive container: `:::kind` opens, `:::` closes. Inline kind is
    // restricted to simple identifiers (letters, digits, hyphens). Body is
    // accumulated verbatim and rendered with inline markdown.
    const directiveOpen = trimmed.match(/^:::\s*([a-zA-Z][a-zA-Z0-9-]*)\s*$/);
    if (directiveOpen) {
      flush();
      const directiveStartLine = currentLineNum;
      const kind = directiveOpen[1].toLowerCase();
      const bodyLines: string[] = [];
      while (i + 1 < lines.length) {
        i++;
        if (lines[i].trim() === ':::') break;
        bodyLines.push(lines[i]);
      }
      blocks.push({
        id: `block-${currentId++}`,
        type: 'directive',
        content: bodyLines.join('\n'),
        directiveKind: kind,
        order: currentId,
        startLine: directiveStartLine,
      });
      continue;
    }

    const htmlTagMatch = trimmed.match(HTML_BLOCK_OPEN_RE);
    if (htmlTagMatch && HTML_BLOCK_TAGS.has(htmlTagMatch[1].toLowerCase())) {
      flush();
      const htmlStartLine = currentLineNum;
      const tagName = htmlTagMatch[1].toLowerCase();
      const isCloseTag = trimmed.startsWith('</');
      const htmlLines: string[] = [line];

      if (isCloseTag) {
        while (i + 1 < lines.length && lines[i + 1].trim() !== '') {
          i++;
          htmlLines.push(lines[i]);
        }
      } else if (VOID_HTML_TAGS.has(tagName)) {
        // Void element (e.g. <img>): no closing tag, but attributes can wrap across
        // lines. Consume until the line that actually closes the tag with `>` so a
        // multi-line <img> isn't truncated to a bare `<img` fragment.
        while (!lines[i].includes('>') && i + 1 < lines.length && lines[i + 1].trim() !== '') {
          i++;
          htmlLines.push(lines[i]);
        }
      } else {
        const openRe = new RegExp(`<${tagName}(?:\\s|>|/|$)`, 'gi');
        const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
        const depth = (line.match(openRe) || []).length - (line.match(closeRe) || []).length;
        // Scan ahead for the matching close tag via the shared, bounded/
        // linear helper (see its doc comment for why a naive per-opener scan
        // is quadratic). If none is ever found — a self-closing <video/>, or
        // an unclosed <picture>/<div> — do NOT swallow the rest of the
        // document into this block; keep it to the opening line.
        const end = findHtmlBlockEnd(lines, i, tagName, depth, htmlCloseCache);
        if (end > i) {
          for (let k = i + 1; k <= end; k++) htmlLines.push(lines[k]);
          i = end;
        }
      }

      blocks.push({
        id: `block-${currentId++}`,
        type: 'html',
        content: htmlLines.join('\n'),
        order: currentId,
        startLine: htmlStartLine,
      });
      continue;
    }

    // Empty lines separate paragraphs
    if (trimmed === '') {
      flush();
      currentType = 'paragraph';
      lastLineWasBlank = true;
      continue;
    }
    // List continuation: indented line after a list item merges into it.
    // Tight (no blank line): 1+ whitespace, joined with \n (same paragraph).
    // Loose (after blank line): 2+ spaces, joined with \n\n (new paragraph within the item).
    if (
      buffer.length === 0 &&
      blocks.length > 0 &&
      blocks[blocks.length - 1].type === 'list-item' &&
      (prevLineWasBlank ? /^\s{2,}/ : /^\s+/).test(line)
    ) {
      const sep = prevLineWasBlank ? '\n\n' : '\n';
      blocks[blocks.length - 1].content += sep + trimmed;
      continue;
    }

    // Accumulate paragraph text
    if (buffer.length === 0) {
      bufferStartLine = currentLineNum;
    }
    buffer.push(line);
  }
  
  flush(); // Final flush

  return blocks;
};

/**
 * Compute the display index for each list item in a contiguous list group.
 *
 * Returns a parallel array where each entry is either:
 *   - a positive integer (the numeral to render for an ordered item), or
 *   - null (the item is unordered, render a bullet symbol).
 *
 * Semantics:
 *   - A run of consecutive ordered items at the same level increments
 *     sequentially. The first item in a run uses its `orderedStart` (the
 *     number from the source markdown); subsequent items renumber from there
 *     so `1. / 2. / 5.` renders as 1, 2, 3 (matches CommonMark).
 *   - An unordered item at level L breaks the ordered streak at L. The next
 *     ordered item at L restarts from its own `orderedStart`.
 *   - Visiting a level shallower than the current one truncates deeper-level
 *     state, so re-entering that depth later starts fresh. Top-level numbering
 *     continues across nested children of any kind.
 */
export const computeListIndices = (blocks: Block[]): (number | null)[] => {
  const counters: number[] = [];
  const lastOrderedAtLevel: boolean[] = [];

  return blocks.map(block => {
    const lvl = block.level || 0;
    // Sibling change at any deeper level resets those levels.
    counters.length = lvl + 1;
    lastOrderedAtLevel.length = lvl + 1;

    if (!block.ordered) {
      lastOrderedAtLevel[lvl] = false;
      return null;
    }

    if (lastOrderedAtLevel[lvl]) {
      counters[lvl] = (counters[lvl] ?? 0) + 1;
    } else {
      counters[lvl] = block.orderedStart ?? 1;
    }
    lastOrderedAtLevel[lvl] = true;
    return counters[lvl];
  });
};

/** A run of blocks to render: a single block, or consecutive list items grouped
 *  together so list numbering/indent can be computed across the run. */
export type RenderGroup =
  | { type: 'single'; block: Block }
  | { type: 'list-group'; blocks: Block[]; key: string };

/** Groups consecutive list-item blocks so a list renders as one unit. */
export function groupBlocks(blocks: Block[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type === 'list-item') {
      const listBlocks: Block[] = [];
      while (i < blocks.length && blocks[i].type === 'list-item') {
        listBlocks.push(blocks[i]);
        i++;
      }
      groups.push({ type: 'list-group', blocks: listBlocks, key: `list-${listBlocks[0].id}` });
    } else {
      groups.push({ type: 'single', block: blocks[i] });
      i++;
    }
  }
  return groups;
}

/** Wrap feedback output with the deny preamble for pasting into agent sessions */
export const wrapFeedbackForAgent = (feedback: string): string =>
  planDenyFeedback(feedback);

export interface ExportAnnotationsOptions {
  sourceConverted?: boolean;
}

/** Compute the end line of a block from its content and type. */
const blockEndLine = (block: Block): number => {
  if (block.sourceLineCount && block.sourceLineCount > 0) {
    return block.startLine + block.sourceLineCount - 1;
  }
  if (!block.content) return block.startLine;
  const contentLines = block.content.split('\n').length;
  if (block.type === 'code') return block.startLine + contentLines + 1;
  if (block.type === 'directive') return block.startLine + contentLines + 1;
  if (block.alertKind) return block.startLine + contentLines;
  return block.startLine + contentLines - 1;
};

/** Resolve the source-line label for a single annotation.
 *  Returns null for global comments, diff-view annotations, or missing blocks. */
/** Multi-target raw-HTML comments: list every ADDITIONAL element the one
 *  comment covers (the primary target is already quoted as `originalText`),
 *  labeled with the semantic hover label plus a short excerpt so the agent
 *  reading the feedback sees every referenced element. Emits nothing for
 *  single-target annotations, keeping their output byte-identical. */
const additionalTargetsExportBlock = (ann: any): string => {
  const targets = ann?.htmlAdditionalTargets;
  if (!Array.isArray(targets) || targets.length === 0) return '';
  // Leading blank line: the preceding comment line is a `> blockquote`, and
  // markdown lazy continuation would otherwise fold this block into it.
  let block = `\n**Also applies to ${targets.length} more element${targets.length > 1 ? 's' : ''}:**\n`;
  targets.forEach((target: any) => {
    // Labels and texts are page-controlled (aria-label etc.). The DTO
    // boundary already collapses label whitespace; do it here again (defense
    // in depth) so persisted pre-fix data can never smuggle newlines — and
    // with them fake markdown structure — into agent-read feedback.
    const rawLabel = typeof target?.label === 'string' ? target.label.replace(/\s+/g, ' ').trim() : '';
    const label = rawLabel ? `[${rawLabel}] ` : '';
    const raw = typeof target?.text === 'string' ? target.text : '';
    const excerpt = raw.replace(/\s+/g, ' ').trim();
    const clipped = excerpt.length > 120 ? `${excerpt.slice(0, 120)}…` : excerpt;
    block += `- ${label}"${clipped}"\n`;
  });
  return block;
};

const lineLabelForAnnotation = (blocks: Block[], ann: any): string | null => {
  if (!ann.blockId || ann.type === 'GLOBAL_COMMENT') return null;
  if (typeof ann.blockId === 'string' && ann.blockId.startsWith('diff-block-')) return null;
  const block = blocks.find(b => b.id === ann.blockId);
  if (!block || typeof block.startLine !== 'number') return null;
  const end = blockEndLine(block);
  if (end <= block.startLine) return `line ${block.startLine}`;
  return `lines ${block.startLine}–${end}`;
};

export const exportAnnotations = (
  blocks: Block[],
  annotations: any[],
  globalAttachments: ImageAttachment[] = [],
  title: string = 'Plan Feedback',
  subject: string = 'plan',
  opts: ExportAnnotationsOptions = {},
): string => {
  if (annotations.length === 0 && globalAttachments.length === 0) {
    return 'No changes detected.';
  }

  // Sort annotations by block and offset
  const sortedAnns = [...annotations].sort((a, b) => {
    const blockA = blocks.findIndex(blk => blk.id === a.blockId);
    const blockB = blocks.findIndex(blk => blk.id === b.blockId);
    if (blockA !== blockB) return blockA - blockB;
    return a.startOffset - b.startOffset;
  });

  // One injection per export: a human-only skill referenced by several
  // comments has its instructions injected once (see skillReferenceExportBlock).
  const injectedSkills = new Set<string>();

  let output = `# ${title}\n\n`;

  if (opts.sourceConverted) {
    output += `> Note: Line numbers below refer to the converted markdown, not the original HTML/URL source.\n\n`;
  }

  // Add global reference images section if any
  if (globalAttachments.length > 0) {
    output += `## Reference Images\n`;
    output += `Please review these reference images (use the Read tool to view):\n`;
    globalAttachments.forEach((img, idx) => {
      output += `${idx + 1}. [${img.name}] \`${img.path}\`\n`;
    });
    output += `\n`;
  }

  if (annotations.length > 0) {
    output += `I've reviewed this ${subject} and have ${annotations.length} piece${annotations.length > 1 ? 's' : ''} of feedback:\n\n`;
  }

  sortedAnns.forEach((ann, index) => {
    output += `## ${index + 1}. `;

    // Add diff context label if annotation was created in diff view
    if (ann.diffContext) {
      output += `[In diff content] `;
    } else {
      const lineLabel = lineLabelForAnnotation(blocks, ann);
      if (lineLabel) output += `(${lineLabel}) `;
    }

    switch (ann.type) {
      case 'DELETION':
        output += `Remove this\n`;
        output += `\`\`\`\n${ann.originalText}\n\`\`\`\n`;
        output += `> I don't want this in the ${subject}.\n`;
        break;

      case 'COMMENT':
        if (ann.isQuickLabel) {
          output += `[${ann.text}] Feedback on: "${ann.originalText}"\n`;
          if (ann.quickLabelTip) {
            output += `> ${ann.quickLabelTip}\n`;
          }
        } else {
          output += `Feedback on: "${ann.originalText}"\n`;
          output += `> ${ann.text}\n`;
        }
        break;

      case 'GLOBAL_COMMENT':
        output += `General feedback about the ${subject}\n`;
        output += `> ${ann.text}\n`;
        break;
    }

    // Multi-target raw-HTML comments list every additional covered element.
    output += additionalTargetsExportBlock(ann);

    // Skill references in the comment text (no-op unless a catalog is
    // registered). An annotation carrying a `source` arrived through the
    // external-annotations API, not from the reviewer — it may list skills
    // but must never cause a human-only skill's instructions to be injected.
    if (!ann.isQuickLabel) {
      output += skillReferenceExportBlock(ann.text, injectedSkills, { external: !!ann.source });
    }

    // Add attached images for this annotation
    if (ann.images && ann.images.length > 0) {
      output += `**Attached images:**\n`;
      ann.images.forEach((img: ImageAttachment) => {
        output += `- [${img.name}] \`${img.path}\`\n`;
      });
    }

    output += '\n';
  });

  output += `---\n`;

  // Quick Label Summary
  const labeledAnns = sortedAnns.filter((a: any) => a.isQuickLabel && a.text);
  if (labeledAnns.length > 0) {
    const grouped = new Map<string, number>();
    labeledAnns.forEach((a: any) => {
      grouped.set(a.text, (grouped.get(a.text) || 0) + 1);
    });

    output += `\n## Label Summary\n\n`;
    for (const [text, count] of grouped) {
      output += `- **${text}**: ${count}\n`;
    }
    output += '\n';
  }

  return output;
};

export interface LinkedDocAnnotationEntry {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  markdown?: string;
  blocks?: Block[];
  isConverted?: boolean;
}

export const exportLinkedDocAnnotations = (
  docAnnotations: Map<string, LinkedDocAnnotationEntry>
): string => {
  let output = `\n# Linked Document Feedback\n\nThe following feedback is on documents referenced in the plan.\n\n`;

  // One injection per export, across all linked documents.
  const injectedSkills = new Set<string>();

  for (const [filepath, { annotations, globalAttachments, blocks: docBlocks, isConverted }] of docAnnotations) {
    if (annotations.length === 0 && globalAttachments.length === 0) continue;

    output += `## ${filepath}${isConverted ? ' (converted from HTML — line numbers refer to converted markdown)' : ''}\n\n`;

    if (globalAttachments.length > 0) {
      output += `### Reference Images\n`;
      output += `Please review these reference images (use the Read tool to view):\n`;
      globalAttachments.forEach((img, idx) => {
        output += `${idx + 1}. [${img.name}] \`${img.path}\`\n`;
      });
      output += `\n`;
    }

    // Sort annotations by block and offset
    const sortedAnns = [...annotations].sort((a, b) => {
      if (a.blockId !== b.blockId) return a.blockId.localeCompare(b.blockId);
      return a.startOffset - b.startOffset;
    });

    output += `I've reviewed this document and have ${annotations.length} piece${annotations.length !== 1 ? 's' : ''} of feedback:\n\n`;

    sortedAnns.forEach((ann, index) => {
      output += `### ${index + 1}. `;

      const lineLabel = docBlocks ? lineLabelForAnnotation(docBlocks, ann) : null;
      if (lineLabel) output += `(${lineLabel}) `;

      switch (ann.type) {
        case 'DELETION':
          output += `Remove this\n`;
          output += `\`\`\`\n${ann.originalText}\n\`\`\`\n`;
          output += `> I don't want this in the document.\n`;
          break;

        case 'COMMENT':
          output += `Feedback on: "${ann.originalText}"\n`;
          output += `> ${ann.text}\n`;
          break;

        case 'GLOBAL_COMMENT':
          output += `General feedback about the document\n`;
          output += `> ${ann.text}\n`;
          break;
      }

      // Multi-target raw-HTML comments list every additional covered element.
      output += additionalTargetsExportBlock(ann);

      // External (tool-sourced) comments list skills but never inject.
      output += skillReferenceExportBlock(ann.text, injectedSkills, { external: !!ann.source });

      if (ann.images && ann.images.length > 0) {
        output += `**Attached images:**\n`;
        ann.images.forEach((img: ImageAttachment) => {
          output += `- [${img.name}] \`${img.path}\`\n`;
        });
      }

      output += '\n';
    });
  }

  output += `---\n`;
  return output;
};

export const exportEditorAnnotations = (editorAnnotations: EditorAnnotation[]): string => {
  if (editorAnnotations.length === 0) return '';

  let output = `\n# Editor File Annotations\n\nThe following annotations reference code files in the project.\n\n`;

  editorAnnotations.forEach((ann, index) => {
    const lineRange = ann.lineStart === ann.lineEnd
      ? `line ${ann.lineStart}`
      : `lines ${ann.lineStart}-${ann.lineEnd}`;

    output += `## ${index + 1}. ${ann.filePath} (${lineRange})\n`;
    output += `\`\`\`\n${ann.selectedText}\n\`\`\`\n`;

    if (ann.comment) {
      output += `> ${ann.comment}\n`;
    }

    output += '\n';
  });

  output += `---\n`;
  return output;
};

export const exportCodeFileAnnotations = (annotations: CodeAnnotation[]): string => {
  if (annotations.length === 0) return '';

  let output = `\n# Code File Feedback\n\nThe following feedback is on code files referenced from the reviewed document.\n\n`;
  // One injection per export, across all code-file comments.
  const injectedSkills = new Set<string>();
  const sorted = [...annotations].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    if (a.lineStart !== b.lineStart) return a.lineStart - b.lineStart;
    return a.createdAt - b.createdAt;
  });

  sorted.forEach((ann, index) => {
    const lineRange = ann.lineStart === ann.lineEnd
      ? `line ${ann.lineStart}`
      : `lines ${ann.lineStart}-${ann.lineEnd}`;

    output += `## ${index + 1}. ${ann.filePath} (${lineRange})\n`;
    if (ann.originalCode) {
      output += `\`\`\`\n${ann.originalCode}\n\`\`\`\n`;
    }
    if (ann.text) {
      output += `> ${ann.text}\n`;
    }
    // External (tool-sourced) comments list skills but never inject.
    output += skillReferenceExportBlock(ann.text, injectedSkills, { external: !!ann.source });
    if (ann.images && ann.images.length > 0) {
      output += `**Attached images:**\n`;
      ann.images.forEach((img) => {
        output += `- [${img.name}] \`${img.path}\`\n`;
      });
    }
    output += '\n';
  });

  output += `---\n`;
  return output;
};

export interface MessageAnnotationEntry {
  messageId: string;
  text: string;
  timestamp?: string;
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  blocks?: Block[];
  linkedDocs?: Map<string, LinkedDocAnnotationEntry>;
  codeAnnotations?: CodeAnnotation[];
}

const MESSAGE_EXCERPT_MAX_CHARS = 1200;

const excerptMessageText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_EXCERPT_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, MESSAGE_EXCERPT_MAX_CHARS).trimEnd()}...`;
};

const fencedBlock = (text: string, language = ''): string => {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}${language}\n${text}\n${fence}\n`;
};

export const exportMessageAnnotations = (entries: MessageAnnotationEntry[]): string => {
  const nonEmpty = entries.filter((entry) => {
    const linkedDocCount = entry.linkedDocs
      ? Array.from(entry.linkedDocs.values()).reduce(
          (sum, doc) => sum + doc.annotations.length + doc.globalAttachments.length,
          0
        )
      : 0;
    return (
      entry.annotations.length > 0 ||
      entry.globalAttachments.length > 0 ||
      (entry.codeAnnotations?.length ?? 0) > 0 ||
      linkedDocCount > 0
    );
  });

  if (nonEmpty.length === 0) {
    return 'User reviewed the messages and has no feedback.';
  }

  let output = `# Message Feedback\n\nThe following feedback spans ${nonEmpty.length} assistant message${nonEmpty.length === 1 ? '' : 's'}. Each section includes an excerpt of the message it applies to.\n\n`;

  nonEmpty.forEach((entry, index) => {
    const label = entry.timestamp ? ` (${entry.timestamp})` : '';
    output += `## Message ${index + 1}${label}\n\n`;
    output += `Message excerpt:\n`;
    output += fencedBlock(excerptMessageText(entry.text), 'markdown');
    output += '\n';

    if (entry.annotations.length > 0 || entry.globalAttachments.length > 0) {
      output += exportAnnotations(
        entry.blocks ?? parseMarkdownToBlocks(entry.text),
        entry.annotations,
        entry.globalAttachments,
        `Feedback for Message ${index + 1}`,
        'message',
      );
      output += '\n';
    }

    const hasLinkedDocFeedback = entry.linkedDocs
      ? Array.from(entry.linkedDocs.values()).some(
          (doc) => doc.annotations.length > 0 || doc.globalAttachments.length > 0
        )
      : false;
    if (entry.linkedDocs && hasLinkedDocFeedback) {
      output += exportLinkedDocAnnotations(entry.linkedDocs);
      output += '\n';
    }

    if (entry.codeAnnotations?.length) {
      output += exportCodeFileAnnotations(entry.codeAnnotations);
      output += '\n';
    }
  });

  return output.trimEnd();
};
