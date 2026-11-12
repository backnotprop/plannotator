import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';
import type { ViewerHandle } from './Viewer';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];
const panelMod = hasDom ? await import('./AnnotationPanel') : null;
const AnnotationPanel = panelMod?.AnnotationPanel as typeof import('./AnnotationPanel')['AnnotationPanel'];
const mermaidMod = hasDom ? await import('./MermaidBlock') : null;
const setLoader = mermaidMod?.__setMermaidRuntimeLoaderForTests as
  typeof import('./MermaidBlock')['__setMermaidRuntimeLoaderForTests'];

const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const CAPTURE_ID = 'diagram-fixture';
const SVG = readFileSync(join(FIXTURES, '06-flowchart-review-decision.svg'), 'utf8');
const GEOMETRY = JSON.parse(readFileSync(join(FIXTURES, '06-flowchart-review-decision.geometry.json'), 'utf8')) as {
  elements: Record<string, { bbox: { x: number; y: number; width: number; height: number }; ctm: DOMMatrix }>;
};
const CAPTURED = Object.entries(GEOMETRY.elements).map(([id, entry]) => [id.slice(CAPTURE_ID.length), entry] as const);

const MARKDOWN = [
  '# Plan',
  '',
  'Some prose before the diagram.',
  '',
  '```mermaid',
  'flowchart LR',
  '  U([Reviewer]) --> D{Approve?}',
  '  D -->|Yes| M[(Merge)]',
  '  D -->|No| R[Revise]',
  '```',
  '',
  'Some prose after.',
].join('\n');

const BLOCKS = hasDom ? parseMarkdownToBlocks(MARKDOWN) : [];
const FENCE_ID = hasDom ? (BLOCKS.find((b) => b.type === 'code')?.id ?? '') : '';

const RESTORED: Annotation = {
  id: 'a1',
  blockId: FENCE_ID,
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: 'rename this decision',
  originalText: 'Approve?',
  createdA: 1,
  diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreParser: (() => void) | null = null;
const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const saved = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { x: 0, y: 0, width: 452, height: 182 };
    const found = CAPTURED.find(([suffix]) => this.id.endsWith(suffix));
    if (found === undefined) throw new Error(`no captured geometry for ${this.id}`);
    return { ...found[1].bbox };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return CAPTURED.find(([suffix]) => this.id.endsWith(suffix))?.[1].ctm ?? null;
  };
});

afterAll(() => {
  if (!hasDom) return;
  svgProto['getBBox'] = saved.getBBox;
  svgProto['getScreenCTM'] = saved.getScreenCTM;
  setLoader(undefined);
  restoreParser?.();
});

afterEach(async () => {
  if (root !== null) {
    const finished = root;
    await act(async () => { finished.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

async function settle(ms = 25): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function waitFor(check: () => void, tries = 60): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < tries; i += 1) {
    try { check(); return; } catch (error) { lastError = error; await settle(); }
  }
  throw lastError;
}

function gatedRuntime(): { arrive: () => void; loader: () => Promise<unknown> } {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = {
    initialize: noop,
    render: (id: string) => Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) }),
  };
  return {
    arrive: () => release?.(),
    loader: async () => { await gate; return runtime; },
  };
}

describe.if(hasDom)('Viewer: a diagram comment restored before the diagram mounts', () => {
  test('stays listed and unchipped while the engine is still loading, then gets its badge', async () => {
    const engine = gatedRuntime();
    setLoader(engine.loader as never);
    const reports: AnnotationRestoreReport[] = [];

    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <>
          <Viewer
            blocks={BLOCKS}
            markdown={MARKDOWN}
            annotations={[RESTORED]}
            onAddAnnotation={() => {}}
            onSelectAnnotation={() => {}}
            selectedAnnotationId={null}
            mode="comment"
            taterMode={false}
            disableCodePathValidation
            onRestoreReport={(report) => reports.push(report)}
          />
          <AnnotationPanel
            isOpen
            annotations={[RESTORED]}
            blocks={BLOCKS}
            selectedId={null}
            onSelect={() => {}}
            onDelete={() => {}}
          />
        </>,
      );
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-pending]')).not.toBeNull());
    await settle(60);

    expect(host!.querySelector('[data-diagram-svg] > svg')).toBeNull();
    expect(host!.querySelector(`[data-annotation-panel] [data-annotation-id="${RESTORED.id}"]`)).not.toBeNull();
    expect(reports.flatMap((r) => r.unanchored)).not.toContain(RESTORED.id);

    engine.arrive();
    await waitFor(() => expect(host!.querySelector(`[data-diagram-badge="${RESTORED.id}"]`)).not.toBeNull());
    await waitFor(() => expect(reports.some((r) => r.attempted.includes(RESTORED.id))).toBe(true));

    expect(host!.querySelector(`[data-annotation-panel] [data-annotation-id="${RESTORED.id}"]`)).not.toBeNull();
    expect(reports.flatMap((r) => r.unanchored)).not.toContain(RESTORED.id);
    expect(host!.querySelectorAll('[data-diagram-mark]')).toHaveLength(1);
  });
});

describe.if(hasDom)('Viewer.reopenComment on a diagram part', () => {
  test('asked while the engine is still loading, the diagram opens its composer at the part once drawn, holding the words', async () => {
    const engine = gatedRuntime();
    setLoader(engine.loader as never);
    const added: Annotation[] = [];
    const ref = React.createRef<ViewerHandle>();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <Viewer
          ref={ref}
          blocks={BLOCKS}
          markdown={MARKDOWN}
          annotations={[]}
          onAddAnnotation={(annotation) => { added.push(annotation); }}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="comment"
          taterMode={false}
          disableCodePathValidation
        />,
      );
    });
    let answer: boolean | undefined;
    await act(async () => { answer = ref.current!.reopenComment!({ ...RESTORED, id: 'kept', text: 'Typed before the close' }); });
    expect(answer).toBe(true);
    expect(host!.querySelector('[data-diagram-composer]')).toBeNull();

    engine.arrive();
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer] textarea')).not.toBeNull());
    const area = host!.querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea')!;
    expect(area.value).toBe('Typed before the close');
    expect(added).toHaveLength(0);
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]!.blockId).toBe(FENCE_ID);
    expect(added[0]!.diagramAnchor).toMatchObject({ kind: 'node', id: 'D' });
    expect(added[0]!.text).toBe('Typed before the close');
  });

  test('a fence no longer in the document: onMissing', async () => {
    const ref = React.createRef<ViewerHandle>();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <Viewer ref={ref} blocks={BLOCKS} markdown={MARKDOWN} annotations={[]} onAddAnnotation={() => {}} onSelectAnnotation={() => {}} selectedAnnotationId={null} mode="comment" taterMode={false} disableCodePathValidation />,
      );
    });
    let missing = 0;
    await act(async () => { ref.current!.reopenComment!({ ...RESTORED, blockId: 'goneFence' }, () => { missing += 1; }); });
    expect(missing).toBe(1);
  });
});
