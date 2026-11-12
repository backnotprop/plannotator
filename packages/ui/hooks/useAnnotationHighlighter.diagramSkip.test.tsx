import { describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

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

const IN_DIAGRAM_ONLY: Annotation = { ...TEXT, id: 't2', originalText: 'OnlyInsideTheDiagram' };

const ANNOTATIONS = [DIAGRAM, TEXT, IN_DIAGRAM_ONLY];

const QUOTELESS: Annotation = {
  id: 'd2',
  blockId: '',
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: 'the whole picture is stale',
  originalText: '',
  createdA: 3,
  diagramAnchor: { v: 1, family: 'flowchart', kind: 'diagram', label: '', sourceLine: null },
};

function Harness({ onReport, applyRef, annotations = ANNOTATIONS }: { onReport: (report: Report) => void; applyRef: { current: (() => void) | null }; annotations?: Annotation[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations,
    selectedAnnotationId: null,
    mode: 'comment',
    onAddAnnotation: () => {},
    onRestoreReport: onReport,
  });
  applyRef.current = () => hook.applyAnnotations(annotations);
  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">Should we Approve? the plan</p>
      <div className="annotation-exclude" data-block-id="block-2" data-diagram-block="mermaid">
        <svg>
          <text>OnlyInsideTheDiagram</text>
        </svg>
      </div>
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
    expect(last!.attempted).toContain('t1');
    expect(host.querySelector('[data-bind-id="d1"], [data-highlight-id="d1"]')).toBeNull();
    expect(host.querySelectorAll('mark').length).toBe(0);
    expect(host.querySelector('[data-diagram-block] mark')).toBeNull();
    expect(host.querySelector('svg')!.innerHTML).not.toContain('mark');
    await act(async () => root.unmount());
    host.remove();
  });

  test.skipIf(!hasDom)('a diagram row with no quote and no blockId is skipped, not called unrestorable', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const reports: Report[] = [];
    const applyRef: { current: (() => void) | null } = { current: null };
    const annotations = [QUOTELESS, TEXT];
    await act(async () => {
      root.render(<Harness onReport={(r) => reports.push(r)} applyRef={applyRef} annotations={annotations} />);
    });
    await act(async () => {
      applyRef.current?.();
      await new Promise((r) => setTimeout(r, 30));
    });
    const last = reports[reports.length - 1];
    expect(last).toBeDefined();
    expect(last!.attempted).not.toContain('d2');
    expect(last!.unanchored).not.toContain('d2');
    expect(host.querySelector('[data-bind-id="d2"], [data-highlight-id="d2"]')).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });
});
