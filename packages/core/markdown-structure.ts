/** The span of a leading `--- … ---` frontmatter block. */
export function splitFrontmatter(markdown: string): { raw: string | null; content: string; contentStartLine: number } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { raw: null, content: markdown, contentStartLine: 1 };
  }

  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { raw: null, content: markdown, contentStartLine: 1 };
  }

  const raw = trimmed.slice(4, endIndex).trim();
  const rawAfterFrontmatter = trimmed.slice(endIndex + 4);
  const afterFrontmatter = rawAfterFrontmatter.trimStart();

  const leadingChars = markdown.length - trimmed.length;
  const consumedInTrimmed = endIndex + 4 + (rawAfterFrontmatter.length - afterFrontmatter.length);
  const consumedTotal = leadingChars + consumedInTrimmed;
  const contentStartLine = (markdown.slice(0, consumedTotal).match(/\n/g) || []).length + 1;

  return { raw, content: afterFrontmatter, contentStartLine };
}

/** Tag names that trigger a raw HTML block per CommonMark §4.6, Type 6. */
export const HTML_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'details', 'summary',
  'div', 'section', 'article', 'aside', 'header', 'footer',
  'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'p',
  'img', 'video', 'picture',
]);

/**
 * Void elements — no closing tag, so the block is a single line (don't scan ahead for a `</tag>`
 * that will never come).
 */
export const VOID_HTML_TAGS: ReadonlySet<string> = new Set([
  'img', 'br', 'hr', 'source', 'input', 'wbr', 'area', 'col', 'embed',
]);

export const HTML_BLOCK_OPEN_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s|>|\/|$)/;

const MAX_REF_LABEL_CHARS = 999;
const MAX_CODE_SPAN_CHARS = 5000;
// A pathological document could otherwise grow the map without bound; this keeps that growth
// bounded even though ordinary documents never approach it.
const MAX_TRACKED_DEFINITIONS = 20_000;

// The destination is a bare token or an <...> form; any trailing text must be a quoted or
// parenthesized title, otherwise the line is ordinary prose (so `[Reminder]: call the bank` is NOT
// a definition).
const REFERENCE_DEFINITION_RE = new RegExp(
  `^ {0,3}\\[([^\\]]{1,${MAX_REF_LABEL_CHARS}})\\]:[ \\t]*(?:<([^>]*)>|(\\S+))[ \\t]*(?:"[^"]*"|'[^']*'|\\([^)]*\\))?[ \\t]*\\r?$`,
);

const REFERENCE_LINK_RE = new RegExp(
  `(\`+)[^\\n]{0,${MAX_CODE_SPAN_CHARS}}?\\1|(!?)\\[([^\\]]{1,${MAX_REF_LABEL_CHARS}})\\](\\[([^\\]]{0,${MAX_REF_LABEL_CHARS}})\\])?`,
  'g',
);

const normalizeRefLabel = (label: string): string =>
  label.trim().replace(/\s+/g, ' ').toLowerCase();

/** Per-tag-name index backing `findHtmlBlockEnd`. */
export interface TagCloseIndex {
  augmented: number[];
  nextAtOrBelow: number[];
}

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
  let fenceLen = 0;
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
 * The last line index of the raw HTML block that line `i` opens, or -1 when line `i` does not open
 * one.
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
    while (!lines[end].includes('>') && end + 1 < lines.length && lines[end + 1].trim() !== '') end++;
  } else {
    const openRe = new RegExp(`<${tagName}(?:\\s|>|/|$)`, 'gi');
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
    const depth = (lines[i].match(openRe) || []).length - (lines[i].match(closeRe) || []).length;
    const found = findHtmlBlockEnd(lines, i, tagName, depth, closeCache);
    if (found > i) end = found;
  }
  return end;
}

export function codeFenceCloseIndex(lines: string[], i: number): number {
  const trimmed = lines[i].trim();
  const fenceLen = trimmed.match(/^`+/)?.[0].length ?? 3;
  const closingFence = new RegExp('^\\s*`{' + fenceLen + ',}');
  let j = i + 1;
  while (j < lines.length && !closingFence.test(lines[j])) j++;
  return j;
}

export function codeFenceFor(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

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
 * The index of the bare `:::` line that closes the directive opened at line `i`, or `lines.length`
 * when it never closes (the body then runs to the end).
 */
export function directiveCloseIndex(lines: string[], i: number): number {
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === ':::') return j;
  }
  return lines.length;
}

const resolveRefsInLine = (
  line: string,
  defs: Map<string, string>,
  usedLabels: Set<string>,
): string => {
  if (!line.includes('[')) return line;
  return line.replace(
    REFERENCE_LINK_RE,
    (match, codeTicks, bang, text, secondBracket, label, offset: number, whole: string) => {
      if (codeTicks !== undefined) return match;
      let refLabel: string;
      if (secondBracket === undefined) {
        if (whole[offset + match.length] === '(') return match;
        // Nor when it is a task-list checkbox marker at the start of a list item (`- [x]`); the
        // checkbox parser owns that `[x]`, and resolving it against a stray `x`/`X` definition
        // would clobber the item.
        if (/^[ xX]$/.test(text) && /^\s*(?:[-*+]|\d+[.)])\s+$/.test(whole.slice(0, offset))) {
          return match;
        }
        refLabel = text;
      } else {
        refLabel = label === '' ? text : label;
      }
      const normalized = normalizeRefLabel(refLabel);
      const dest = defs.get(normalized);
      if (!dest) return match;
      usedLabels.add(normalized);
      return `${bang}[${text}](${dest})`;
    },
  );
};

export const resolveReferenceLinks = (markdown: string): string => {
  if (!markdown.includes('[')) return markdown;
  const lines = markdown.split('\n');
  const isProtected = markProtectedLines(lines);
  const defs = new Map<string, string>();
  const defLabelByLine = new Array<string | null>(lines.length).fill(null);
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
      if (!rawLabel.startsWith('^') && defs.size < MAX_TRACKED_DEFINITIONS) {
        const label = normalizeRefLabel(rawLabel);
        const dest = match[2] !== undefined ? match[2] : match[3];
        if (label && dest && !defs.has(label)) defs.set(label, dest);
        defLabelByLine[i] = label;
      }
    } else {
      canStartDefinition = blank;
    }
  }
  if (defs.size === 0) return markdown;
  const usedLabels = new Set<string>();
  const resolved = lines.map((line, i) =>
    isProtected[i] || defLabelByLine[i] !== null ? line : resolveRefsInLine(line, defs, usedLabels),
  );
  return resolved
    .map((line, i) => {
      const label = defLabelByLine[i];
      if (label === null || !usedLabels.has(label)) return line;
      return line.endsWith('\r') ? '\r' : '';
    })
    .join('\n');
};
