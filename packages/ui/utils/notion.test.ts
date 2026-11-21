import { afterEach, describe, expect, test } from 'bun:test';
import { getNotionParentPageId, normalizeNotionPageId, setNotionAvailable } from './notion';

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

describe('getNotionParentPageId', () => {
  afterEach(() => setNotionAvailable(false));

  const settings = { enabled: true, parentPageId: '0123456789abcdef0123456789abcdef', autoSave: false };

  test('is null until the server offers Notion, so remote sessions never save there', () => {
    expect(getNotionParentPageId(settings)).toBeNull();
    setNotionAvailable(true);
    expect(getNotionParentPageId(settings)).toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  test('is null when the user turned Notion off', () => {
    setNotionAvailable(true);
    expect(getNotionParentPageId({ ...settings, enabled: false })).toBeNull();
  });
});
