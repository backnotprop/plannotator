import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];
type HookReturn = import('./useAnnotationHighlighter').UseAnnotationHighlighterReturn;

const driftedAnnotation = (originalText: string): Annotation => ({
  id: `ann-${originalText}`,
  blockId: 'b1',
  startOffset: 0,
  endOffset: originalText.length,
  type: AnnotationType.COMMENT,
  originalText,
  createdA: 1,
  startMeta: { parentTagName: 'P', parentIndex: 0, textOffset: 0 },
  endMeta: { parentTagName: 'P', parentIndex: 0, textOffset: 7 },
});

function Harness({
  resultRef,
  verify,
  onMismatch,
}: {
  resultRef: { current: HookReturn | null };
  verify: boolean;
  onMismatch?: (ann: Annotation, restored: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  resultRef.current = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode: 'comment',
    verifyRestoredContent: verify,
    onRestoreMismatch: onMismatch,
  });
  return (
    <div ref={containerRef}>
      <div className="annotation-exclude" data-annotation-exclude>
        <span data-testid="excluded-comment">Comment</span>
      </div>
      <p data-block-id="b1">hello world</p>
      <p data-block-id="b2">goodbye world</p>
      <p data-block-id="b3">Comment</p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountHarness(
  verify: boolean,
  onMismatch?: (ann: Annotation, restored: string) => void,
): Promise<{ current: HookReturn | null }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookReturn | null } = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness resultRef={resultRef} verify={verify} onMismatch={onMismatch} />);
  });
  return resultRef;
}

function paintedText(hook: HookReturn, id: string): string {
  const doms = hook.highlighterRef.current?.getDoms(id) ?? [];
  return doms.map((d) => d.textContent ?? '').join('');
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('content-verifying restore', () => {
  test.skipIf(!hasDom)('default trusts positions and paints the drifted (wrong) text', async () => {
    const hook = await mountHarness(false);
    const ann = driftedAnnotation('goodbye');
    await act(async () => {
      hook.current!.applyAnnotations([ann]);
    });
    expect(paintedText(hook.current!, ann.id)).toBe('hello w');
  });

  test.skipIf(!hasDom)('verify: mismatching restore is replaced by the text-search fallback', async () => {
    const mismatches: string[] = [];
    const hook = await mountHarness(true, (_a, restored) => mismatches.push(restored));
    const ann = driftedAnnotation('goodbye');
    await act(async () => {
      hook.current!.applyAnnotations([ann]);
    });
    const painted = document.querySelectorAll(`[data-bind-id="${ann.id}"], [data-highlight-id="${ann.id}"]`);
    const allPainted = Array.from(painted).map((el) => el.textContent ?? '').join('')
      || paintedText(hook.current!, ann.id);
    expect(allPainted).toBe('goodbye');
    expect(mismatches).toHaveLength(0);
  });

  test.skipIf(!hasDom)('verify: reports mismatch when the original text no longer exists', async () => {
    const reported: Array<{ id: string; restored: string }> = [];
    const hook = await mountHarness(true, (a, restored) => reported.push({ id: a.id, restored }));
    const ann = driftedAnnotation('vanished');
    await act(async () => {
      hook.current!.applyAnnotations([ann]);
    });
    expect(reported).toEqual([{ id: ann.id, restored: 'hello w' }]);
    expect(paintedText(hook.current!, ann.id)).toBe('');
  });

  test.skipIf(!hasDom)('text fallback ignores explicitly excluded controls', async () => {
    const hook = await mountHarness(true);
    const ann: Annotation = {
      id: 'ann-comment',
      blockId: 'b3',
      startOffset: 0,
      endOffset: 7,
      type: AnnotationType.COMMENT,
      originalText: 'Comment',
      createdA: 1,
    };
    await act(async () => {
      hook.current!.applyAnnotations([ann]);
    });

    expect(document.querySelector('[data-annotation-exclude] mark')).toBeNull();
    expect(document.querySelector('[data-block-id="b3"] mark')?.textContent).toBe('Comment');
  });

  test.skipIf(!hasDom)('web-highlighter rejects direct selection inside excluded controls', async () => {
    const hook = await mountHarness(true);
    const text = document.querySelector('[data-testid="excluded-comment"]')?.firstChild;
    if (!text) throw new Error('Expected excluded control text');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent?.length ?? 0);

    await act(async () => {
      hook.current!.highlightRange(range);
    });

    expect(document.querySelector('[data-annotation-exclude] mark')).toBeNull();
    expect(hook.current?.toolbarState).toBeNull();
  });
});
