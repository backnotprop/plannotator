import { describe, test, expect } from 'bun:test';
import { hasUnsavedContent } from './commentContent';
import type { ImageAttachment } from '../types';

const img: ImageAttachment = { path: '/tmp/x.png', name: 'x' };

describe('hasUnsavedContent', () => {
  test('empty buffer has nothing to protect', () => {
    expect(hasUnsavedContent('', [])).toBe(false);
  });

  test('whitespace-only text has nothing to protect', () => {
    expect(hasUnsavedContent('   \n\t ', [])).toBe(false);
  });

  test('typed text is protected', () => {
    expect(hasUnsavedContent('hi', [])).toBe(true);
  });

  test('an attached image is protected even with no text', () => {
    expect(hasUnsavedContent('', [img])).toBe(true);
  });

  test('an attached image is protected even with whitespace-only text', () => {
    expect(hasUnsavedContent('   ', [img])).toBe(true);
  });
});
