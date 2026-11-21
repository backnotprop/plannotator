import { afterEach, describe, expect, test } from 'bun:test';
import type { Annotation, Block } from '../types';
import { documentOpenInLine } from './openInLine';

const hasDom = typeof document !== 'undefined';

const blocks: Block[] = [
  { id: 'b1', type: 'heading', content: 'Title', level: 1, order: 0, startLine: 4 },
  { id: 'b2', type: 'paragraph', content: 'The retry loop waits.', order: 1, startLine: 6 },
  { id: 'b3', type: 'code', content: 'one()\ntwo()\nthree()', language: 'ts', order: 2, startLine: 9 },
];

function annotation(id: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId: '',
    startOffset: 0,
    endOffset: 0,
    type: 'COMMENT' as Annotation['type'],
    originalText: '',
    createdA: 0,
    ...extra,
  };
}

let container: HTMLElement | null = null;

function render(): HTMLElement {
  container = document.createElement('div');
  container.innerHTML = [
    '<h1 data-block-id="b1">Title</h1>',
    '<p data-block-id="b2">The <mark data-bind-id="a-para">retry</mark> loop waits.</p>',
    '<div data-block-id="b3"><button>copy</button><pre><code>one()\ntwo()\n<mark data-bind-id="a-code">three</mark>()</code></pre></div>',
  ].join('');
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  container?.remove();
  container = null;
  window.getSelection()?.removeAllRanges();
});

describe('documentOpenInLine', () => {
  test.skipIf(!hasDom)("the picked comment's block line, or its line inside a code fence", () => {
    const root = render();
    const anns = [annotation('a-para'), annotation('a-code')];
    expect(documentOpenInLine(root, blocks, anns, 'a-para', null)).toBe(6);
    // Fence opens on line 9; `three()` is the third line of the code.
    expect(documentOpenInLine(root, blocks, anns, 'a-code', null)).toBe(12);
  });

  test.skipIf(!hasDom)("a diagram or image comment's own source line wins", () => {
    const root = render();
    const anns = [annotation('img', { imageRegion: { src: 'a.png', sourceLine: 21 } as Annotation['imageRegion'] })];
    expect(documentOpenInLine(root, blocks, anns, 'img', null)).toBe(21);
  });

  test.skipIf(!hasDom)('no picked comment: the line selected text starts on', () => {
    const root = render();
    const range = document.createRange();
    const heading = root.querySelector('h1')!.firstChild!;
    range.setStart(heading, 1);
    range.setEnd(heading, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(documentOpenInLine(root, blocks, [], null, selection)).toBe(4);
  });

  test.skipIf(!hasDom)('nothing picked or selected: no line', () => {
    const root = render();
    expect(documentOpenInLine(root, blocks, [], null, window.getSelection())).toBeUndefined();
    expect(documentOpenInLine(null, blocks, [], null, null)).toBeUndefined();
  });
});
