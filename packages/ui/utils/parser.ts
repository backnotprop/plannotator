import type { Block, Annotation, CodeAnnotation, EditorAnnotation, ImageAttachment } from '../types';
import { planDenyFeedback } from '@plannotator/core/feedback-templates';
import { resolveReplyParents } from '@plannotator/core/annotation-threads';
import { diagramAnchorLocationLine, parseDiagramAnchor } from '@plannotator/core/diagram-anchor';
import {
  formatQuestionAnswerLines,
  formatQuestionAnswersSection,
  indexQuestionBlocks,
  parseQuestionAnswer,
  questionExportItems,
  type QuestionAnswer,
  type QuestionExportItem,
} from '@plannotator/core/question-block';
import {
  DIRECTIVE_OPEN_RE,
  HTML_BLOCK_TAGS,
  codeFenceCloseIndex,
  directiveCloseIndex,
  htmlBlockEndAt,
  resolveReferenceLinks,
  scanDisplayMath,
  splitFrontmatter,
  type TagCloseIndex,
} from '@plannotator/core/markdown-structure';
import { skillReferenceExportBlock } from './skillReferences';

// The structural helpers moved to `@plannotator/core/markdown-structure` so
// `findQuestionBlocks` (core) splits a document exactly as this parser does.
export { HTML_BLOCK_TAGS, resolveReferenceLinks };

/**
 * Parsed YAML frontmatter value: scalar string, array, or nested map.
 */
export type FrontmatterValue =
  | string
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

/**
 * Parsed YAML frontmatter as key-value pairs.
 */
export interface Frontmatter {
  [key: string]: FrontmatterValue;
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
 * Parse a simple `key: value` pair from a line. Returns null if the line
 * is not a valid YAML mapping entry (e.g. scalar URLs or quoted strings).
 */
function parseKeyValue(str: string): { key: string; value: string } | null {
  // A QUOTED KEY is still a mapping entry: `"title": "Doc"` must yield
  // { title: "Doc" }, not nothing. Only a line that is nothing but a quoted
  // scalar (`"just a string"`) is not an entry — which is the case the char
  // after the closing quote distinguishes.
  const quote = str[0];
  if (quote === '"' || quote === "'") {
    const closing = str.indexOf(quote, 1);
    if (closing === -1) return null;
    if (str[closing + 1] !== ':') return null;
    // Same rule the unquoted branch applies: `key:value` is a scalar, not a
    // mapping entry. A colon at end of line (empty value) is fine.
    const afterColon = str[closing + 2];
    if (afterColon !== undefined && afterColon !== ' ' && afterColon !== '\t') {
      return null;
    }
    return { key: str.slice(1, closing), value: str.slice(closing + 2).trim() };
  }
  const colonIndex = str.indexOf(':');
  if (colonIndex <= 0) return null;
  if (colonIndex < str.length - 1 && str[colonIndex + 1] !== ' ' && str[colonIndex + 1] !== '\t') {
    return null;
  }
  const key = str.slice(0, colonIndex).trim();
  const value = str.slice(colonIndex + 1).trim();
  return { key, value };
}

/**
 * Extract YAML frontmatter from markdown if present.
 * Returns the parsed frontmatter, the remaining markdown, and the 1-based
 * line number where content begins in the original file (so downstream
 * line references stay accurate).
 */
export function extractFrontmatter(markdown: string): { frontmatter: Frontmatter | null; content: string; contentStartLine: number } {
  const { raw: frontmatterRaw, content: afterFrontmatter, contentStartLine } = splitFrontmatter(markdown);
  if (frontmatterRaw === null) {
    return { frontmatter: null, content: markdown, contentStartLine: 1 };
  }

  // Parse simple YAML (key: value pairs, indentation-aware)
  const frontmatter: Frontmatter = {};
  const mapStack: { indent: number; map: { [key: string]: FrontmatterValue } }[] = [
    { indent: -1, map: frontmatter },
  ];
  const arrayStack: { indent: number; array: FrontmatterValue[] }[] = [];
  let pendingKey: {
    key: string;
    indent: number;
    parentMap: { [key: string]: FrontmatterValue };
  } | null = null;

  const lines = frontmatterRaw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].replace(/\r$/, '');
    const trimmedLine = rawLine.trim();

    if (!trimmedLine) continue;

    const lineIndent = indentWidth(rawLine);

