/**
 * Quiet gutter labels: `42` for one source line, `42–45` (en-dash) for a span.
 * Inner quote/callout pieces have their ids stripped, so they get no label.
 */
import { describe, expect, test } from 'bun:test';
import type { Block } from '../types';
import {
  formatBlockSourceLineLabel,
  formatFrontmatterSourceLineLabel,
  parseMarkdownToBlocks,
} from './parser';

const block = (partial: Partial<Block> & Pick<Block, 'id' | 'type' | 'content' | 'startLine'>): Block => ({
  order: 0,
  ...partial,
});

describe('formatBlockSourceLineLabel', () => {
  test('a one-line paragraph is the start line, a span uses an en-dash', () => {
    expect(formatBlockSourceLineLabel(block({
      id: 'p1', type: 'paragraph', content: 'Hello.', startLine: 42,
    }))).toBe('42');
    expect(formatBlockSourceLineLabel(block({
      id: 'p2', type: 'paragraph', content: 'Hello.\nThere.', startLine: 42,
    }))).toBe('42–43');
  });

  test('sourceLineCount wins over splitting content, and a code fence includes its fences', () => {
    expect(formatBlockSourceLineLabel(block({
      id: 'p3', type: 'paragraph', content: 'a\nb\nc', startLine: 10, sourceLineCount: 1,
    }))).toBe('10');
    expect(formatBlockSourceLineLabel(block({
      id: 'c1', type: 'code', content: 'const n = 1;\nconst y = 2;', startLine: 8,
    }))).toBe('8–11');
  });

  test('no id (inner quote pieces) or a missing line yields no label', () => {
    expect(formatBlockSourceLineLabel(block({
      id: '', type: 'paragraph', content: 'Hello.', startLine: 1,
    }))).toBeNull();
    expect(formatBlockSourceLineLabel(block({
      id: 'p4', type: 'paragraph', content: 'Hello.', startLine: 0,
    }))).toBeNull();
  });

  test('parsed document blocks match the same helper the gutter uses', () => {
    const md = [
      '# Title',
      '',
      'This paragraph spans',
      'two source lines.',
      '',
      'One line.',
    ].join('\n');
    const blocks = parseMarkdownToBlocks(md);
    const heading = blocks.find((b) => b.type === 'heading')!;
    const multi = blocks.find((b) => b.content.startsWith('This paragraph'))!;
    const single = blocks.find((b) => b.content === 'One line.')!;
    expect(formatBlockSourceLineLabel(heading)).toBe('1');
    expect(formatBlockSourceLineLabel(multi)).toMatch(/^\d+–\d+$/);
    expect(formatBlockSourceLineLabel(single)).toMatch(/^\d+$/);
    expect(formatBlockSourceLineLabel(single)).not.toContain('–');
  });
});

describe('formatFrontmatterSourceLineLabel', () => {
  test('a YAML card spans line 1 through the last line before content', () => {
    expect(formatFrontmatterSourceLineLabel('---\ntitle: Ship\n---\n\n# Title\n')).toBe('1–4');
  });

  test('no frontmatter, or an empty one, yields no label', () => {
    expect(formatFrontmatterSourceLineLabel('# Title\n')).toBeNull();
    expect(formatFrontmatterSourceLineLabel('---\n---\n\n# Title\n')).toBeNull();
  });
});
