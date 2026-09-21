/**
 * A restored diagram comment must survive the window in which no diagram has
 * mounted yet.
 *
 * Since 0.41.1 `Viewer` reaches `MermaidBlock` / `GraphvizBlock` through
 * `React.lazy`, so on a chunked host the document paints, the draft restores,
 * and only then does the diagram engine arrive. Between those two moments the
 * annotation names a diagram that does not exist in the DOM. Three things
 * must hold across that window, and each of them is a way to lose the comment:
 *
 * - the row stays LISTED (the panel is the only place a comment on a part of
 *   a diagram can be read at all, so dropping it here is data loss);
 * - it is not reported unanchored — `Viewer`'s "this document has no diagram"
 *   report keys on the PARSE, not on what has mounted, or every lazy load
 *   would flash the "Unanchored" chip on a comment that restores fine;
 * - once the engine arrives, the block claims the row and paints its badge,
 *   with no second restore pass and no reload.
 *
 * The engine's arrival is held open here by gating the runtime loader, which
 * is the same pending state the lazy chunk produces one step earlier.
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
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in web-highlighter, whose UMD bundle reads `window` at
// module-eval time; import lazily (same pattern as Viewer.crossBlockRestore).
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

/** The row a draft restore hands back: a comment on node D of the fence. */
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

/** The engine, held until the test lets it arrive. */
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
    // The lazy block chunk has resolved; its engine has not.
    await waitFor(() => expect(host!.querySelector('[data-diagram-pending]')).not.toBeNull());
    await settle(60);

    expect(host!.querySelector('[data-diagram-svg] > svg')).toBeNull();
    // Listed: the panel is the comment's only home until the diagram arrives.
    expect(host!.querySelector(`[data-annotation-panel] [data-annotation-id="${RESTORED.id}"]`)).not.toBeNull();
    // Not chipped: nobody may call it unanchored while no diagram has mounted.
    expect(reports.flatMap((r) => r.unanchored)).not.toContain(RESTORED.id);

    engine.arrive();
    await waitFor(() => expect(host!.querySelector(`[data-diagram-badge="${RESTORED.id}"]`)).not.toBeNull());
    await waitFor(() => expect(reports.some((r) => r.attempted.includes(RESTORED.id))).toBe(true));

    expect(host!.querySelector(`[data-annotation-panel] [data-annotation-id="${RESTORED.id}"]`)).not.toBeNull();
    expect(reports.flatMap((r) => r.unanchored)).not.toContain(RESTORED.id);
    expect(host!.querySelectorAll('[data-diagram-mark]')).toHaveLength(1);
  });
});
