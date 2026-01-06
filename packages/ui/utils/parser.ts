import { Block } from '../types';

/**
 * A simplified markdown parser that splits content into linear blocks.
 * For a production app, we would use a robust AST walker (remark),
 * but for this demo, we want predictable text-anchoring.
 */
export const parseMarkdownToBlocks = (markdown: string): Block[] => {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let currentId = 0;

  let buffer: string[] = [];
  let currentType: Block['type'] = 'paragraph';
  let currentLevel = 0;
  let bufferStartLine = 1; // Track the start line of the current buffer

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
    if (trimmed.match(/^(\*|-|\d+\.)\s/)) {
      flush(); // Treat each list item as a separate block for easier annotation
      // Calculate indentation level from leading whitespace
      const leadingWhitespace = line.match(/^(\s*)/)?.[1] || '';
      // Count spaces (2 spaces = 1 level) or tabs (1 tab = 1 level)
      const spaceCount = leadingWhitespace.replace(/\t/g, '  ').length;
      const listLevel = Math.floor(spaceCount / 2);

      // Remove list marker
      let content = trimmed.replace(/^(\*|-|\d+\.)\s/, '');

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
        order: currentId,
        startLine: currentLineNum
      });
      continue;
    }

    // Blockquotes
    if (trimmed.startsWith('>')) {
       // Check if previous was blockquote, if so, merge? No, separate for now
       flush();
       blocks.push({
         id: `block-${currentId++}`,
         type: 'blockquote',
         content: trimmed.replace(/^>\s*/, ''),
         order: currentId,
         startLine: currentLineNum
       });
       continue;
    }
    
    // Code blocks (naive)
    if (trimmed.startsWith('```')) {
      flush();
      const codeStartLine = currentLineNum;
      // Extract language from fence (e.g., ```rust → "rust")
      const language = trimmed.slice(3).trim() || undefined;
      // Fast forward until end of code block
      let codeContent = [];
      i++; // Skip start fence
      while(i < lines.length && !lines[i].trim().startsWith('```')) {
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

    // Tables (lines starting and containing |)
    if (trimmed.startsWith('|') || (trimmed.includes('|') && trimmed.match(/^\|?.+\|.+\|?$/))) {
      flush();
      const tableStartLine = currentLineNum;
      const tableLines: string[] = [line];

      // Collect all consecutive table lines
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        // Continue if line has table structure (contains | and looks like table content)
        if (nextLine.startsWith('|') || (nextLine.includes('|') && nextLine.match(/^\|?.+\|.+\|?$/))) {
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

export const exportDiff = (blocks: Block[], annotations: any[], globalAttachments: string[] = []): string => {
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

  let output = `# Plan Feedback\n\n`;

  // Add global reference images section if any
  if (globalAttachments.length > 0) {
    output += `## Reference Images\n`;
    output += `Please review these reference images (use the Read tool to view):\n`;
    globalAttachments.forEach((path, idx) => {
      output += `${idx + 1}. \`${path}\`\n`;
    });
    output += `\n`;
  }

  if (annotations.length > 0) {
    output += `I've reviewed this plan and have ${annotations.length} piece${annotations.length > 1 ? 's' : ''} of feedback:\n\n`;
  }

  sortedAnns.forEach((ann, index) => {
    const block = blocks.find(b => b.id === ann.blockId);

    output += `## ${index + 1}. `;

    switch (ann.type) {
      case 'DELETION':
        output += `Remove this\n`;
        output += `\`\`\`\n${ann.originalText}\n\`\`\`\n`;
        output += `> I don't want this in the plan.\n`;
        break;

      case 'INSERTION':
        output += `Add this\n`;
        output += `\`\`\`\n${ann.text}\n\`\`\`\n`;
        break;

      case 'REPLACEMENT':
        output += `Change this\n`;
        output += `**From:**\n\`\`\`\n${ann.originalText}\n\`\`\`\n`;
        output += `**To:**\n\`\`\`\n${ann.text}\n\`\`\`\n`;
        break;

      case 'COMMENT':
        output += `Feedback on: "${ann.originalText}"\n`;
        output += `> ${ann.text}\n`;
        break;

      case 'GLOBAL_COMMENT':
        output += `General feedback about the plan\n`;
        output += `> ${ann.text}\n`;
        break;
    }

    // Add attached images for this annotation
    if (ann.imagePaths && ann.imagePaths.length > 0) {
      output += `**Attached images:**\n`;
      ann.imagePaths.forEach((path: string) => {
        output += `- \`${path}\`\n`;
      });
    }

    output += '\n';
  });

  output += `---\n`;

  return output;
};