    // Array item (- value or - key: value)
    if (trimmedLine.startsWith('- ')) {
      const afterDash = trimmedLine.slice(2).trim();
      const kv = parseKeyValue(afterDash);

      if (pendingKey && lineIndent >= pendingKey.indent) {
        const newArray: FrontmatterValue[] = [];
        pendingKey.parentMap[pendingKey.key] = newArray;
        arrayStack.push({ indent: lineIndent, array: newArray });
        pendingKey = null;
      } else {
        pendingKey = null;
        while (arrayStack.length > 0 && arrayStack[arrayStack.length - 1].indent > lineIndent) {
          arrayStack.pop();
        }
      }

      while (mapStack.length > 1 && mapStack[mapStack.length - 1].indent >= lineIndent) {
        mapStack.pop();
      }

      const targetArray = arrayStack.length > 0 ? arrayStack[arrayStack.length - 1].array : null;

      if (kv) {
        const blockScalar = kv.value.match(/^([|>])[+-]?$/);
        let scalarVal = kv.value;
        if (blockScalar) {
          const { value: parsedScalar, endIndex } = parseBlockScalar(
            lines,
            i + 1,
            lineIndent,
            blockScalar[1] === '>',
          );
          scalarVal = parsedScalar;
          i = endIndex;
        }

        const mapElem: { [key: string]: FrontmatterValue } = {};
        if (scalarVal) {
          mapElem[kv.key] = scalarVal;
        } else {
          // The key sits two columns right of the dash (`- meta:`), so that —
          // not the dash's own indent — is the indent its nested block must be
          // measured against. Recording `lineIndent` here made the nested map
          // swallow the item's later sibling keys, because a sibling indented
          // to the key's column never dedented past the dash.
          pendingKey = { key: kv.key, indent: lineIndent + 2, parentMap: mapElem };
        }

        if (targetArray) {
          targetArray.push(mapElem);
        }
        mapStack.push({ indent: lineIndent, map: mapElem });
      } else {
        if (targetArray) {
          targetArray.push(afterDash);
        }
      }
      continue;
    }

    // Key: value pair
    const kv = parseKeyValue(trimmedLine);
    if (kv) {
      if (pendingKey) {
        if (lineIndent > pendingKey.indent) {
          const newMap: { [key: string]: FrontmatterValue } = {};
          pendingKey.parentMap[pendingKey.key] = newMap;
          mapStack.push({ indent: pendingKey.indent, map: newMap });
        }
        pendingKey = null;
      }

      while (arrayStack.length > 0 && arrayStack[arrayStack.length - 1].indent >= lineIndent) {
        arrayStack.pop();
      }
      while (mapStack.length > 1 && mapStack[mapStack.length - 1].indent >= lineIndent) {
        mapStack.pop();
      }

      const parentMap = mapStack[mapStack.length - 1].map;

      // Block scalar: `|` or `>`
      const blockScalar = kv.value.match(/^([|>])[+-]?$/);
      if (blockScalar) {
        const { value: scalarValue, endIndex } = parseBlockScalar(
          lines,
          i + 1,
          lineIndent,
          blockScalar[1] === '>',
        );
        parentMap[kv.key] = scalarValue;
        i = endIndex;
        continue;
      }

      if (kv.value) {
        parentMap[kv.key] = kv.value;
      } else {
        pendingKey = { key: kv.key, indent: lineIndent, parentMap };
      }
    }
  }

  return { frontmatter, content: afterFrontmatter, contentStartLine };
}


export interface ParseMarkdownOptions {
  /**
   * Strip a leading `--- ... ---` pair as frontmatter (default true).
   * Pass false for non-markdown plain-text sources (.yaml/.json/.txt/…)
   * where the delimiters are real content — a multi-document YAML starts
   * with them (see shouldStripFrontmatter in @plannotator/core/annotatable).
   */
  frontmatter?: boolean;
}


