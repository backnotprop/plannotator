import { describe, test, expect } from 'bun:test';
import { trimUrlTail } from './InlineMarkdown';

describe('trimUrlTail', () => {
  test('trims trailing period', () => {
    expect(trimUrlTail('https://foo.com.')).toBe('https://foo.com');
  });

  test('trims trailing comma / semicolon / question mark', () => {
    expect(trimUrlTail('https://foo.com,')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com;')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com?')).toBe('https://foo.com?'.replace(/\?$/, ''));
  });

  test('keeps closing paren when it balances an opener', () => {
    expect(trimUrlTail('https://en.wikipedia.org/wiki/Function_(mathematics)')).toBe(
      'https://en.wikipedia.org/wiki/Function_(mathematics)',
    );
  });

  test('trims unbalanced closing paren', () => {
    expect(trimUrlTail('https://foo.com/path)')).toBe('https://foo.com/path');
  });

  test('keeps closing bracket when balanced', () => {
    expect(trimUrlTail('https://foo.com/[a]')).toBe('https://foo.com/[a]');
  });

  test('trims unbalanced closing bracket', () => {
    expect(trimUrlTail('https://foo.com]')).toBe('https://foo.com');
  });

  test('trims stacked punctuation', () => {
    expect(trimUrlTail('https://foo.com).')).toBe('https://foo.com');
  });

  test('leaves URL alone when no trailing punctuation', () => {
    expect(trimUrlTail('https://foo.com/path')).toBe('https://foo.com/path');
  });
});
