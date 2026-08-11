import { describe, expect, test } from 'bun:test';

import { codeBlockMarkClassName, paintCodeBlockMark } from './codeBlockMark';
import { AnnotationType } from '../types';

const hasDom = typeof document !== 'undefined';

describe('code block mark class', () => {
  test('carries the annotation kind the stylesheet keys on', () => {
    expect(codeBlockMarkClassName(AnnotationType.DELETION)).toBe('annotation-highlight deletion');
    expect(codeBlockMarkClassName(AnnotationType.COMMENT)).toBe('annotation-highlight comment');
    // Global comments never wrap a block, so there is no modifier to add.
    expect(codeBlockMarkClassName(AnnotationType.GLOBAL_COMMENT)).toBe('annotation-highlight');
  });
});

describe.if(hasDom)('paintCodeBlockMark', () => {
  function fence(html: string): HTMLElement {
    const code = document.createElement('code');
    code.innerHTML = html;
    return code;
  }

  test('wraps the whole fence in one mark and keeps the token spans', () => {
    const code = fence('<span style="color:#79c0ff">const</span> x = 1');
    paintCodeBlockMark(code, 'ann-1', AnnotationType.DELETION);

    expect(code.children.length).toBe(1);
    const mark = code.firstElementChild as HTMLElement;
    expect(mark.tagName).toBe('MARK');
    expect(mark.dataset.bindId).toBe('ann-1');
    expect(mark.className).toBe('annotation-highlight deletion');
    // The point of moving children instead of flattening: the palette's
    // colours survive being annotated (and being re-themed).
    expect(mark.querySelector('span[style*="#79c0ff"]')).not.toBeNull();
    expect(code.textContent).toBe('const x = 1');
  });

  test('a second annotation replaces the first mark instead of nesting in it', () => {
    const code = fence('<span style="color:#79c0ff">const</span> x = 1');
    paintCodeBlockMark(code, 'ann-1', AnnotationType.DELETION);
    paintCodeBlockMark(code, 'ann-2', AnnotationType.COMMENT);

    const marks = code.querySelectorAll('mark[data-bind-id]');
    expect(marks.length).toBe(1);
    expect((marks[0] as HTMLElement).dataset.bindId).toBe('ann-2');
    expect(code.querySelector('span[style*="#79c0ff"]')).not.toBeNull();
    expect(code.textContent).toBe('const x = 1');
  });

  test('a plain (language-less) fence is wrapped without inventing markup', () => {
    const code = document.createElement('code');
    code.textContent = 'plain <b>text</b>';
    paintCodeBlockMark(code, 'ann-3', AnnotationType.COMMENT);

    expect(code.textContent).toBe('plain <b>text</b>');
    expect(code.querySelector('b')).toBeNull();
  });
});
