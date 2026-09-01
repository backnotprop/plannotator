import { describe, test, expect } from 'bun:test';
import { stripInlineMarkdown, transformPlainText } from './inlineTransforms';
import { slugifyHeading } from './slugify';

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

describe('stripInlineMarkdown', () => {
  // Each row is a source fragment an agent can faithfully copy out of
  // /api/plan whose rendered form carries none of that syntax. These are the
  // quotes that were accepted, listed, and silently never highlighted.
  test.each([
    ['**Install** now', 'Install now'],
    ['Setup `bun`', 'Setup bun'],
    ['[Setup](./setup.md)', 'Setup'],
    ['see [[architecture]]', 'see architecture'],
    ['_em_ and ~~struck~~', 'em and struck'],
  ])('%p renders as %p', (source, rendered) => {
    expect(stripInlineMarkdown(source)).toBe(rendered);
  });

  test('leaves text without inline markup untouched', () => {
    expect(stripInlineMarkdown('plain sentence, 3.1 included')).toBe('plain sentence, 3.1 included');
  });
});

describe('slugifyHeading after sharing the stripper', () => {
  // Extracting the stripper must not move any anchor: a changed slug silently
  // breaks every `#anchor` already written against these documents.
  test.each([
    ['**Install** `bun`', 'install-bun'],
    ['[Setup](./s.md)', 'setup'],
    ['[[architecture]] notes', 'architecture-notes'],
    ['snake_case config', 'snakecase-config'],
  ])('%p slugs to %p', (heading, slug) => {
    expect(slugifyHeading(heading)).toBe(slug);
  });
});
