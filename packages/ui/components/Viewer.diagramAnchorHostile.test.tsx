/**
 * A stored annotation whose `diagramAnchor` is not an anchor must never take
 * the document down.
 *
 * `PATCH /api/external-annotations` merged its body verbatim, so any local
 * process could store `{"diagramAnchor": null}` — a value POST refuses — and
 * the diagram block then read `.family` off it: `TypeError: Cannot read
 * properties of null`, thrown during render, the whole page blank. The server
 * validator closes the hole; this is the second layer, because a row can also
 * reach the renderer from a draft, a share link, or a future writer.
 *
 * What regresses if this fails: one malformed row blanks the page instead of
 * listing as an ordinary comment.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in web-highlighter, whose UMD bundle reads `window` at
// module-eval time; import lazily (same pattern as Viewer.diagramLazyRestore).
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

const PROSE_AFTER = 'Some prose after the diagram.';
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
  PROSE_AFTER,
].join('\n');

const BLOCKS = hasDom ? parseMarkdownToBlocks(MARKDOWN) : [];
const FENCE_ID = hasDom ? (BLOCKS.find((b) => b.type === 'code')?.id ?? '') : '';

const row = (id: string, diagramAnchor: unknown): Annotation =>
  ({
    id,
    blockId: FENCE_ID,
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: 'external finding',
    originalText: 'Approve?',
    createdA: 1,
    source: 'linter',
    diagramAnchor,
  }) as unknown as Annotation;

/** Exactly the shapes an unvalidated PATCH could store. `null` is the one
 *  that threw; the rest are inert today and must stay that way. */
const HOSTILE: Annotation[] = [
  row('h-null', null),
  row('h-string', 'nope'),
  row('h-number', 7),
  row('h-empty-object', {}),
  row('h-wrong-v', { v: 2, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] }),
  row('h-unknown-family', { v: 1, family: 'not-a-family', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] }),
];

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
    return found === undefined ? { x: 0, y: 0, width: 0, height: 0 } : { ...found[1].bbox };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return CAPTURED.find(([suffix]) => this.id.endsWith(suffix))?.[1].ctm ?? null;
  };
  setLoader((async () => ({
    initialize: noop,
    render: (id: string) => Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) }),
  })) as never);
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

describe.if(hasDom)('Viewer: an annotation carrying a malformed diagramAnchor', () => {
  test('renders the document and lists the row instead of throwing', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    await act(async () => {
      root = createRoot(host!);
      root.render(
        <>
          <Viewer
            blocks={BLOCKS}
            markdown={MARKDOWN}
            annotations={HOSTILE}
            onAddAnnotation={() => {}}
            onSelectAnnotation={() => {}}
            selectedAnnotationId={null}
            mode="comment"
            taterMode={false}
            disableCodePathValidation
          />
          <AnnotationPanel
            isOpen
            annotations={HOSTILE}
            blocks={BLOCKS}
            selectedId={null}
            onSelect={() => {}}
            onDelete={() => {}}
          />
        </>,
      );
    });
    await settle(80);

    // The document is on screen — the crash blanked it entirely
    // (`document.body.innerText.length === 0`, root with no children).
    expect(host!.textContent).toContain(PROSE_AFTER);
    expect(host!.querySelector('[data-diagram-block]')).not.toBeNull();
    // Every hostile row is still readable in the panel.
    for (const ann of HOSTILE) {
      expect(host!.querySelector(`[data-annotation-panel] [data-annotation-id="${ann.id}"]`)).not.toBeNull();
    }
  });
});
