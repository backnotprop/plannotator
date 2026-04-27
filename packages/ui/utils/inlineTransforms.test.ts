import { describe, test, expect } from 'bun:test';
import { transformPlainText } from './inlineTransforms';

describe('transformPlainText — emoji shortcodes', () => {
  test('replaces known shortcode with unicode emoji', () => {
    expect(transformPlainText('hello :wave:')).toBe('hello 👋');
  });

  test('leaves unknown shortcode untouched', () => {
    expect(transformPlainText('hello :notaknownemoji:')).toBe('hello :notaknownemoji:');
  });

  test('replaces multiple shortcodes in one string', () => {
    expect(transformPlainText(':rocket: to the :star:')).toBe('🚀 to the ⭐');
  });
});

describe('transformPlainText — smart punctuation', () => {
  test('converts triple dots to ellipsis', () => {
    expect(transformPlainText('wait...')).toBe('wait…');
  });

  test('converts triple hyphen to em dash', () => {
    expect(transformPlainText('before --- after')).toBe('before — after');
  });

  test('converts double hyphen to en dash between digits', () => {
    expect(transformPlainText('pages 3--5')).toBe('pages 3–5');
  });

  test('leaves CLI flags alone', () => {
    expect(transformPlainText('bun --watch')).toBe('bun --watch');
    expect(transformPlainText('claude-code --model opus-4')).toBe('claude-code --model opus-4');
    expect(transformPlainText('see --help')).toBe('see --help');
  });

  test('curls straight double quotes', () => {
    expect(transformPlainText('she said "hello"')).toBe('she said “hello”');
  });

  test('curls apostrophe inside a word', () => {
    expect(transformPlainText("don't stop")).toBe('don’t stop');
  });

  test('curls single quotes around a phrase', () => {
    expect(transformPlainText("he said 'hi'")).toBe('he said ‘hi’');
  });
});
