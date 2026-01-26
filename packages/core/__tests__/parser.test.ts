/**
 * Tests for @plannotator/core parser
 */

import { describe, test, expect } from 'bun:test';
import { parseMarkdownToBlocks, exportDiff, extractFrontmatter, Frontmatter } from '../parser';
import { Annotation, AnnotationType, Block } from '../types';

describe('extractFrontmatter', () => {
  test('extracts simple frontmatter', () => {
    const markdown = `---
title: My Plan
author: Claude
---

# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.title).toBe('My Plan');
    expect(result.frontmatter?.author).toBe('Claude');
    expect(result.content.trim()).toBe('# Content');
  });

  test('handles array values in frontmatter', () => {
    const markdown = `---
tags:
  - javascript
  - typescript
---

Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter?.tags).toEqual(['javascript', 'typescript']);
  });

  test('returns null frontmatter when not present', () => {
    const markdown = `# No Frontmatter

Just content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  test('handles unclosed frontmatter', () => {
    const markdown = `---
title: Unclosed

Content without closing`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
  });
});

describe('parseMarkdownToBlocks', () => {
  test('parses headings with correct levels', () => {
    const markdown = `# Heading 1
## Heading 2
### Heading 3`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].level).toBe(1);
    expect(blocks[0].content).toBe('Heading 1');
    expect(blocks[1].level).toBe(2);
    expect(blocks[2].level).toBe(3);
  });

  test('parses paragraphs', () => {
    const markdown = `First paragraph.

Second paragraph.`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content).toBe('First paragraph.');
    expect(blocks[1].content).toBe('Second paragraph.');
  });

  test('parses code blocks with language', () => {
    const markdown = `\`\`\`typescript
const x: number = 42;
console.log(x);
\`\`\``;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].language).toBe('typescript');
    expect(blocks[0].content).toBe('const x: number = 42;\nconsole.log(x);');
  });

  test('parses code blocks without language', () => {
    const markdown = `\`\`\`
plain code
\`\`\``;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks[0].language).toBeUndefined();
  });

  test('parses list items with correct indentation', () => {
    const markdown = `- Item 1
  - Nested item
    - Double nested
- Item 2`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(4);
    expect(blocks[0].type).toBe('list-item');
    expect(blocks[0].level).toBe(0);
    expect(blocks[1].level).toBe(1);
    expect(blocks[2].level).toBe(2);
    expect(blocks[3].level).toBe(0);
  });

  test('parses checkboxes', () => {
    const markdown = `- [x] Done task
- [ ] Pending task
- Regular item`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks[0].checked).toBe(true);
    expect(blocks[0].content).toBe('Done task');
    expect(blocks[1].checked).toBe(false);
    expect(blocks[1].content).toBe('Pending task');
    expect(blocks[2].checked).toBeUndefined();
  });

  test('parses blockquotes', () => {
    const markdown = `> This is a quote
> With multiple lines`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('blockquote');
    expect(blocks[0].content).toBe('This is a quote');
  });

  test('parses horizontal rules', () => {
    const markdown = `Content before

---

Content after`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(3);
    expect(blocks[1].type).toBe('hr');
  });

  test('parses tables', () => {
    const markdown = `| Col 1 | Col 2 |
|-------|-------|
| A     | B     |
| C     | D     |`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].content).toContain('Col 1');
  });

  test('tracks start line numbers', () => {
    const markdown = `# Heading

Paragraph

- List item`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks[0].startLine).toBe(1);
    expect(blocks[1].startLine).toBe(3);
    expect(blocks[2].startLine).toBe(5);
  });

  test('generates unique block IDs', () => {
    const markdown = `# One
# Two
# Three`;

    const blocks = parseMarkdownToBlocks(markdown);
    const ids = blocks.map(b => b.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  test('strips frontmatter before parsing', () => {
    const markdown = `---
title: Test
---

# Actual Content`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].content).toBe('Actual Content');
  });

  test('handles numbered lists', () => {
    const markdown = `1. First
2. Second
3. Third`;

    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('list-item');
    expect(blocks[0].content).toBe('First');
  });
});

