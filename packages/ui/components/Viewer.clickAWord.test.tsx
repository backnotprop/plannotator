import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation, type EditorMode, type InputMethod } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import { CLICK_WORD_WAIT_MS } from '../hooks/useClickWord';

const hasDom = typeof document !== 'undefined';
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];
const policy = hasDom ? await import('../utils/clickAWordPolicy') : null;

const MARKDOWN = ['# Notes', '', 'The retry loop is slow.', '', 'Cache keys collide often.'].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;
let caret: { node: Node; offset: number } | null = null;
type CaretDoc = { caretRangeFromPoint?: unknown; caretPositionFromPoint?: unknown };
let saved: { range: unknown; position: unknown; rects: unknown } | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  policy?.resetClickAWord();
  if (hasDom && saved) {
    (document as unknown as CaretDoc).caretRangeFromPoint = saved.range;
    (document as unknown as CaretDoc).caretPositionFromPoint = saved.position;
    (Range.prototype as unknown as { getClientRects: unknown }).getClientRects = saved.rects;
    saved = null;
  }
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  }
});

interface Options {
  mode?: EditorMode;
  inputMethod?: InputMethod;
  readOnly?: boolean;
  answerOnly?: boolean;
  clickAWord?: boolean;
  annotations?: Annotation[];
}

async function mount(options: Options = {}) {
  const doc = document as unknown as CaretDoc;
  saved = { range: doc.caretRangeFromPoint, position: doc.caretPositionFromPoint, rects: Range.prototype.getClientRects };
  doc.caretRangeFromPoint = undefined;
  doc.caretPositionFromPoint = () => (caret ? { offsetNode: caret.node, offset: caret.offset } : null);
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [{ left: 0, right: 0, top: 0, bottom: 0 }];

  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  const selected: (string | null)[] = [];
  const ref = React.createRef<{ applySharedAnnotations: (annotations: Annotation[]) => void }>();
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        ref={ref as never}
        blocks={parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={options.annotations ?? []}
        onAddAnnotation={(ann) => added.push(ann)}
        onSelectAnnotation={(id) => selected.push(id)}
        selectedAnnotationId={null}
        mode={options.mode ?? 'selection'}
        inputMethod={options.inputMethod}
        readOnly={options.readOnly}
        answerOnly={options.answerOnly}
        clickAWord={options.clickAWord}
        taterMode={false}
        disableCodePathValidation
      />,
    );
  });
  if (options.annotations) await act(async () => { ref.current!.applySharedAnnotations(options.annotations!); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const article = host.querySelector('article') as HTMLElement;
  const paragraph = (needle: string) =>
    Array.from(article.querySelectorAll<HTMLElement>('[data-block-id]')).find((el) => el.textContent?.includes(needle))!;
  const at = (word: string) => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = (node.textContent ?? '').indexOf(word);
      if (index >= 0) return { node, offset: index + 1 };
    }
    throw new Error(`no "${word}" in the document`);
  };
  const marks = () => Array.from(article.querySelectorAll('mark')).map((m) => m.textContent ?? '').join('|');
  const toolbar = () => document.querySelector('.annotation-toolbar');
  return { article, paragraph, at, marks, toolbar, added, selected };
}

const pointer = (type: string, init: Record<string, unknown> = {}): Event => {
  const base = { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, pointerType: 'mouse', ...init };
  return typeof PointerEvent === 'function' ? new PointerEvent(type, base) : new MouseEvent(type, base);
};
const mouse = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, detail: 1, ...init });

