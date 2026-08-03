/**
 * Content-verifying restore (0.24.0, opt-in).
 *
 * A meta-based restore (`fromStore`) trusts DOM positions; after document
 * drift those positions can resolve onto the WRONG text and the highlight
 * paints silently wrong. With `verifyRestoredContent`:
 *   - a mismatching restore is removed and the text-search fallback re-anchors
 *     the annotation by its `originalText`
 *   - if the original text no longer exists either, `onRestoreMismatch` fires
 *     and nothing is painted
 * Default (off) preserves today's trust-the-positions behavior.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

// web-highlighter reads `window` at module-eval time; import lazily (same
// pattern as useAnnotationHighlighter.test.tsx).
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];
type HookReturn = import('./useAnnotationHighlighter').UseAnnotationHighlighterReturn;

/** Metas that resolve onto the FIRST paragraph ("hello w…"), regardless of
 *  what the annotation's originalText claims — simulating document drift. */
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
      <p data-block-id="b1">hello world</p>
      <p data-block-id="b2">goodbye world</p>
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
    // Today's behavior, preserved: positions win, wrong text gets painted.
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
    // Fallback succeeded, so no mismatch is reported.
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
    // Nothing painted for this annotation.
    expect(paintedText(hook.current!, ann.id)).toBe('');
  });
});
