/**
 * A comment on a rendered diagram part has no text anchor; the highlighter
 * must leave it alone.
 *
 * What regresses if this fails: the restore pass tries to find the node's
 * label ("Approve?") in the prose, paints a stray highlight on the first
 * prose match, or reports the row as unanchored so the panel shows an
 * "Unanchored" chip on a comment the diagram overlay restored fine.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

// web-highlighter reads `window` at module-eval time (see the sibling test).
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];
type Report = import('./useAnnotationHighlighter').AnnotationRestoreReport;

const DIAGRAM: Annotation = {
  id: 'd1',
  blockId: 'block-2',
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: 'rename',
  originalText: 'Approve?',
  createdA: 1,
  diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] },
};
const TEXT: Annotation = {
  id: 't1',
  blockId: 'block-1',
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: 'hm',
  originalText: 'nowhere in the document',
  createdA: 2,
};

const ANNOTATIONS = [DIAGRAM, TEXT];

function Harness({ onReport, applyRef }: { onReport: (report: Report) => void; applyRef: { current: (() => void) | null } }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: ANNOTATIONS,
    selectedAnnotationId: null,
    mode: 'comment',
    onAddAnnotation: () => {},
    onRestoreReport: onReport,
  });
  // The restore pass is imperative (Viewer runs it once the blocks are on
  // screen); the harness runs it the same way.
  applyRef.current = () => hook.applyAnnotations(ANNOTATIONS);
  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">Should we Approve? the plan</p>
    </div>
  );
}

describe('useAnnotationHighlighter: diagram anchors', () => {
  test.skipIf(!hasDom)('a diagramAnchor row is neither painted, attempted nor unanchored', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const reports: Report[] = [];
    const applyRef: { current: (() => void) | null } = { current: null };
    await act(async () => {
      root.render(<Harness onReport={(r) => reports.push(r)} applyRef={applyRef} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await act(async () => {
      applyRef.current?.();
      await new Promise((r) => setTimeout(r, 30));
    });
    const last = reports[reports.length - 1];
    expect(last).toBeDefined();
    expect(last!.attempted).not.toContain('d1');
    expect(last!.unanchored).not.toContain('d1');
    // The text row went through the pass as usual; the diagram row's label
    // IS in the prose and must not be painted there.
    expect(last!.attempted).toContain('t1');
    expect(host.querySelector('[data-bind-id="d1"], [data-highlight-id="d1"]')).toBeNull();
    expect(host.querySelectorAll('mark').length).toBe(0);
    await act(async () => root.unmount());
    host.remove();
  });
});