const click = async (target: Element, position: { node: Node; offset: number }, detail = 1) => {
  caret = position;
  await act(async () => {
    target.dispatchEvent(pointer('pointerdown'));
    target.dispatchEvent(mouse('mousedown', { detail }));
    target.dispatchEvent(pointer('pointerup'));
    target.dispatchEvent(mouse('mouseup', { detail }));
    target.dispatchEvent(mouse('click', { detail }));
  });
};
const copyAt = (target: EventTarget) => {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' } });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, plain: data.get('text/plain') };
};
const wait = (ms = CLICK_WORD_WAIT_MS + 80) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe.if(hasDom)('Viewer: click a word (Select)', () => {
  test('one click on a word highlights that word and opens the toolbar', async () => {
    const { paragraph, at, marks, toolbar, added } = await mount();

    await click(paragraph('retry'), at('retry'));
    expect(marks()).toBe('');
    await wait();

    expect(marks()).toBe('retry');
    expect(toolbar()).not.toBeNull();
    expect(added).toEqual([]);
  });

  test('comment mode opens the composer on the word', async () => {
    const { paragraph, at, marks } = await mount({ mode: 'comment' });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('retry');
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  test('quick label mode opens the label picker on the word', async () => {
    const { paragraph, at, marks } = await mount({ mode: 'quickLabel' });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('retry');
    expect(document.querySelector('[data-quick-label-picker]')).not.toBeNull();
  });

  test('redline mode: a click deletes nothing', async () => {
    const { paragraph, at, marks, added } = await mount({ mode: 'redline' });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(added).toEqual([]);
    expect(marks()).toBe('');
  });

  test('Pinpoint keeps its own click: the block, not the word', async () => {
    const { paragraph, at, marks } = await mount({ inputMethod: 'pinpoint' });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('The retry loop is slow.');
  });

  test('a click that only closes the toolbar makes nothing new', async () => {
    const { paragraph, at, marks, toolbar } = await mount();
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(toolbar()).not.toBeNull();

    await click(paragraph('Cache'), at('collide'));
    await wait();

    expect(toolbar()).toBeNull();
    expect(marks()).toBe('');
  });

  test('a click on an existing highlight opens it and adds nothing', async () => {
    const existing: Annotation = {
      id: 'annCache', blockId: '', startOffset: 0, endOffset: 10, type: AnnotationType.COMMENT,
      text: 'which keys?', originalText: 'Cache keys', createdA: 1,
    };
    const { article, marks, selected } = await mount({ annotations: [existing] });
    const mark = article.querySelector('mark') as HTMLElement;
    expect(mark?.textContent).toBe('Cache keys');

    await click(mark, { node: mark.firstChild!, offset: 2 });
    await wait();

    expect(selected).toContain('annCache');
    expect(marks()).toBe('Cache keys');
  });

  test('a triple click still takes the paragraph', async () => {
    const { paragraph, at, marks, toolbar } = await mount();
    const p = paragraph('retry');
    const position = at('retry');

    await click(p, position, 1);
    const selections = [
      () => window.getSelection()!.setBaseAndExtent(position.node, 4, position.node, 9),
      () => window.getSelection()!.setBaseAndExtent(document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode()!, 0, paragraph('Cache'), 0),
    ];
    for (const [index, select] of selections.entries()) {
      const detail = index + 2;
      await act(async () => {
        p.dispatchEvent(pointer('pointerdown'));
        p.dispatchEvent(mouse('mousedown', { detail }));
        select();
        p.dispatchEvent(pointer('pointerup'));
        p.dispatchEvent(mouse('mouseup', { detail }));
        p.dispatchEvent(mouse('click', { detail }));
      });
      if (index === 0) expect(marks()).toBe('retry');
    }
    await wait();

    expect(marks().replace(/\|/g, '')).toBe('The retry loop is slow.');
    expect(toolbar()).not.toBeNull();
  });

  test('a drag selects exactly what the browser selected: no word snapping', async () => {
    const { paragraph, at, marks } = await mount();
    const p = paragraph('retry');
    const text = at('retry').node;

    caret = at('retry');
    await act(async () => {
      p.dispatchEvent(pointer('pointerdown'));
      p.dispatchEvent(mouse('mousedown'));
      p.dispatchEvent(pointer('pointermove', { clientX: 80 }));
      window.getSelection()!.setBaseAndExtent(text, 6, text, 12);
      document.dispatchEvent(new Event('selectionchange'));
      p.dispatchEvent(pointer('pointerup', { clientX: 80 }));
      p.dispatchEvent(mouse('mouseup', { clientX: 80 }));
      p.dispatchEvent(mouse('click', { clientX: 80 }));
    });
    await wait();

    expect(marks()).toBe('try lo');
  });

  test('Ctrl+C copies the clicked word, with its toolbar up and with its composer open', async () => {
    const { paragraph, at, toolbar } = await mount();
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(toolbar()).not.toBeNull();
    expect(copyAt(document.body)).toEqual({ prevented: true, plain: 'retry' });

    const comment = document.querySelector<HTMLButtonElement>('.annotation-toolbar button.text-annotation-comment')!;
    await act(async () => comment.click());
    await wait(30);
    const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
    area.focus();
    expect(copyAt(area)).toEqual({ prevented: true, plain: 'retry' });
  });
});

describe.if(hasDom)('Viewer: where a click on a word makes nothing', () => {
  test('read-only', async () => {
    const { paragraph, at, marks } = await mount({ readOnly: true });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('');
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test('answer-only', async () => {
    const { paragraph, at, marks } = await mount({ answerOnly: true });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('');
  });

  test('a Viewer with clickAWord={false}', async () => {
    const { paragraph, at, marks, toolbar } = await mount({ clickAWord: false });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('');
    expect(toolbar()).toBeNull();
  });

  test('a host that turned it off for every Viewer', async () => {
    policy!.setClickAWord(false);
    const { paragraph, at, marks } = await mount();
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('');
  });

  test('the Viewer\'s own prop wins over the host-wide switch', async () => {
    policy!.setClickAWord(false);
    const { paragraph, at, marks } = await mount({ clickAWord: true });
    await click(paragraph('retry'), at('retry'));
    await wait();
    expect(marks()).toBe('retry');
  });
});