/**
 * The block list for a whole-file diagram source (`plannotator annotate
 * flow.mmd`): ONE code block carrying the file's raw text, which `Viewer`
 * hands to the same `DiagramBlock` a ```mermaid fence in a plan produces.
 * Everything downstream — diagram comments, the annotations rail, the export's
 * `Diagram node <label> (<id>), line <n>` location line, drafts, restore — is
 * the fence path unchanged.
 *
 * `diagramSourceLineOffset: 0` is the load-bearing part. `DiagramBlock` passes
 * it as the viewer's `sourceLineOffset` and the codec adds it to the 1-based
 * line WITHIN the diagram source; for a fence that offset is the fence's own
 * opening line, which sits one line above the diagram's first line. A diagram
 * FILE has no fence, so its first line is document line 1 and the offset is 0
 * — the 1 a synthesized ```mermaid wrapper would produce puts every exported
 * diagram line one too high. `startLine`/`sourceLineCount` still describe the
 * block itself, so the export's `(lines a–b)` label names the file's real
 * span.
 */
export const diagramDocumentBlocks = (text: string, kind: 'mermaid' | 'graphviz'): Block[] => [
  {
    id: 'block-0',
    type: 'code',
    content: text,
    // `dot` is what isGraphvizLanguage reads for the Graphviz engine.
    language: kind === 'graphviz' ? 'dot' : 'mermaid',
    order: 1,
    startLine: 1,
    // A trailing newline ends the last line, it does not start another.
    sourceLineCount: text === '' ? 0 : text.replace(/\n$/, '').split('\n').length,
    diagramSourceLineOffset: 0,
  },
];

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
    
    // Code blocks (naive). Count backticks in the opening fence to support
    // nested fences (e.g. ```` wrapping ```); the extent is shared with core.
    if (trimmed.startsWith('```')) {
      flush();
      const codeStartLine = currentLineNum;
      const fenceLen = trimmed.match(/^`+/)?.[0].length ?? 3;
      // Extract language from fence (e.g., ```rust → "rust")
      const language = trimmed.slice(fenceLen).trim() || undefined;
      const close = codeFenceCloseIndex(lines, i);
      const codeContent = lines.slice(i + 1, close);
      i = close;
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

    // Display math: $$ ... $$ or \[ ... \] — only when the close actually
    // exists. An unclosed opener (a stray delimiter, informal money like
    // "$$100k for infra", a `\[deprecated\]`-style line) must NOT swallow the
    // rest of the document: scanDisplayMath scans ahead without committing
    // and answers null, and the line falls through as ordinary text.
    const mathDelimiter = trimmed.startsWith('$$') ? '$$' : trimmed.startsWith('\\[') ? '\\[' : null;
    const math = mathDelimiter ? scanDisplayMath(lines, i, mathDelimiter) : null;
    if (math) {
      flush();
      const mathStartLine = currentLineNum;
      i = math.closeLine;
      blocks.push({
        id: `block-${currentId++}`,
        type: 'math',
        content: math.body.join('\n'),
        order: currentId,
        startLine: mathStartLine,
        sourceLineCount: i + contentStartLine - mathStartLine + 1,
      });
      // Trailing text after the close isn't math — reprocess it as its own
      // line so it renders normally instead of being swallowed into the block.
      if (math.remainder) {
        lines[i] = math.remainder;
        i--;
      }
      continue;
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

    // Directive container: `:::kind` opens, `:::` closes. Inline kind is
    // restricted to simple identifiers (letters, digits, hyphens). Body is
    // accumulated verbatim and rendered with inline markdown.
    const directiveOpen = trimmed.match(DIRECTIVE_OPEN_RE);
    if (directiveOpen) {
      flush();
      const directiveStartLine = currentLineNum;
      const kind = directiveOpen[1].toLowerCase();
      const close = directiveCloseIndex(lines, i);
      const bodyLines = lines.slice(i + 1, close);
      i = close;
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

    // Raw HTML blocks. A line starting with a known block-level HTML tag
    // opens an HTML block. For opening tags we accumulate until the matching
    // close tag is balanced (so `<details>…blank line…</details>` renders as
    // one unit, matching GitHub's flavored behavior rather than strict
    // CommonMark §4.6 Type 6 blank-line termination). For a line that starts
    // with a close tag, we fall back to blank-line termination. Content is
    // sanitized at render time, not here.
    const htmlEnd = htmlBlockEndAt(lines, i, htmlCloseCache);
    if (htmlEnd !== -1) {
      flush();
      const htmlStartLine = currentLineNum;
      const htmlLines = lines.slice(i, htmlEnd + 1);
      i = htmlEnd;
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
/** Defense in depth for page-controlled strings in agent-read feedback:
 *  collapse whitespace (no injected markdown structure) and defuse any
 *  backtick run that could close an inline code span or a fence. */
const safeInline = (value: unknown, max = 200): string => {
  const collapsed = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const defused = collapsed.replace(/`+/g, "'");
  return defused.length > max ? `${defused.slice(0, max)}…` : defused;
};

/** The synthesized quote the bridge posts for a text-less element
 *  (`[element: Navigation]`): a placeholder, not something the agent can use. */
const isElementPlaceholderQuote = (text: unknown): boolean =>
  typeof text === 'string' && /^\[element: [^\]]*\]$/.test(text.trim());

/** The heading line for a COMMENT entry. When the quote is the bridge's
 *  text-less placeholder and the annotation carries element context, name the
 *  element instead (`Feedback on the <nav> element — "Primary"`); every other
 *  annotation keeps the quote line exactly as before. */
const commentHeadingLine = (ann: any): string => {
  const context = ann?.elementContext;
  if (context && typeof context.tag === 'string' && isElementPlaceholderQuote(ann.originalText)) {
    const tag = safeInline(context.tag, 32);
    const name = context.name ? safeInline(context.name, 120) : '';
    return `Feedback on the <${tag}> element${name ? ` — "${name}"` : ''}`;
  }
  return `Feedback on: "${ann.originalText}"`;
};

export interface ElementContextExportOptions {
  /** Emit the live-app route line. The grouped export already prints a
   *  `## Page:` heading, so it passes false; a single copied entry passes true. */
  includeRoute?: boolean;
  /** Print the identity lines WITHOUT the fenced outline, for model turns where
   *  the 600-char outline is the expensive part. Default true. */
  includeOutline?: boolean;
}

/** The agent-facing element block for a raw-HTML / live-app pinpoint: a
 *  fenced HTML skeleton (the one markdown construct whose interior cannot
 *  become structure) plus the identity lines an agent greps for. Emits
 *  nothing when the annotation carries no context, keeping every other
 *  annotation's output byte-identical. */
export const elementContextExportBlock = (ann: any, opts: ElementContextExportOptions = {}): string => {
  const context = ann?.elementContext;
  if (!context || typeof context !== 'object' || typeof context.tag !== 'string') return '';
  const includeOutline = opts.includeOutline ?? true;
  let block = '';
  if (includeOutline && typeof context.outline === 'string' && context.outline.trim()) {
    // Fence at 4 backticks; the boundary already defuses 3+ runs inside the
    // outline, and a 4-run here cannot be closed by anything the page wrote.
    const outline = context.outline.replace(/`{3,}/g, "'''").trim();
    block += `\n\`\`\`\`html\n${outline}\n\`\`\`\`\n`;
  } else {
    block += '\n';
  }
  const selector = ann?.htmlAnchor?.selector;
  if (typeof selector === 'string' && selector) block += `- **selector** \`${safeInline(selector, 300)}\`\n`;
  if (context.path) block += `- **path** \`${safeInline(context.path, 512)}\`\n`;
  const identity: string[] = [];
  if (context.role) identity.push(`**role** ${safeInline(context.role, 32)}`);
  if (context.name) identity.push(`**name** "${safeInline(context.name, 120)}"`);
  if (context.component) identity.push(`**component** \`${safeInline(context.component, 100)}\``);
  if (identity.length) block += `- ${identity.join(' · ')}\n`;
  if (Array.isArray(context.attrs) && context.attrs.length) {
    const attrs = context.attrs
      .filter((pair: unknown) => Array.isArray(pair) && pair.length === 2)
      .map((pair: [string, string]) => `${safeInline(pair[0], 40)}="${safeInline(pair[1], 120)}"`)
      .join(' ');
    if (attrs) block += `- **attrs** \`${attrs.replace(/`/g, "'")}\`\n`;
  }
  if (context.text) block += `- **text** "${safeInline(context.text, 300)}"\n`;
  if (opts.includeRoute && context.page && context.page.url) {
    const title = context.page.title ? ` — "${safeInline(context.page.title, 200)}"` : '';
    block += `- **route** \`${safeInline(context.page.url, 2048)}\`${title}\n`;
  }
  const r = context.rect;
  if (r && ['x', 'y', 'w', 'h', 'vw', 'vh'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) {
    block += `- **box** ${r.x},${r.y} ${r.w}×${r.h} (viewport ${r.vw}×${r.vh})\n`;
  }
  const near: string[] = [];
  if (context.landmark) near.push(safeInline(context.landmark, 80));
  if (context.heading) near.push(`heading ${safeInline(context.heading, 130)}`);
  if (near.length) block += `- **near** ${near.join(' · ')}\n`;
  return block;
};

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
    // Element identity for the agent, one line per extra target: the
    // selector and the path (a full context block per target would swamp
    // the comment; the rest of the context stays persisted, not exported).
    //
    // Gated on the target carrying element context, which is what makes the
    // element-context work additive in the literal sense it claims: a target
    // captured before it existed (or restored from an older draft) has an
    // anchor but no context, and exports byte-identically to before.
    const locators: string[] = [];
    if (target?.context && typeof target.context === 'object') {
      const selector = target?.anchor?.selector;
      if (typeof selector === 'string' && selector) locators.push(`\`${safeInline(selector, 300)}\``);
      const path = target?.context?.path;
      if (typeof path === 'string' && path) locators.push(`\`${safeInline(path, 512)}\``);
    }
    block += `- ${label}"${clipped}"${locators.length ? ` — ${locators.join(' · ')}` : ''}\n`;
  });
  return block;
};

/**
 * One annotation rendered as a standalone feedback entry (no number, no
 * document heading), for hosts that surface a single annotation to an agent.
 * The body is the same shape the full export emits for the entry, including
 * the element block, so a standalone entry never drifts from what Send
 * Feedback delivers; the live-app route line is included here because the
 * standalone entry has no `## Page:` heading above it. Plannotator's own
 * panel chrome does not use it.
 */
export const exportAnnotationEntry = (ann: any, opts: ElementContextExportOptions = { includeRoute: true }): string => {
  // An answer to a `:::question` block: the question and the answer lines.
  const answer = ann?.questionAnswer == null ? null : parseQuestionAnswer(ann.questionAnswer);
  if (answer) {
    return `Answer to the question "${safeInline(answer.prompt, 400)}"\n${formatQuestionAnswerLines(answer)}`;
  }
  let output = '';
  switch (ann?.type) {
    case 'DELETION':
      output += `Remove this\n\`\`\`\n${ann.originalText}\n\`\`\`\n`;
      break;
    case 'GLOBAL_COMMENT':
      output += `General feedback\n> ${ann.text}\n`;
      break;
    default:
      if (ann?.isQuickLabel) {
        output += `[${ann.text}] ${commentHeadingLine(ann)}\n`;
        if (ann.quickLabelTip) output += `> ${ann.quickLabelTip}\n`;
      } else {
        output += `${commentHeadingLine(ann)}\n${diagramLocationExportLine(ann)}> ${ann?.text ?? ''}\n`;
      }
  }
  const resolvedOpts: ElementContextExportOptions = {
    includeRoute: opts.includeRoute ?? true,
    ...(opts.includeOutline !== undefined ? { includeOutline: opts.includeOutline } : {}),
  };
  output += elementContextExportBlock(ann, resolvedOpts);
  output += additionalTargetsExportBlock(ann);
  if (Array.isArray(ann?.images) && ann.images.length > 0) {
    output += `**Attached images:**\n`;
    ann.images.forEach((img: ImageAttachment) => {
      output += `- [${img.name}] \`${img.path}\`\n`;
    });
  }
  return output;
};

/** The location line under a comment made on a rendered diagram part:
 *  `Diagram node Approve? (D), line 4` — the part's own id (what the agent
 *  greps the fence for) and the DOCUMENT line that declares it. Emits
 *  nothing for every other annotation, keeping their output byte-identical;
 *  a malformed anchor (an older or foreign writer) is skipped, never thrown. */
const diagramLocationExportLine = (ann: any): string => {
  const anchor = ann?.diagramAnchor === undefined ? null : parseDiagramAnchor(ann.diagramAnchor);
  return anchor === null ? '' : `${safeInline(diagramAnchorLocationLine(anchor), 600)}\n`;
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

/** Separate valid question answers from ordinary feedback. A row whose
 *  `questionAnswer` fails validation stays ordinary feedback (its one-line
 *  text still reads), so nothing is ever dropped. */
const splitQuestionAnswers = (list: any[]): { answers: QuestionAnswer[]; annotations: any[] } => {
  const answers: QuestionAnswer[] = [];
  const annotations: any[] = [];
  for (const ann of list) {
    const answer = ann?.questionAnswer == null ? null : parseQuestionAnswer(ann.questionAnswer);
    if (answer) answers.push(answer);
    else annotations.push(ann);
  }
  return { answers, annotations };
};

/** Export items when a document's blocks are unknown: the answers' own
 *  prompts and lines, numbered in answer order. */
const questionItemsFromAnswers = (answers: QuestionAnswer[]): QuestionExportItem[] =>
  answers.map((a, i) => ({
    key: a.key,
    number: i + 1,
    prompt: a.prompt,
    ...(a.sourceLine ? { line: a.sourceLine } : {}),
    recommendedLabels: [],
    settled: false,
  }));

export const exportAnnotations = (
  blocks: Block[],
  allAnnotations: any[],
  globalAttachments: ImageAttachment[] = [],
  title: string = 'Plan Feedback',
  subject: string = 'plan',
  opts: ExportAnnotationsOptions = {},
): string => {
  // Answers to `:::question` blocks are printed first, in their own section,
  // and never counted as numbered feedback.
  const { answers, annotations } = splitQuestionAnswers(allAnnotations);
  const answersSection = answers.length > 0
    ? formatQuestionAnswersSection(questionExportItems(indexQuestionBlocks(blocks)), answers, { headingLevel: 2 })
    : '';
  if (annotations.length === 0 && globalAttachments.length === 0 && !answersSection) {
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

  output += answersSection;

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

  // Live app sessions stamp annotations with the page they were made on.
  // When any exported annotation carries a pageUrl, entries are grouped under
  // per-page `## Page:` headings in order of first appearance and every entry
  // demotes to `###` so it nests BELOW its page header (a `### Page:` header
  // over `##` entries would invert the hierarchy); annotations without a page
  // (e.g. globals) come first under no heading, at the same `###` level so
  // entries render uniformly. Numbers stay GLOBAL: each entry keeps the
  // number of its position in the ungrouped order, matching the on-page
  // marker numbering, so grouped sections may show non-contiguous numbers.
  // With no pageUrl anywhere the output is byte-identical to the ungrouped
  // export (`## N.` entries, no page headers).
  const hasPageGroups = sortedAnns.some(
    (a: any) => typeof a.pageUrl === 'string' && a.pageUrl.length > 0,
  );
  const annotationNumbers = new Map<any, number>(
    sortedAnns.map((ann, index) => [ann, index + 1]),
  );
  let emitOrder = sortedAnns;
  if (hasPageGroups) {
    const unpaged = sortedAnns.filter((a: any) => !a.pageUrl);
    const pageOrder: string[] = [];
    for (const ann of sortedAnns) {
      if (ann.pageUrl && !pageOrder.includes(ann.pageUrl)) pageOrder.push(ann.pageUrl);
    }
    emitOrder = [
      ...unpaged,
      ...pageOrder.flatMap((page) => sortedAnns.filter((a: any) => a.pageUrl === page)),
    ];
  }

  // Threaded replies (`inReplyTo`): a reply is emitted as a nested exchange
  // under its parent's entry rather than as its own numbered entry, so the
  // coding agent reads the conversation in order. The threading rule is the
  // shared one (resolveReplyParents): a reply whose parent is not in the
  // export, a self-reference, and every member of an inReplyTo cycle render
  // as ordinary entries in original order, so no annotation is ever dropped
  // and the header count always equals what is emitted. With no `inReplyTo`
  // anywhere the output is byte-identical to the ungrouped export.
  const replyParents = resolveReplyParents(sortedAnns as any[]);
  const isReply = (a: any) => replyParents.get(a.id) != null;
  const hasReplies = sortedAnns.some(isReply);
  // Children are grouped once (creation order within a parent); the old
  // per-level re-filter and re-sort of the whole list made a long thread
  // quadratic in both time and output size.
  const repliesByParent = new Map<string, any[]>();
  if (hasReplies) {
    for (const a of sortedAnns as any[]) {
      const parent = replyParents.get(a.id);
      if (!parent) continue;
      const list = repliesByParent.get(parent) ?? [];
      list.push(a);
      repliesByParent.set(parent, list);
    }
    for (const list of repliesByParent.values()) list.sort((a: any, b: any) => a.createdA - b.createdA);
    emitOrder = emitOrder.filter((a) => !isReply(a));
    // Numbers stay consecutive over the entries that are actually emitted.
    annotationNumbers.clear();
    emitOrder.forEach((ann, index) => annotationNumbers.set(ann, index + 1));
  }
  // Nesting indent is capped so the export stays linear in the thread size
  // (an uncapped indent on a 5,000-deep chain is 25 MB of whitespace) and
  // the emission is an explicit stack rather than recursion, so a deep chain
  // costs neither stack frames nor repeated string copies.
  const MAX_REPLY_INDENT_DEPTH = 8;
  const replyBlock = (parent: any): string => {
    const parts: string[] = [];
    const stack: Array<{ reply: any; depth: number }> = [];
    const pushReplies = (of: any, depth: number) => {
      const replies = repliesByParent.get(of.id);
      if (!replies) return;
      for (let i = replies.length - 1; i >= 0; i--) stack.push({ reply: replies[i], depth });
    };
    pushReplies(parent, 0);
    while (stack.length > 0) {
      const { reply, depth } = stack.pop()!;
      const who = reply.author ? `${reply.author}` : 'reply';
      const indent = '  '.repeat(Math.min(depth, MAX_REPLY_INDENT_DEPTH));
      parts.push(`${indent}- **Reply (${who}):** ${String(reply.text ?? '').replace(/\r?\n/g, `\n${indent}  `)}\n`);
      if (reply.images && reply.images.length > 0) {
        reply.images.forEach((img: ImageAttachment) => {
          parts.push(`${indent}  - [${img.name}] \`${img.path}\`\n`);
        });
      }
      pushReplies(reply, depth + 1);
    }
    return parts.join('');
  };

  let lastEmittedPage: string | null = null;
  emitOrder.forEach((ann) => {
    if (hasPageGroups && ann.pageUrl && ann.pageUrl !== lastEmittedPage) {
      output += `## Page: ${ann.pageUrl}\n\n`;
      lastEmittedPage = ann.pageUrl;
    }
    output += `${hasPageGroups ? '###' : '##'} ${annotationNumbers.get(ann)}. `;

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
          output += `[${ann.text}] ${commentHeadingLine(ann)}\n`;
          output += diagramLocationExportLine(ann);
          if (ann.quickLabelTip) {
            output += `> ${ann.quickLabelTip}\n`;
          }
        } else {
          output += `${commentHeadingLine(ann)}\n`;
          output += diagramLocationExportLine(ann);
          output += `> ${ann.text}\n`;
        }
        break;

      case 'GLOBAL_COMMENT':
        output += `General feedback about the ${subject}\n`;
        output += `> ${ann.text}\n`;
        break;
    }

    // Raw-HTML / live-app pinpoints describe their element for the agent
    // (the grouped export's `## Page:` heading already carries the route).
    output += elementContextExportBlock(ann, { includeRoute: false });
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

    // Threaded replies nest under the entry they answer.
    if (hasReplies) {
      const thread = replyBlock(ann);
      if (thread) output += `**Replies:**\n${thread}`;
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

  for (const [filepath, { annotations: docAnnotationList, globalAttachments, blocks: docBlocks, markdown: docMarkdown, isConverted }] of docAnnotations) {
    if (docAnnotationList.length === 0 && globalAttachments.length === 0) continue;
    const { answers, annotations } = splitQuestionAnswers(docAnnotationList);

    output += `## ${filepath}${isConverted ? ' (converted from HTML — line numbers refer to converted markdown)' : ''}\n\n`;

    if (answers.length > 0) {
      const questionBlocks = docBlocks ?? (docMarkdown !== undefined ? parseMarkdownToBlocks(docMarkdown) : null);
      const items = questionBlocks
        ? questionExportItems(indexQuestionBlocks(questionBlocks))
        : questionItemsFromAnswers(answers);
      output += formatQuestionAnswersSection(items, answers, { headingLevel: 3 });
    }

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

    if (annotations.length > 0 || answers.length === 0) {
      output += `I've reviewed this document and have ${annotations.length} piece${annotations.length !== 1 ? 's' : ''} of feedback:\n\n`;
    }

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
          output += `${commentHeadingLine(ann)}\n`;
          output += diagramLocationExportLine(ann);
          output += `> ${ann.text}\n`;
          break;

        case 'GLOBAL_COMMENT':
          output += `General feedback about the document\n`;
          output += `> ${ann.text}\n`;
          break;
      }

      output += elementContextExportBlock(ann, { includeRoute: false });
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
