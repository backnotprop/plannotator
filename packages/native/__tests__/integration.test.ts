/**
 * Integration tests for @plannotator/native
 * Tests the complete flow from markdown parsing to annotation export
 */

import { describe, test, expect } from 'bun:test';
import {
  parseMarkdownToBlocks,
  exportDiff,
  AnnotationType,
  type Block,
  type Annotation,
} from '@plannotator/core';
import { createAnnotation } from '../hooks/useAnnotations';
import { lightTheme, darkTheme } from '../types';

describe('Full integration flow', () => {
  const samplePlan = `# Implementation Plan

## Summary
This plan adds a new authentication feature.

## Steps

1. Create user model
2. Add login endpoint
3. Implement JWT tokens

## Code Example

\`\`\`typescript
interface User {
  id: string;
  email: string;
}
\`\`\`

> Note: This requires database migrations.

---

Final step: Deploy to production.
`;

  test('parses markdown and creates annotations correctly', () => {
    // Step 1: Parse markdown
    const blocks = parseMarkdownToBlocks(samplePlan);

    // Verify blocks were created
    expect(blocks.length).toBeGreaterThan(5);

    // Find specific blocks
    const headingBlock = blocks.find(b => b.type === 'heading' && b.level === 1);
    const listBlock = blocks.find(b => b.type === 'list-item');
    const codeBlock = blocks.find(b => b.type === 'code');
    const blockquoteBlock = blocks.find(b => b.type === 'blockquote');
    const hrBlock = blocks.find(b => b.type === 'hr');

    expect(headingBlock).toBeDefined();
    expect(headingBlock!.content).toBe('Implementation Plan');

    expect(listBlock).toBeDefined();
    expect(listBlock!.content).toContain('Create user model');

    expect(codeBlock).toBeDefined();
    expect(codeBlock!.language).toBe('typescript');

    expect(blockquoteBlock).toBeDefined();
    expect(blockquoteBlock!.content).toContain('database migrations');

    expect(hrBlock).toBeDefined();
  });

  test('creates annotations for parsed blocks', () => {
    const blocks = parseMarkdownToBlocks(samplePlan);
    const summaryBlock = blocks.find(b => b.content.includes('authentication feature'));

    expect(summaryBlock).toBeDefined();

    // Create a comment annotation
    const commentAnnotation = createAnnotation({
      blockId: summaryBlock!.id,
      type: AnnotationType.COMMENT,
      originalText: 'authentication feature',
      startOffset: summaryBlock!.content.indexOf('authentication'),
      endOffset: summaryBlock!.content.indexOf('authentication') + 'authentication feature'.length,
      text: 'Should we also support OAuth?',
      author: 'Reviewer',
    });

    expect(commentAnnotation.type).toBe(AnnotationType.COMMENT);
    expect(commentAnnotation.text).toBe('Should we also support OAuth?');
    expect(commentAnnotation.author).toBe('Reviewer');
    expect(commentAnnotation.blockId).toBe(summaryBlock!.id);
  });

  test('creates deletion annotation', () => {
    const blocks = parseMarkdownToBlocks(samplePlan);
    const listBlock = blocks.find(b => b.content.includes('Deploy to production'));

    expect(listBlock).toBeDefined();

    const deletionAnnotation = createAnnotation({
      blockId: listBlock!.id,
      type: AnnotationType.DELETION,
      originalText: 'Deploy to production',
      startOffset: 0,
      endOffset: 'Deploy to production'.length,
    });

    expect(deletionAnnotation.type).toBe(AnnotationType.DELETION);
    expect(deletionAnnotation.originalText).toBe('Deploy to production');
  });

  test('creates replacement annotation', () => {
    const blocks = parseMarkdownToBlocks(samplePlan);
    const listBlock = blocks.find(b => b.content.includes('JWT tokens'));

    expect(listBlock).toBeDefined();

    const replacementAnnotation = createAnnotation({
      blockId: listBlock!.id,
      type: AnnotationType.REPLACEMENT,
      originalText: 'JWT tokens',
      startOffset: listBlock!.content.indexOf('JWT'),
      endOffset: listBlock!.content.indexOf('JWT') + 'JWT tokens'.length,
      text: 'OAuth2 tokens',
    });

    expect(replacementAnnotation.type).toBe(AnnotationType.REPLACEMENT);
    expect(replacementAnnotation.text).toBe('OAuth2 tokens');
  });

  test('exports diff with all annotation types', () => {
    const blocks = parseMarkdownToBlocks(samplePlan);

    // Create various annotations
    const annotations: Annotation[] = [];

    // Find blocks for annotations
    const summaryBlock = blocks.find(b => b.content.includes('authentication feature'));
    const deployBlock = blocks.find(b => b.content.includes('Deploy to production'));
    const jwtBlock = blocks.find(b => b.content.includes('JWT tokens'));

    if (summaryBlock) {
      annotations.push(createAnnotation({
        blockId: summaryBlock.id,
        type: AnnotationType.COMMENT,
        originalText: 'authentication feature',
        startOffset: 0,
        endOffset: 21,
        text: 'Consider OAuth support',
      }));
    }

    if (deployBlock) {
      annotations.push(createAnnotation({
        blockId: deployBlock.id,
        type: AnnotationType.DELETION,
        originalText: 'Deploy to production',
        startOffset: 0,
        endOffset: 20,
      }));
    }

    if (jwtBlock) {
      annotations.push(createAnnotation({
        blockId: jwtBlock.id,
        type: AnnotationType.REPLACEMENT,
        originalText: 'JWT',
        startOffset: 0,
        endOffset: 3,
        text: 'OAuth2',
      }));
    }

    // Export diff
    const diff = exportDiff(blocks, annotations);

    // Verify diff contains all annotations (exportDiff outputs human-readable format)
    expect(diff).toContain('Feedback on');
    expect(diff).toContain('Consider OAuth support');

    expect(diff).toContain('Remove this');
    expect(diff).toContain('Deploy to production');

    expect(diff).toContain('Change this');
    expect(diff).toContain('JWT');
    expect(diff).toContain('OAuth2');
  });

  test('global comment annotation works', () => {
    const blocks = parseMarkdownToBlocks(samplePlan);

    const globalComment = createAnnotation({
      blockId: 'global',
      type: AnnotationType.GLOBAL_COMMENT,
      originalText: '',
      startOffset: 0,
      endOffset: 0,
      text: 'Overall the plan looks good but needs more detail on error handling.',
    });

    expect(globalComment.type).toBe(AnnotationType.GLOBAL_COMMENT);
    expect(globalComment.text).toContain('error handling');

    // Export should include global comment (in human-readable format)
    const diff = exportDiff(blocks, [globalComment]);
    expect(diff).toContain('General feedback');
    expect(diff).toContain('error handling');
  });
});

