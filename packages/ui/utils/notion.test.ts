import { describe, expect, test } from 'bun:test';
import { normalizeNotionPageId } from './notion';

describe('normalizeNotionPageId', () => {
  test('normalizes a compact page ID', () => {
    expect(normalizeNotionPageId('0123456789abcdef0123456789abcdef')).toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  test('extracts a page ID from a Notion URL', () => {
    expect(normalizeNotionPageId('https://www.notion.so/My-page-0123456789abcdef0123456789abcdef')).toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  test('rejects values without a Notion page ID', () => {
    expect(normalizeNotionPageId('not a page')).toBeNull();
  });
});
