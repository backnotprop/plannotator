import { Block, type Annotation, type CodeAnnotation, type EditorAnnotation, type ImageAttachment } from '../types';
import { planDenyFeedback } from '@plannotator/shared/feedback-templates';

/**
 * Parsed YAML frontmatter as key-value pairs.
 */
export interface Frontmatter {
  [key: string]: string | string[];
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

  for (const line of frontmatterRaw.split('\n')) {
    const trimmedLine = line.trim();

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
]);

const HTML_BLOCK_OPEN_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s|>|\/|$)/;

/**
 * A simplified markdown parser that splits content into linear blocks.
 * For a production app, we would use a robust AST walker (remark),
 * but for this demo, we want predictable text-anchoring.
 */
export const parseMarkdownToBlocks = (markdown: string): Block[] => {
  const { content: cleanMarkdown, contentStartLine } = extractFrontmatter(markdown);
  const lines = cleanMarkdown.split('\n');
  const blocks: Block[] = [];
  let currentId = 0;

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
      } else {
        const openRe = new RegExp(`<${tagName}(?:\\s|>|/|$)`, 'gi');
        const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
        let depth = (line.match(openRe) || []).length - (line.match(closeRe) || []).length;
        while (depth > 0 && i + 1 < lines.length) {
          i++;
          htmlLines.push(lines[i]);
          depth += (lines[i].match(openRe) || []).length;
          depth -= (lines[i].match(closeRe) || []).length;
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
    // List continuation: indented line after a list item merges into it
    if (
      !prevLineWasBlank &&
      buffer.length === 0 &&
      blocks.length > 0 &&
      blocks[blocks.length - 1].type === 'list-item' &&
      /^\s+/.test(line)
    ) {
      blocks[blocks.length - 1].content += '\n' + trimmed;
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

/** Wrap feedback output with the deny preamble for pasting into agent sessions */
export const wrapFeedbackForAgent = (feedback: string): string =>
  planDenyFeedback(feedback);

export interface ExportAnnotationsOptions {
  sourceConverted?: boolean;
}

/** Compute the end line of a block from its content and type. */
const blockEndLine = (block: Block): number => {
  if (!block.content) return block.startLine;
  const contentLines = block.content.split('\n').length;
  if (block.type === 'code') return block.startLine + contentLines + 1;
  if (block.type === 'directive') return block.startLine + contentLines + 1;
  if (block.alertKind) return block.startLine + contentLines;
  return block.startLine + contentLines - 1;
};

/** Resolve the source-line label for a single annotation.
 *  Returns null for global comments, diff-view annotations, or missing blocks. */
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
