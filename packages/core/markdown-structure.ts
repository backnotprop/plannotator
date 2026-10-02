/**
 * The structural pieces of Plannotator's markdown block splitter that are
 * pure and runtime-agnostic: where a leading frontmatter block ends, which
 * lines belong to fenced code or raw HTML blocks, and the link reference
 * resolver that runs before splitting.
 *
 * `@plannotator/ui`'s `parseMarkdownToBlocks` imports these, and so does
 * `findQuestionBlocks` in `./question-block`, so a server that locates
 * `:::question` blocks without the UI parser agrees with it about frontmatter,
 * code fences, HTML blocks and reference links by construction (one copy of
 * each rule, not two that can drift).
 *
 * Browser-safe, zero-dependency.
 */

/**
 * The span of a leading `--- … ---` frontmatter block. `raw` is the text
 * between the delimiters (trimmed), or null when there is none; `content` is
 * the markdown after it (leading whitespace trimmed); `contentStartLine` is
 * the 1-based line of the original text where `content` begins, so block line
 * numbers stay accurate.
 */
export function splitFrontmatter(markdown: string): { raw: string | null; content: string; contentStartLine: number } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { raw: null, content: markdown, contentStartLine: 1 };
  }

  // Find the closing ---
  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { raw: null, content: markdown, contentStartLine: 1 };
  }

  // Extract frontmatter content (between the --- delimiters)
  const raw = trimmed.slice(4, endIndex).trim();
  const rawAfterFrontmatter = trimmed.slice(endIndex + 4);
  const afterFrontmatter = rawAfterFrontmatter.trimStart();

  // Compute the 1-based line where content begins in the original file.
  // Account for: leading whitespace trimmed from original, the frontmatter
  // block itself, and any blank lines between closing --- and first content.
  const leadingChars = markdown.length - trimmed.length;
  const consumedInTrimmed = endIndex + 4 + (rawAfterFrontmatter.length - afterFrontmatter.length);
  const consumedTotal = leadingChars + consumedInTrimmed;
  const contentStartLine = (markdown.slice(0, consumedTotal).match(/\n/g) || []).length + 1;

  return { raw, content: afterFrontmatter, contentStartLine };
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
export const VOID_HTML_TAGS: ReadonlySet<string> = new Set([
  'img', 'br', 'hr', 'source', 'input', 'wbr', 'area', 'col', 'embed',
]);

export const HTML_BLOCK_OPEN_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s|>|\/|$)/;

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
export interface TagCloseIndex {
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
export function findHtmlBlockEnd(
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

export const markProtectedLines = (lines: string[]): boolean[] => {
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
    const end = htmlBlockEndAt(lines, i, closeCache);
    if (end !== -1) {
      for (let idx = i; idx <= end; idx++) isProtected[idx] = true;
      i = end;
    }
  }
  return isProtected;
};

/**
 * The last line index of the raw HTML block that line `i` opens, or -1 when
 * line `i` does not open one. Three extents, the block parser's own: a leading
 * close tag runs to the next blank line, a void tag to the line that closes
 * it with `>`, any other tag to its balanced close (or only its own line when
 * it never closes). `closeCache` is per document (see `findHtmlBlockEnd`).
 */
export function htmlBlockEndAt(lines: string[], i: number, closeCache: Map<string, TagCloseIndex>): number {
  const trimmed = lines[i].trim();
  const htmlTagMatch = trimmed.match(HTML_BLOCK_OPEN_RE);
  if (!htmlTagMatch || !HTML_BLOCK_TAGS.has(htmlTagMatch[1].toLowerCase())) return -1;
  const tagName = htmlTagMatch[1].toLowerCase();
  let end = i;
  if (trimmed.startsWith('</')) {
    while (end + 1 < lines.length && lines[end + 1].trim() !== '') end++;
  } else if (VOID_HTML_TAGS.has(tagName)) {
    // Void element (e.g. <img>): no closing tag, but attributes can wrap across
    // lines. Consume until the line that actually closes the tag with `>` so a
    // multi-line <img> isn't truncated to a bare `<img` fragment.
    while (!lines[end].includes('>') && end + 1 < lines.length && lines[end + 1].trim() !== '') end++;
  } else {
    const openRe = new RegExp(`<${tagName}(?:\\s|>|/|$)`, 'gi');
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
    const depth = (lines[i].match(openRe) || []).length - (lines[i].match(closeRe) || []).length;
    // Scan ahead for the matching close tag via the shared, bounded/linear
    // helper. If none is ever found — a self-closing <video/>, or an unclosed
    // <picture>/<div> — do NOT swallow the rest of the document into this
    // block; keep it to the opening line.
    const found = findHtmlBlockEnd(lines, i, tagName, depth, closeCache);
    if (found > i) end = found;
  }
  return end;
}

/**
 * The index of the line that closes the backtick code fence opened at line
 * `i` (a run of at least as many backticks, any indentation), or
 * `lines.length` when the fence never closes and runs to the end. Only
 * backtick fences exist for this parser; `~~~` is ordinary text.
 */
export function codeFenceCloseIndex(lines: string[], i: number): number {
  const trimmed = lines[i].trim();
  const fenceLen = trimmed.match(/^`+/)?.[0].length ?? 3;
  const closingFence = new RegExp('^\\s*`{' + fenceLen + ',}');
  let j = i + 1;
  while (j < lines.length && !closingFence.test(lines[j])) j++;
  return j;
}

/**
 * Display math opened at line `i` with `$$` or `\[`: the body lines, the
 * index of the line holding the close, and any text after the close (which
 * the block parser re-reads as its own line). Null when no close exists on
 * the opening line or before the next blank line, in which case the line is
 * not math at all and must not swallow what follows.
 */
export function scanDisplayMath(
  lines: string[],
  i: number,
  delimiter: '$$' | '\\[',
): { body: string[]; closeLine: number; remainder: string } | null {
  const close = delimiter === '$$' ? '$$' : '\\]';
  const afterOpen = lines[i].trim().slice(2);
  const inlineClose = afterOpen.indexOf(close);
  if (inlineClose !== -1) {
    const body = afterOpen.slice(0, inlineClose).trim();
    return { body: body ? [body] : [], closeLine: i, remainder: afterOpen.slice(inlineClose + 2).trim() };
  }
  const scanned: string[] = afterOpen.trim() ? [afterOpen.trim()] : [];
  let j = i;
  while (j + 1 < lines.length) {
    j++;
    // A blank line ends the search: real display math has no blank line
    // before its close, so a blank means this opener was never closed.
    if (lines[j].trim() === '') break;
    const closeAt = lines[j].indexOf(close);
    if (closeAt !== -1) {
      const before = lines[j].slice(0, closeAt);
      if (before.trim()) scanned.push(before);
      return { body: scanned, closeLine: j, remainder: lines[j].slice(closeAt + 2).trim() };
    }
    scanned.push(lines[j]);
  }
  return null;
}

/** A directive container opener: `:::kind` alone on its line. */
export const DIRECTIVE_OPEN_RE = /^:::\s*([a-zA-Z][a-zA-Z0-9-]*)\s*$/;

/**
 * The index of the bare `:::` line that closes the directive opened at line
 * `i`, or `lines.length` when it never closes (the body then runs to the
 * end). Directives do not nest: the first bare `:::` closes the block, so a
 * `:::kind` line inside a body is body text.
 */
export function directiveCloseIndex(lines: string[], i: number): number {
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === ':::') return j;
  }
  return lines.length;
}

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
