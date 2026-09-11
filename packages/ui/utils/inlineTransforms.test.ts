import { describe, test, expect } from 'bun:test';
import { stripInlineMarkdown, stripTableCellDelimiters, transformPlainText } from './inlineTransforms';

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
  test('unwraps code spans, which is what an external quote carries', () => {
    expect(stripInlineMarkdown('`config.ts` — `ENABLED_TOOLS` branch')).toBe(
      'config.ts — ENABLED_TOOLS branch',
    );
    expect(stripInlineMarkdown('``a `b` c``')).toBe('a `b` c');
  });

  test('unwraps emphasis and strikethrough', () => {
    expect(stripInlineMarkdown('**R2.** the ~~old~~ __new__ path')).toBe('R2. the old new path');
    expect(stripInlineMarkdown('***both***')).toBe('both');
  });

  test('keeps link and image text, drops the target', () => {
    expect(stripInlineMarkdown('see [the plan](./plan.md)')).toBe('see the plan');
    expect(stripInlineMarkdown('![a diagram](x.png)')).toBe('a diagram');
    expect(stripInlineMarkdown('[[Design]] and [[Design|alias]]')).toBe('Design and Design');
  });

  test('does not unwrap emphasis that lives inside a code span', () => {
    // Backticks are consumed first, so the underscores in a code span are
    // literal content and must survive as themselves.
    expect(stripInlineMarkdown('`a__b__c`')).toBe('a__b__c');
  });

  test('leaves prose without inline syntax untouched', () => {
    expect(stripInlineMarkdown('plain sentence, nothing to strip')).toBe(
      'plain sentence, nothing to strip',
    );
  });

  test('leaves table cell delimiters alone', () => {
    // Separate tier: deleting the padding around a pipe mangles prose, so it
    // is not part of the general strip.
    expect(stripInlineMarkdown('| a | b |')).toBe('| a | b |');
  });
});

describe('stripTableCellDelimiters', () => {
  test('renders a row the way adjacent cells concatenate', () => {
    // `| a | b |` renders as <td>a</td><td>b</td> — no text between the cells,
    // so the padding has to go with the pipe, not just the pipe.
    expect(stripTableCellDelimiters('| a | b |')).toBe('ab');
    expect(stripTableCellDelimiters('| `x.ts` | **WP5** |')).toBe('x.tsWP5');
  });

  test('includes the inline strip', () => {
    expect(stripTableCellDelimiters('`a`')).toBe('a');
  });
});
