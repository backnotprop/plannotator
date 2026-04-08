import { Block, type Annotation, type EditorAnnotation, type ImageAttachment } from '../types';
import { planDenyFeedback } from '@plannotator/shared/feedback-templates';

/**
 * Parsed YAML frontmatter as key-value pairs.
 */
export interface Frontmatter {
  [key: string]: string | string[];
}

/**
 * Extract YAML frontmatter from markdown if present.
 * Returns both the parsed frontmatter and the remaining markdown.
 */
export function extractFrontmatter(markdown: string): { frontmatter: Frontmatter | null; content: string } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, content: markdown };
  }

  // Find the closing ---
  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, content: markdown };
  }

  // Extract frontmatter content (between the --- delimiters)
  const frontmatterRaw = trimmed.slice(4, endIndex).trim();
  const afterFrontmatter = trimmed.slice(endIndex + 4).trimStart();

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

  return { frontmatter, content: afterFrontmatter };
}

/**
 * A simplified markdown parser that splits content into linear blocks.
 * For a production app, we would use a robust AST walker (remark),
 * but for this demo, we want predictable text-anchoring.
 */
export const parseMarkdownToBlocks = (markdown: string): Block[] => {
  const { content: cleanMarkdown } = extractFrontmatter(markdown);
  const lines = cleanMarkdown.split('\n');
  const blocks: Block[] = [];
  let currentId = 0;

  let buffer: string[] = [];
  let currentType: Block['type'] = 'paragraph';
  let currentLevel = 0;
  let bufferStartLine = 1; // Track the start line of the current buffer
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
    const currentLineNum = i + 1; // 1-based index
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
      if (
        !hasBlockMarker &&
        !prevIsMarkerQuote &&
        !prevLineWasBlank &&
        prevBlock?.type === 'blockquote'
      ) {
        prevBlock.content += '\n' + stripped;
      } else {
        blocks.push({
          id: `block-${currentId++}`,
          type: 'blockquote',
          content: stripped,
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

export const exportAnnotations = (blocks: Block[], annotations: any[], globalAttachments: ImageAttachment[] = [], title: string = 'Plan Feedback', subject: string = 'plan'): string => {
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
    const block = blocks.find(b => b.id === ann.blockId);

    output += `## ${index + 1}. `;

    // Add diff context label if annotation was created in diff view
    if (ann.diffContext) {
      output += `[In diff content] `;
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

export const exportLinkedDocAnnotations = (
  docAnnotations: Map<string, { annotations: Annotation[]; globalAttachments: ImageAttachment[] }>
): string => {
  let output = `\n# Linked Document Feedback\n\nThe following feedback is on documents referenced in the plan.\n\n`;

  for (const [filepath, { annotations, globalAttachments }] of docAnnotations) {
    if (annotations.length === 0 && globalAttachments.length === 0) continue;

    output += `## ${filepath}\n\n`;

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