describe('exportDiff', () => {
  const createBlock = (id: string, content: string): Block => ({
    id,
    type: 'paragraph',
    content,
    order: 1,
    startLine: 1,
  });

  const createAnnotation = (
    id: string,
    blockId: string,
    type: AnnotationType,
    originalText: string,
    text?: string
  ): Annotation => ({
    id,
    blockId,
    startOffset: 0,
    endOffset: originalText.length,
    type,
    originalText,
    text,
    createdAt: Date.now(),
  });

  test('returns "No changes" for empty annotations', () => {
    const blocks = [createBlock('b1', 'Hello')];
    const result = exportDiff(blocks, []);

    expect(result).toBe('No changes detected.');
  });

  test('exports deletion annotations', () => {
    const blocks = [createBlock('b1', 'Hello world')];
    const annotations = [
      createAnnotation('a1', 'b1', AnnotationType.DELETION, 'Hello'),
    ];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('# Plan Feedback');
    expect(result).toContain('Remove this');
    expect(result).toContain('Hello');
    expect(result).toContain("I don't want this");
  });

  test('exports comment annotations', () => {
    const blocks = [createBlock('b1', 'Some text')];
    const annotations = [
      createAnnotation('a1', 'b1', AnnotationType.COMMENT, 'Some', 'This needs clarification'),
    ];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('Feedback on');
    expect(result).toContain('Some');
    expect(result).toContain('This needs clarification');
  });

  test('exports replacement annotations', () => {
    const blocks = [createBlock('b1', 'Old text')];
    const annotations = [
      createAnnotation('a1', 'b1', AnnotationType.REPLACEMENT, 'Old', 'New'),
    ];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('Change this');
    expect(result).toContain('From:');
    expect(result).toContain('Old');
    expect(result).toContain('To:');
    expect(result).toContain('New');
  });

  test('exports insertion annotations', () => {
    const blocks = [createBlock('b1', 'Text')];
    const annotations = [
      createAnnotation('a1', 'b1', AnnotationType.INSERTION, '', 'New content'),
    ];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('Add this');
    expect(result).toContain('New content');
  });

  test('exports global comment annotations', () => {
    const blocks = [createBlock('b1', 'Text')];
    const annotations = [
      createAnnotation('a1', '', AnnotationType.GLOBAL_COMMENT, '', 'Overall feedback'),
    ];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('General feedback');
    expect(result).toContain('Overall feedback');
  });

  test('includes global attachments', () => {
    const blocks = [createBlock('b1', 'Text')];
    const globalAttachments = ['/path/to/image1.png', '/path/to/image2.jpg'];

    const result = exportDiff(blocks, [], globalAttachments);

    expect(result).toContain('Reference Images');
    expect(result).toContain('/path/to/image1.png');
    expect(result).toContain('/path/to/image2.jpg');
  });

  test('includes annotation image paths', () => {
    const blocks = [createBlock('b1', 'Text')];
    const annotations: Annotation[] = [{
      id: 'a1',
      blockId: 'b1',
      startOffset: 0,
      endOffset: 4,
      type: AnnotationType.COMMENT,
      originalText: 'Text',
      text: 'See attached',
      createdAt: Date.now(),
      imagePaths: ['/path/to/screenshot.png'],
    }];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('Attached images');
    expect(result).toContain('/path/to/screenshot.png');
  });

  test('sorts annotations by block order and offset', () => {
    const blocks = [
      { ...createBlock('b1', 'First'), order: 1 },
      { ...createBlock('b2', 'Second'), order: 2 },
    ];
    const annotations = [
      { ...createAnnotation('a2', 'b2', AnnotationType.COMMENT, 'Second', 'Comment B'), startOffset: 0 },
      { ...createAnnotation('a1', 'b1', AnnotationType.COMMENT, 'First', 'Comment A'), startOffset: 0 },
    ];

    const result = exportDiff(blocks, annotations);

    const indexA = result.indexOf('Comment A');
    const indexB = result.indexOf('Comment B');
    expect(indexA).toBeLessThan(indexB);
  });

  test('counts annotations correctly', () => {
    const blocks = [createBlock('b1', 'Text')];
    const annotations = [
      createAnnotation('a1', 'b1', AnnotationType.COMMENT, 'T', 'One'),
      createAnnotation('a2', 'b1', AnnotationType.COMMENT, 'e', 'Two'),
      createAnnotation('a3', 'b1', AnnotationType.COMMENT, 'x', 'Three'),
    ];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('3 pieces of feedback');
  });

  test('uses singular for single annotation', () => {
    const blocks = [createBlock('b1', 'Text')];
    const annotations = [
      createAnnotation('a1', 'b1', AnnotationType.COMMENT, 'Text', 'Single'),
    ];

    const result = exportDiff(blocks, annotations);

    expect(result).toContain('1 piece of feedback');
  });
});
