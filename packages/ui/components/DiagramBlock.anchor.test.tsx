/**
 * The bridge between a comment composed on a diagram part and an annotation
 * on the document: a mermaid fence parsed from real markdown (so the fence's
 * `startLine` is the parser's own), the captured Chromium svg through the
 * host runtime slot, Chromium's geometry for the parts.
 *
 * What regresses if these fail:
 * - the annotation the block mints does not carry `diagramAnchor`, the
 *   fence's `blockId`, the label as `originalText`, or a `sourceLine` that
 *   names the DOCUMENT line (the fence offset lost, so the export and an
 *   agent's grep land on the wrong line);
 * - a stored annotation with a diagram anchor does not restore onto its
 *   node after a reload, or one whose part is gone is not reported through
 *   `onRestoreReport` (so the panel never shows the "Unanchored" chip);
 * - the popout does not open the same viewer at full size, or Escape on the
 *   canvas closes it while a draft is open;
 * - read-only (an archive) still opens a composer.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { AnnotationType, type Annotation, type Block } from '../types';
import { __setMermaidRuntimeLoaderForTests, setMermaidRuntime } from '../utils/mermaid';
import { parseMarkdownToBlocks } from '../utils/parser';
import { MermaidBlock } from './MermaidBlock';

const hasDom = typeof document !== 'undefined';
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
/** `D` is declared on line 7 of the document (1-based). */
const D_DOCUMENT_LINE = 7;

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreParser: (() => void) | null = null;
// happy-dom defines the two geometry methods on SVGGraphicsElement, which
// would shadow a stub on SVGElement; install where the engine defines them.
const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const saved = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setMermaidRuntime(
    { initialize: noop, render: (id: string) => Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) }) } as unknown as Parameters<typeof setMermaidRuntime>[0],
    'host',
  );
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = function (this: Element) {
    const found = CAPTURED.find(([suffix]) => this.id.endsWith(suffix));
    if (found === undefined) throw new Error(`no captured geometry for ${this.id}`);
    return { ...found[1].bbox };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    return CAPTURED.find(([suffix]) => this.id.endsWith(suffix))?.[1].ctm ?? null;
  };
});

afterAll(() => {
  if (!hasDom) return;
  svgProto['getBBox'] = saved.getBBox;
  svgProto['getScreenCTM'] = saved.getScreenCTM;
  __setMermaidRuntimeLoaderForTests(undefined);
  restoreParser?.();
});

afterEach(async () => {
  if (root !== null) {
    const finished = root;
    await act(async () => {
      finished.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
});

function fence(): Block {
  const block = parseMarkdownToBlocks(MARKDOWN).find((b) => b.type === 'code');
  if (block === undefined) throw new Error('no fence');
  return block;
}

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => void, tries = 40): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function pointer(type: string, target: Element): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 1 } : {}) } as MouseEventInit),
  );
}

async function clickNodeD(scope: ParentNode): Promise<void> {
  const node = scope.querySelector('[id$="-flowchart-D-1"]');
  if (node === null) throw new Error('no node D');
  await act(async () => {
    pointer('pointerdown', node);
    pointer('pointerup', node);
  });
}

async function typeAndSubmit(scope: ParentNode, text: string): Promise<void> {
  const textarea = scope.querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea');
  if (textarea === null) throw new Error('no composer');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

describe.if(hasDom)('DiagramBlock: comments become annotations on the document', () => {
  test('a comment on node D is an annotation on the fence with the anchor and the document line', async () => {
    const block = fence();
    expect(block.startLine).toBe(5);
    const added: Annotation[] = [];
    await mount(<MermaidBlock block={block} annotations={[]} onAddAnnotation={(ann) => added.push(ann)} />);
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickNodeD(host!);
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    expect(host!.querySelector('[data-diagram-composer]')!.textContent).toContain(`line ${D_DOCUMENT_LINE}`);
    await typeAndSubmit(host!, 'Rename this step');
    await waitFor(() => expect(added).toHaveLength(1));
    const ann = added[0]!;
    expect(ann.blockId).toBe(block.id);
    expect(ann.type).toBe(AnnotationType.COMMENT);
    expect(ann.text).toBe('Rename this step');
    expect(ann.originalText).toBe('Approve?');
    expect(ann.diagramAnchor).toEqual({ v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [D_DOCUMENT_LINE, D_DOCUMENT_LINE] });
    expect(ann.startMeta).toBeUndefined();
  });

  test('stored annotations restore onto their nodes after a reload, and the gone ones are reported unanchored', async () => {
    const block = fence();
    const reports: AnnotationRestoreReport[] = [];
    const restored: Annotation = {
      id: 'a1',
      blockId: block.id,
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: 'kept',
      originalText: 'Approve?',
      createdA: 1,
      diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] },
    };
    const gone: Annotation = {
      ...restored,
      id: 'a2',
      originalText: 'Nowhere',
      diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'Gone', label: 'Nowhere', sourceLine: null },
    };
    const other: Annotation = { ...restored, id: 'a3', blockId: 'block-other' };
    await mount(<MermaidBlock block={block} annotations={[restored, gone, other]} onRestoreReport={(r) => reports.push(r)} />);
    await waitFor(() => expect(host!.querySelector('[data-diagram-badge="a1"]')).not.toBeNull());
    expect(host!.querySelector('[data-diagram-badge="a2"]')).toBeNull();
    // Another fence's comment is not this block's.
    expect(host!.querySelector('[data-diagram-badge="a3"]')).toBeNull();
    await waitFor(() => expect(reports.length).toBeGreaterThan(0));
    const last = reports[reports.length - 1]!;
    expect([...last.attempted].sort()).toEqual(['a1', 'a2']);
    expect(last.unanchored).toEqual(['a2']);
  });

  test('read-only opens no composer', async () => {
    const block = fence();
    const added: Annotation[] = [];
    await mount(<MermaidBlock block={block} annotations={[]} onAddAnnotation={(ann) => added.push(ann)} readOnly />);
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickNodeD(host!);
    await settle();
    expect(host!.querySelector('[data-diagram-composer]')).toBeNull();
    expect(added).toEqual([]);
  });

  test('the popout is the same viewer at full size; a comment made there lands on the document; Escape walks the draft before the dialog', async () => {
    const block = fence();
    const added: Annotation[] = [];
    await mount(<MermaidBlock block={block} annotations={[]} onAddAnnotation={(ann) => added.push(ann)} />);
    await waitFor(() => expect(host!.querySelector('[data-diagram-expand]')).not.toBeNull());
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-diagram-expand]')!.click();
    });
    await waitFor(() => expect(document.querySelector('[data-diagram-popout]')).not.toBeNull());
    const popout = document.querySelector('[data-diagram-popout]')!;
    await waitFor(() => expect(popout.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    // Two viewers over one fence carry two render ids.
    expect(popout.querySelector('[id$="-flowchart-D-1"]')!.id).not.toBe(host!.querySelector('[id$="-flowchart-D-1"]')!.id);
    await clickNodeD(popout);
    await waitFor(() => expect(popout.querySelector('[data-diagram-composer]')).not.toBeNull());
    await act(async () => {
      popout.querySelector('[data-diagram-composer] textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(popout.querySelector('[data-diagram-composer]')).toBeNull());
    expect(document.querySelector('[data-diagram-popout]')).not.toBeNull();
    await clickNodeD(popout);
    await waitFor(() => expect(popout.querySelector('[data-diagram-composer]')).not.toBeNull());
    await typeAndSubmit(popout, 'from the popout');
    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]!.blockId).toBe(block.id);
    expect(added[0]!.diagramAnchor?.id).toBe('D');
  });
});
