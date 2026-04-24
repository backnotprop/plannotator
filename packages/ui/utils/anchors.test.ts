import { describe, expect, test } from 'bun:test';
import { decodeAnchorHash } from './anchors';

describe('decodeAnchorHash', () => {
  test('strips leading # and trims', () => {
    expect(decodeAnchorHash('#section-overview')).toBe('section-overview');
  });

  test('drops query-string suffixes (e.g. share callback params)', () => {
    expect(decodeAnchorHash('#section-overview?cb=https://example.com&ct=token')).toBe(
      'section-overview',
    );
  });

  test('percent-decodes unicode', () => {
    expect(decodeAnchorHash('#caf%C3%A9')).toBe('café');
  });

  test('keeps malformed percent-encoded hashes non-fatal', () => {
    expect(decodeAnchorHash('#bad%E0%A4%A')).toBe('bad%E0%A4%A');
  });

  test('returns null for empty or hash-only fragments', () => {
    expect(decodeAnchorHash('')).toBeNull();
    expect(decodeAnchorHash('#')).toBeNull();
    expect(decodeAnchorHash('#   ')).toBeNull();
  });
});
