import { describe, expect, test } from 'bun:test';
import {
  decodeAnchorHash,
  getHeadingAnchorAliases,
  legacySlugifyHeadingAnchor,
  normalizeAnchorText,
  slugifyHeadingAnchor,
} from './anchors';

describe('anchor helpers', () => {
  test('normalizes inline markdown before slugging', () => {
    expect(normalizeAnchorText('Part I: **Who** `Adderalin` Is')).toBe('Part I: Who Adderalin Is');
    expect(normalizeAnchorText('[Docs](./docs.md) and [[notes|Notes Page]]')).toBe('Docs and Notes Page');
  });

  test('decodes anchor hashes and strips callback suffixes', () => {
    expect(decodeAnchorHash('#part-i--who-adderalin-is')).toBe('part-i--who-adderalin-is');
    expect(decodeAnchorHash('#part-i--who-adderalin-is?cb=https://example.com&ct=token')).toBe(
      'part-i--who-adderalin-is',
    );
  });

  test('keeps malformed percent-encoded hashes non-fatal', () => {
    expect(decodeAnchorHash('#bad%E0%A4%A')).toBe('bad%E0%A4%A');
  });

  test('creates a canonical collapsed slug', () => {
    expect(slugifyHeadingAnchor('Part I: Who Adderalin Is: Biographical Context')).toBe(
      'part-i-who-adderalin-is-biographical-context',
    );
  });

  test('creates a legacy slug variant that preserves repeated separators', () => {
    expect(legacySlugifyHeadingAnchor('Part I: Who Adderalin Is: Biographical Context')).toBe(
      'part-i--who-adderalin-is--biographical-context',
    );
  });

  test('returns both canonical and legacy aliases without duplicates', () => {
    expect(getHeadingAnchorAliases('Simple Heading')).toEqual(['simple-heading']);
    expect(getHeadingAnchorAliases('Part I: Who Adderalin Is: Biographical Context')).toEqual([
      'part-i-who-adderalin-is-biographical-context',
      'part-i--who-adderalin-is--biographical-context',
    ]);
  });
});
