/**
 * Tests for @plannotator/native hooks
 * Note: These test the hook logic without React rendering
 */

import { describe, test, expect } from 'bun:test';
import { createAnnotation } from '../hooks/useAnnotations';
import { AnnotationType } from '@plannotator/core';

describe('createAnnotation', () => {
  test('creates annotation with required fields', () => {
    const annotation = createAnnotation({
      blockId: 'block-1',
      type: AnnotationType.COMMENT,
      originalText: 'Hello',
      startOffset: 0,
      endOffset: 5,
      text: 'This needs work',
    });

    expect(annotation.blockId).toBe('block-1');
    expect(annotation.type).toBe(AnnotationType.COMMENT);
    expect(annotation.originalText).toBe('Hello');
    expect(annotation.startOffset).toBe(0);
    expect(annotation.endOffset).toBe(5);
    expect(annotation.text).toBe('This needs work');
    expect(annotation.id).toBeDefined();
    expect(annotation.id).toMatch(/^ann-\d+-[a-z0-9]+$/);
    expect(annotation.createdAt).toBeGreaterThan(0);
  });

  test('generates unique IDs', () => {
    const ann1 = createAnnotation({
      blockId: 'b1',
      type: AnnotationType.DELETION,
      originalText: 'text',
      startOffset: 0,
      endOffset: 4,
    });

    const ann2 = createAnnotation({
      blockId: 'b1',
      type: AnnotationType.DELETION,
      originalText: 'text',
      startOffset: 0,
      endOffset: 4,
    });

    expect(ann1.id).not.toBe(ann2.id);
  });

  test('includes optional author', () => {
    const annotation = createAnnotation({
      blockId: 'block-1',
      type: AnnotationType.COMMENT,
      originalText: 'text',
      startOffset: 0,
      endOffset: 4,
      author: 'Claude',
    });

    expect(annotation.author).toBe('Claude');
  });

  test('includes optional imagePaths', () => {
    const annotation = createAnnotation({
      blockId: 'block-1',
      type: AnnotationType.COMMENT,
      originalText: 'text',
      startOffset: 0,
      endOffset: 4,
      imagePaths: ['/path/to/image.png'],
    });

    expect(annotation.imagePaths).toEqual(['/path/to/image.png']);
  });
});

describe('Theme types', () => {
  test('lightTheme has required properties', async () => {
    const { lightTheme } = await import('../types');

    expect(lightTheme.background).toBeDefined();
    expect(lightTheme.surface).toBeDefined();
    expect(lightTheme.text).toBeDefined();
    expect(lightTheme.primary).toBeDefined();
    expect(lightTheme.deletion).toBeDefined();
    expect(lightTheme.comment).toBeDefined();
  });

  test('darkTheme has required properties', async () => {
    const { darkTheme } = await import('../types');

    expect(darkTheme.background).toBeDefined();
    expect(darkTheme.surface).toBeDefined();
    expect(darkTheme.text).toBeDefined();
    expect(darkTheme.primary).toBeDefined();
    expect(darkTheme.deletion).toBeDefined();
    expect(darkTheme.comment).toBeDefined();
  });
});