describe('Theme exports', () => {
  test('themes have all required colors', () => {
    const requiredColors = [
      'background',
      'surface',
      'text',
      'textMuted',
      'primary',
      'border',
      'deletion',
      'comment',
      'insertion',
      'replacement',
      'success',
    ];

    for (const color of requiredColors) {
      expect(lightTheme).toHaveProperty(color);
      expect(darkTheme).toHaveProperty(color);
    }
  });

  test('light theme has appropriate colors', () => {
    expect(lightTheme.background).toBe('#ffffff');
    expect(lightTheme.text).toBe('#1f2937');
  });

  test('dark theme has appropriate colors', () => {
    expect(darkTheme.background).toBe('#1f2937');
    expect(darkTheme.text).toBe('#f9fafb');
  });
});

describe('Package exports', () => {
  test('core package exports work', async () => {
    const core = await import('@plannotator/core');

    // Functions
    expect(typeof core.parseMarkdownToBlocks).toBe('function');
    expect(typeof core.exportDiff).toBe('function');
    expect(typeof core.extractFrontmatter).toBe('function');

    // Enums
    expect(core.AnnotationType.DELETION).toBe('DELETION');
    expect(core.AnnotationType.COMMENT).toBe('COMMENT');
  });

  test('native hooks exports work', async () => {
    // Import hooks directly (not the main index which includes RN components)
    const hooks = await import('../hooks');

    // Hooks
    expect(typeof hooks.useAnnotations).toBe('function');
    expect(typeof hooks.usePlanReview).toBe('function');
    expect(typeof hooks.useTextSelection).toBe('function');
    expect(typeof hooks.createAnnotation).toBe('function');
  });

  test('native types exports work', async () => {
    // Import types directly
    const types = await import('../types');

    // Themes
    expect(types.lightTheme).toBeDefined();
    expect(types.darkTheme).toBeDefined();
    expect(types.lightTheme.background).toBe('#ffffff');
    expect(types.darkTheme.background).toBe('#1f2937');
  });
});
