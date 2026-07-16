import { describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

// The hook pulls in @plannotator/web-highlighter, whose UMD bundle reads
// `window` at module-eval time and throws under the default DOM-less
// `bun test`. Import it lazily so this file loads cleanly when the DOM tests
// are skipped (CI); DOM_TESTS=1 supplies a real DOM and the real module.
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

function Harness({
  mode,
  onAdd,
}: {
  mode: 'redline' | 'selection' | 'comment';
  onAdd: (ann: Annotation) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode,
    onAddAnnotation: onAdd,
  });

  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">
        <span data-testid="text-before">Formula </span>
        <span
          className="math-inline math-annotatable"
          data-math-tex="E = mc^2"
          data-math-display="false"
        >
          E = mc^2
        </span>
        <span data-testid="text-after"> is important</span>
      </p>
      {hook.commentPopover && (
        <button
          data-testid="submit-comment"
          onClick={() => hook.handleCommentSubmit('please check')}
        >
          submit
        </button>
      )}
      <button
        data-testid="trigger-range"
        onClick={() => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return;
          hook.highlighterRef.current?.fromRange(selection.getRangeAt(0));
        }}
      >
        trigger
      </button>
    </div>
  );
}

function SelectionProbeHarness({
  onSelect,
}: {
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode: 'comment',
    onSelectAnnotation: onSelect,
  });

  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">
        <span data-testid="text-before">Formula </span>
        <span
          className="math-inline math-annotatable"
          data-math-tex="E = mc^2"
          data-math-display="false"
        >
          E = mc^2
        </span>
        <span data-testid="text-after"> is important</span>
      </p>
    </div>
  );
}

describe('useAnnotationHighlighter math annotations', () => {
  test.skipIf(!hasDom)('redline mode annotates an inline formula as a whole math target', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const annotations: Annotation[] = [];

    await act(async () => {
      root.render(<Harness mode="redline" onAdd={(ann) => annotations.push(ann)} />);
    });

    const math = host.querySelector<HTMLElement>('.math-annotatable');
    expect(math).toBeTruthy();

    await act(async () => {
      math!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      math!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(annotations).toHaveLength(1);
    expect(annotations[0].type).toBe(AnnotationType.DELETION);
    expect(annotations[0].blockId).toBe('block-1');
    expect(annotations[0].originalText).toBe('E = mc^2');
    expect(math!.dataset.mathAnnotation).toBe('true');
    expect(math!.classList.contains('annotation-highlight')).toBe(true);
    expect(math!.classList.contains('math-inline-annotation')).toBe(true);
    expect(math!.classList.contains('deletion')).toBe(true);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test.skipIf(!hasDom)('commenting a mixed text and inline formula selection styles the formula too', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const annotations: Annotation[] = [];

    await act(async () => {
      root.render(<Harness mode="comment" onAdd={(ann) => annotations.push(ann)} />);
    });

    const before = host.querySelector<HTMLElement>('[data-testid="text-before"]');
    const after = host.querySelector<HTMLElement>('[data-testid="text-after"]');
    const math = host.querySelector<HTMLElement>('.math-annotatable');
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(math).toBeTruthy();

    const range = document.createRange();
    range.setStart(before!.firstChild!, 0);
    range.setEnd(after!.firstChild!, ' is'.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger-range"]');
    expect(trigger).toBeTruthy();

    await act(async () => {
      trigger!.click();
    });

    const submit = host.querySelector<HTMLButtonElement>('[data-testid="submit-comment"]');
    expect(submit).toBeTruthy();

    await act(async () => {
      submit!.click();
    });

    expect(annotations).toHaveLength(1);
    expect(annotations[0].type).toBe(AnnotationType.COMMENT);
    expect(annotations[0].mathTargets).toEqual([
      { blockId: 'block-1', tex: 'E = mc^2', displayMode: false },
    ]);
    expect(math!.dataset.bindId).toBe(annotations[0].id);
    expect(math!.dataset.mathAnnotation).toBe('true');
    expect(math!.classList.contains('annotation-highlight')).toBe(true);
    expect(math!.classList.contains('math-inline-annotation')).toBe(true);
    expect(math!.classList.contains('comment')).toBe(true);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test.skipIf(!hasDom)('drag-selecting an inline formula annotates it even when the selection spills into the next text node', async () => {
    // Regression: browsers normalize the focus of an inline drag-select to
    // offset 0 of the following text node. The math handler must still treat
    // this as a pure-formula selection rather than bailing to web-highlighter.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const annotations: Annotation[] = [];

    await act(async () => {
      root.render(<Harness mode="comment" onAdd={(ann) => annotations.push(ann)} />);
    });

    const math = host.querySelector<HTMLElement>('.math-annotatable');
    const after = host.querySelector<HTMLElement>('[data-testid="text-after"]');
    expect(math).toBeTruthy();
    expect(after).toBeTruthy();

    // Anchor inside the formula, focus spilled to the start of the trailing prose.
    const range = document.createRange();
    range.setStart(math!.firstChild!, 0);
    range.setEnd(after!.firstChild!, 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    let defaultPrevented = false;
    await act(async () => {
      math!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      defaultPrevented = !math!.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
      }));
    });

    // Handler claimed the event (did not fall through to web-highlighter)…
    expect(defaultPrevented).toBe(true);

    // …and painted a preview highlight before the comment is even submitted.
    expect(math!.classList.contains('annotation-highlight')).toBe(true);
    expect(math!.classList.contains('comment')).toBe(true);

    // …and offered a comment popover; submitting it styles the whole formula.
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="submit-comment"]');
    expect(submit).toBeTruthy();
    await act(async () => {
      submit!.click();
    });

    expect(annotations).toHaveLength(1);
    expect(annotations[0].type).toBe(AnnotationType.COMMENT);
    expect(annotations[0].originalText).toBe('E = mc^2');
    expect(math!.dataset.mathAnnotation).toBe('true');
    expect(math!.classList.contains('annotation-highlight')).toBe(true);
    expect(math!.classList.contains('comment')).toBe(true);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test.skipIf(!hasDom)('mixed text and formula mouseup is not swallowed by the math-only handler', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const selections: Array<string | null> = [];

    await act(async () => {
      root.render(<SelectionProbeHarness onSelect={(id) => selections.push(id)} />);
    });

    const before = host.querySelector<HTMLElement>('[data-testid="text-before"]');
    const after = host.querySelector<HTMLElement>('[data-testid="text-after"]');
    const math = host.querySelector<HTMLElement>('.math-annotatable');
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(math).toBeTruthy();

    const range = document.createRange();
    range.setStart(before!.firstChild!, 0);
    range.setEnd(after!.firstChild!, ' is'.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    let defaultPrevented = false;
    await act(async () => {
      defaultPrevented = !math!.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(defaultPrevented).toBe(false);
    expect(selections).toEqual([]);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
